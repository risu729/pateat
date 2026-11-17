// A confirmation page's fill for an authenticated login (ADR 0035 delivery 3) or for the
// person's **Fill** press (amended 2026-11-17), and the submitter destinations every
// passive fill checks before it changes a field.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { recordFillEdits } from "../page/fill-edits";
import { observedPath } from "../observation/path";
import { installLoginContent } from "./content";

type Listener = (
  message: unknown,
  sender: { id: string },
  respond: (value: unknown) => void,
) => boolean | undefined;
const { sent, listeners, authorization } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: [] as Listener[],
  authorization: {
    before: undefined as undefined | (() => Promise<void> | void),
    destination: undefined as undefined | (() => Promise<void>),
    /** The background's answer to the document's announcements, when a test sets one. */
    ready: undefined as undefined | ((message: Record<string, unknown>) => unknown),
  },
}));
vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: (listener: Listener) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
    },
  },
}));
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    if (message["type"] === "login.operation.authorize") {
      await authorization.before?.();
      return true;
    }
    if (message["type"] === "login.destination.check") {
      await authorization.destination?.();
      return { ok: new URL(String(message["destination"])).hostname === location.hostname };
    }
    if (message["type"] === "login.document.ready" && authorization.ready)
      return authorization.ready(message);
    return { ok: false, reason: "stale-document" };
  },
}));
let stop: (() => void) | undefined;
let uninstall: (() => void) | undefined;
let operation = 0;
const key = Symbol.for("pateat.fillEdits");
beforeEach(() => {
  operation = 0;
  sent.length = 0;
  listeners.length = 0;
  authorization.before = undefined;
  authorization.destination = undefined;
  authorization.ready = undefined;
});
afterEach(() => {
  uninstall?.();
  stop?.();
  uninstall = undefined;
  stop = undefined;
  delete (window as unknown as Record<symbol, unknown>)[key];
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function install(html: string, recording = true) {
  document.body.innerHTML = html;
  if (recording) {
    // Browser Mode has already loaded. Represent document_start only while installing
    // the actual recorder; every user edit below comes from Chromium's trusted typing.
    const loading = vi.spyOn(document, "readyState", "get").mockReturnValue("loading");
    stop = recordFillEdits(document, window);
    loading.mockRestore();
  }
  uninstall = installLoginContent();
  await vi.waitFor(() =>
    expect(sent.some((entry) => typeof entry["token"] === "string")).toBe(true),
  );
}
async function fill(
  target: string,
  {
    stepIndex = 0,
    slot = "username",
    value = "fixture@example.com",
    secret = "",
    attemptId = "confirm:authenticated-login",
  } = {},
) {
  const token = sent.find((entry) => typeof entry["token"] === "string")?.["token"];
  let answer: unknown;
  operation += 1;
  const message = {
    version: 1,
    token,
    type: "login.execute",
    operation: {
      version: 1,
      attemptId,
      operationId: `operation-${operation}`,
      policyRevision: 1,
      expiresAt: Date.now() + 60_000,
      document: { origin: self.origin, tabId: 1, frameId: 0, documentId: "document-fill" },
      stepIndex,
      signInFill: true,
      step: {
        kind: "fill",
        effect: "prepare",
        path: observedPath(location.pathname),
        fields: [{ slot, target: { by: "id", value: target } }],
      },
    },
    values: [{ slot, value, ...(secret ? { secret } : {}) }],
  };
  for (const listener of listeners)
    listener(message, { id: "synthetic-extension" }, (reply) => {
      answer = reply;
    });
  await vi.waitFor(() => expect(answer).toBeDefined());
  return answer;
}
const input = (id: string) => document.getElementById(id) as HTMLInputElement;

test("confirmation operations fill an ordinary password without any click, Enter or submit", async () => {
  await install(
    '<form><label>Password<input id="password" type="password" autocomplete="current-password"></label><button id="guarded">Perform guarded action</button></form>',
  );
  const effects = { click: 0, enter: 0, submit: 0 };
  document.querySelector("button")!.addEventListener("click", () => {
    effects.click += 1;
  });
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter") effects.enter += 1;
    },
    { once: true },
  );
  document.querySelector("form")!.addEventListener("submit", (event) => {
    event.preventDefault();
    effects.submit += 1;
  });
  expect(
    await fill("password", {
      slot: "password",
      secret: "password",
      value: "Synthetic-only!",
    }),
  ).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Synthetic-only!");
  expect(effects).toEqual({ click: 0, enter: 0, submit: 0 });
});

test("a confirmation leaves an existing nonempty value untouched", async () => {
  await install(
    '<label>Password<input id="password" type="password" value="Person-chosen-synthetic!"></label>',
  );
  expect(
    await fill("password", {
      slot: "password",
      secret: "password",
      value: "Synthetic-only!",
    }),
  ).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Person-chosen-synthetic!");
});

test("a trusted edit and a replaced confirmation password are never overwritten", async () => {
  await install('<label>Password<input id="password" name="verification" type="password"></label>');
  await userEvent.type(input("password"), "Person-chosen-synthetic!");
  expect(
    await fill("password", {
      slot: "password",
      secret: "password",
    }),
  ).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Person-chosen-synthetic!");
  document.body.innerHTML =
    '<label>Password<input id="replacement" name="verification" type="password"></label>';
  expect(
    await fill("replacement", {
      stepIndex: 2,
      slot: "password",
      secret: "password",
    }),
  ).toMatchObject({ ok: false, mutation: "none", detail: "form-changed" });
  expect(input("replacement").value).toBe("");
});

test("the person's Fill replaces only a value Pateat put in that nobody edited since", async () => {
  await install('<label>Password<input id="password" type="password"></label>');
  const press = (attemptId: string, value: string) =>
    fill("password", { attemptId, slot: "password", secret: "password", value });
  expect(await press("confirm:pick:first", "Synthetic-first!")).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Synthetic-first!");
  // A later press with another account replaces Pateat's own value.
  expect(await press("confirm:pick:second", "Synthetic-second!")).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Synthetic-second!");
  // Once the person edits it, no press replaces it.
  await userEvent.clear(input("password"));
  await userEvent.type(input("password"), "Person-typed-synthetic!");
  expect(await press("confirm:pick:third", "Synthetic-third!")).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Person-typed-synthetic!");
});

test("the person's Fill keeps a value the page set after Pateat's own", async () => {
  await install('<label>Password<input id="password" type="password"></label>');
  const press = (attemptId: string, value: string) =>
    fill("password", { attemptId, slot: "password", secret: "password", value });
  expect(await press("confirm:pick:first", "Synthetic-first!")).toMatchObject({ ok: true });
  // The page's script replaces the value without an event, as a framework's reset may.
  input("password").value = "Page-later-synthetic!";
  expect(await press("confirm:pick:second", "Synthetic-second!")).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Page-later-synthetic!");
});

test.each([
  ["the page put there", '<input id="password" type="password" value="Page-synthetic!">'],
  ["the person typed", '<input id="password" type="password">'],
])("the person's Fill keeps a value %s", async (_case, html) => {
  await install(`<label>Password${html}</label>`);
  if (!input("password").value) await userEvent.type(input("password"), "Person-typed-synthetic!");
  const before = input("password").value;
  expect(
    await fill("password", {
      attemptId: "confirm:pick:press",
      slot: "password",
      secret: "password",
      value: "Synthetic-only!",
    }),
  ).toMatchObject({ ok: true });
  expect(input("password").value).toBe(before);
});

test("a login's confirmation fill never replaces a value the person's Fill put in", async () => {
  await install('<label>Password<input id="password" type="password"></label>');
  await fill("password", {
    attemptId: "confirm:pick:press",
    slot: "password",
    secret: "password",
    value: "Synthetic-picked!",
  });
  expect(
    await fill("password", { slot: "password", secret: "password", value: "Synthetic-login!" }),
  ).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Synthetic-picked!");
});

test.each(['autocomplete="one-time-code"', 'inputmode="numeric" maxlength="6"'])(
  "a confirmation refuses a code-marked password control: %s",
  async (attributes) => {
    await install(
      `<label>Verification code<input id="password" type="password" ${attributes}></label>`,
    );
    expect(
      await fill("password", {
        slot: "password",
        secret: "password",
        value: "Synthetic-only!",
      }),
    ).toMatchObject({ ok: false, mutation: "none" });
    expect(input("password").value).toBe("");
  },
);

test.each([
  {
    name: "hidden default button",
    submitter: '<button hidden formaction="https://foreign.example/collect">Continue</button>',
  },
  {
    name: "externally associated hidden button",
    submitter:
      '</form><button hidden form="guarded-form" formaction="https://foreign.example/collect">Continue</button><form>',
  },
  {
    name: "image submitter",
    submitter:
      '<input type="image" hidden formaction="https://foreign.example/collect" alt="Continue">',
  },
])(
  "confirmation and passive autofill refuse a $name with a foreign destination",
  async ({ submitter }) => {
    await install(
      `<form id="guarded-form" action="${self.origin}/guarded"><label>Password<input id="password" type="password"></label>${submitter}</form>`,
    );
    expect(
      await fill("password", {
        slot: "password",
        secret: "password",
        value: "Synthetic-only!",
      }),
    ).toMatchObject({ ok: false, mutation: "none" });
    expect(input("password").value).toBe("");
  },
);

test.each(["insert", "change"] as const)(
  "a submitter %s during destination authorization cannot receive a confirmation secret",
  async (change) => {
    const allowed = new URL(self.origin);
    allowed.port = String(Number(allowed.port) === 65535 ? 65534 : Number(allowed.port) + 1);
    allowed.pathname = "/item-matched";
    await install(
      `<form id="guarded-form" action="${allowed.href}"><label>Password<input id="password" type="password"></label><button id="submitter">Continue</button></form>`,
    );
    const held = Promise.withResolvers<void>();
    let checks = 0;
    authorization.destination = async () => {
      checks += 1;
      await held.promise;
    };
    const pending = fill("password", {
      slot: "password",
      secret: "password",
      value: "Synthetic-only!",
    });
    await vi.waitFor(() => expect(checks).toBeGreaterThan(0));
    if (change === "insert")
      document.body.insertAdjacentHTML(
        "beforeend",
        '<button hidden form="guarded-form" formaction="https://foreign.example/collect">Other</button>',
      );
    else
      document
        .querySelector("#submitter")!
        .setAttribute("formaction", "https://foreign.example/collect");
    held.resolve();
    expect(await pending).toMatchObject({ ok: false, mutation: "none" });
    expect(input("password").value).toBe("");
  },
);

test("same-origin submitter destinations remain fillable without pressing them", async () => {
  await install(
    `<form id="guarded-form" action="${self.origin}/guarded"><label>Password<input id="password" type="password"></label><button formaction="${self.origin}/same-site">Continue</button></form><input type="image" hidden form="guarded-form" formaction="${self.origin}/same-site-image" alt="Continue">`,
  );
  expect(
    await fill("password", {
      slot: "password",
      secret: "password",
      value: "Synthetic-only!",
    }),
  ).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Synthetic-only!");
});

test("ordinary passive sign-in also refuses a hidden external submitter before changing a field", async () => {
  await install(
    `<form id="guarded-form" action="${self.origin}/guarded"><label>Password<input id="password" type="password"></label><button hidden formaction="https://foreign.example/collect">Continue</button></form>`,
  );
  expect(
    await fill("password", {
      attemptId: "attempt-fill",
      slot: "password",
      secret: "password",
      value: "Synthetic-only!",
    }),
  ).toMatchObject({ ok: false, mutation: "none" });
  expect(input("password").value).toBe("");
});

test("a submitter inserted during the final operation authorization is refused before mutation", async () => {
  await install(
    `<form id="guarded-form" action="${self.origin}/guarded"><label>Password<input id="password" type="password"></label><button>Continue</button></form>`,
  );
  const held = Promise.withResolvers<void>();
  let checks = 0;
  authorization.before = async () => {
    checks += 1;
    if (checks === 2) await held.promise;
  };
  const pending = fill("password", {
    slot: "password",
    secret: "password",
    value: "Synthetic-only!",
  });
  await vi.waitFor(() => expect(checks).toBe(2));
  document.body.insertAdjacentHTML(
    "beforeend",
    '<button hidden form="guarded-form" formaction="https://foreign.example/collect">Other</button>',
  );
  held.resolve();
  expect(await pending).toMatchObject({ ok: false, mutation: "none" });
  expect(input("password").value).toBe("");
});

test("a confirmation keeps a prefilled username that a sign-in fill replaces", async () => {
  await install(
    '<label>Username<input id="username" type="email" value="site@example.com"></label>',
  );
  expect(await fill("username")).toMatchObject({ ok: true });
  expect(input("username").value).toBe("site@example.com");
  expect(await fill("username", { attemptId: "attempt-fill", stepIndex: 1 })).toMatchObject({
    ok: true,
  });
  expect(input("username").value).toBe("fixture@example.com");
});

test.each(["attempt-fill", "confirm:authenticated-login"])(
  "a same-origin button the page renders on input does not stop a passive fill (%s)",
  async (attemptId) => {
    await install(
      `<form action="${self.origin}/signin"><label>Password<input id="password" type="password"></label><span id="slot"></span><button type="submit">Sign in</button></form>`,
    );
    // A show-password button without a type, so a submit button, as sites render on input.
    input("password").addEventListener("input", () => {
      if (!document.getElementById("reveal"))
        document
          .getElementById("slot")!
          .insertAdjacentHTML("beforeend", '<button id="reveal">Show</button>');
    });
    const answer = await fill("password", {
      attemptId,
      slot: "password",
      secret: "password",
      value: "Synthetic-only!",
    });
    expect({ answer, value: input("password").value }).toMatchObject({
      answer: { ok: true },
      value: "Synthetic-only!",
    });
  },
);

test.each(["attempt-fill", "confirm:authenticated-login"])(
  "a foreign submitter the page renders on input stops a passive fill and takes its value out (%s)",
  async (attemptId) => {
    await install(
      `<form action="${self.origin}/signin"><label>Password<input id="password" type="password"></label><span id="slot"></span></form>`,
    );
    // What the page's own state holds, as a framework's input handler keeps it.
    let seen = "";
    input("password").addEventListener("input", () => {
      seen = input("password").value;
      if (!document.getElementById("other"))
        document
          .getElementById("slot")!
          .insertAdjacentHTML(
            "beforeend",
            '<button id="other" formaction="https://foreign.example/collect">Go</button>',
          );
    });
    expect(
      await fill("password", {
        attemptId,
        slot: "password",
        secret: "password",
        value: "Synthetic-only!",
      }),
    ).toMatchObject({ ok: false, detail: "form-changed" });
    // No part of the password stays where Enter or the new button would send it (ADR 0051).
    expect({ value: input("password").value, seen }).toEqual({ value: "", seen: "" });
  },
);

test("a sign-in fill stopped by a foreign submitter gives the input back the page's value", async () => {
  await install(
    `<form action="${self.origin}/signin"><label>Username<input id="username" type="email" value="site@example.com"></label><span id="slot"></span></form>`,
  );
  input("username").addEventListener("input", () => {
    if (!document.getElementById("other"))
      document
        .getElementById("slot")!
        .insertAdjacentHTML(
          "beforeend",
          '<button id="other" formaction="https://foreign.example/collect">Go</button>',
        );
  });
  expect(await fill("username", { attemptId: "attempt-fill" })).toMatchObject({
    ok: false,
    detail: "form-changed",
  });
  expect(input("username").value).toBe("site@example.com");
});

test("a verification page answered with the origin's starts reports its first step shown", async () => {
  const path = observedPath(location.pathname);
  const first = { path, require: "writable", targets: [{ by: "id", value: "password" }] };
  authorization.ready = (message) =>
    message["shown"]
      ? { ok: false, reason: "confirm-fill" }
      : { ok: false, reason: "confirm-fill", starts: [], confirm: first };
  await install('<label>Password<input id="password" type="password"></label>');
  // The answer named the page's first step, which shows: the document reports it, and the
  // background logs the page for evaluation only with that report (ADR 0035).
  await vi.waitFor(() =>
    expect(sent.filter((entry) => entry["shown"])).toEqual([
      expect.objectContaining({ shown: expect.objectContaining({ path }) }),
    ]),
  );
});

test("a page whose classification runs keeps watching the origin's starts in place", async () => {
  const path = observedPath(location.pathname);
  authorization.ready = (message) =>
    message["start"]
      ? { ok: false, reason: "logged-in" }
      : {
          ok: false,
          reason: "generating",
          starts: [{ path, require: "writable", targets: [{ by: "id", value: "password" }] }],
        };
  await install("<main></main>");
  // A sign-in form the page shows in place is announced, as after a logout (ADR 0062).
  document.body.insertAdjacentHTML(
    "beforeend",
    '<label>Password<input id="password" type="password"></label>',
  );
  await vi.waitFor(() =>
    expect(sent.filter((entry) => entry["start"])).toEqual([
      expect.objectContaining({ start: { path } }),
    ]),
  );
});
