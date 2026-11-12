import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { recordFillEdits, fillEditsReady, fillUntouched } from "../page/fill-edits";
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
    attemptId = "attempt-fill",
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

test("trusted typing before fill protects both the edited field and its replacement", async () => {
  await install('<label>Username<input id="username" name="username" type="email"></label>');
  const trusted: boolean[] = [];
  input("username").addEventListener("input", (event) => trusted.push(event.isTrusted));
  await userEvent.type(input("username"), "person@example.com");
  expect(trusted.length).toBeGreaterThan(0);
  expect(trusted.every(Boolean)).toBe(true);
  expect(await fill("username")).toMatchObject({ ok: true });
  expect(input("username").value).toBe("person@example.com");
  document.body.innerHTML =
    '<label>Username<input id="replacement" name="username" type="email"></label>';
  expect(await fill("replacement", { stepIndex: 2 })).toMatchObject({
    ok: false,
    reason: "structural-mismatch",
    detail: "form-changed",
    mutation: "none",
  });
  expect(input("replacement").value).toBe("");
});

test("a replacement with no shared name remains protected by its logical input kind", async () => {
  await install('<label>Username<input id="username" type="email"></label>');
  await userEvent.type(input("username"), "person@example.com");
  document.body.innerHTML = '<label>Username<input id="fresh" type="email"></label>';
  expect(await fill("fresh")).toMatchObject({
    ok: false,
    reason: "structural-mismatch",
    detail: "form-changed",
    mutation: "none",
  });
  expect(input("fresh").value).toBe("");
});

test("editing the username does not prevent a later password step from filling", async () => {
  await install(
    '<label>Username<input id="username" type="email" autocomplete="username"></label>',
  );
  await userEvent.type(input("username"), "person@example.com");
  document.body.innerHTML =
    '<label>Password<input id="password" type="password" autocomplete="current-password"></label>';
  expect(fillUntouched(window, input("password"))).toBe(true);
  expect(
    await fill("password", {
      stepIndex: 2,
      slot: "password",
      secret: "password",
      value: "Synthetic-only!",
    }),
  ).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Synthetic-only!");
});

test.each(["missing", "late"] as const)(
  "a %s document-start recording refuses all filling",
  async (recording) => {
    await install('<label>Username<input id="username" type="email"></label>', false);
    if (recording === "late") stop = recordFillEdits(document, window);
    expect(fillEditsReady(window)).toBe(false);
    expect(await fill("username")).toMatchObject({
      ok: false,
      reason: "cancelled",
      detail: "document-cancelled",
    });
    expect(input("username").value).toBe("");
  },
);

test("a lost fill acknowledgement and content reconnect never repeat the claimed field", async () => {
  await install('<label>Username<input id="username" type="email"></label>');
  let writes = 0;
  input("username").addEventListener("input", () => {
    writes += 1;
  });
  expect(await fill("username")).toMatchObject({ ok: true });
  expect(input("username").value).toBe("fixture@example.com");
  const initialWrites = writes;
  expect(initialWrites).toBeGreaterThan(0);
  // The page clears the input after the worker loses its acknowledgement. Reissuing
  // with a new operation ID must not treat this as an untouched slot to fill again.
  input("username").value = "";
  expect(await fill("username")).toMatchObject({
    ok: false,
    reason: "structural-mismatch",
    detail: "form-changed",
    mutation: "none",
  });
  expect(input("username").value).toBe("");
  expect(writes).toBe(initialWrites);
  uninstall?.();
  sent.length = 0;
  uninstall = installLoginContent();
  await vi.waitFor(() =>
    expect(sent.some((entry) => typeof entry["token"] === "string")).toBe(true),
  );
  expect(await fill("username")).toMatchObject({
    ok: false,
    reason: "structural-mismatch",
    detail: "form-changed",
    mutation: "none",
  });
  expect(input("username").value).toBe("");
  expect(writes).toBe(initialWrites);
});

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
      attemptId: "confirm:authenticated-login",
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
      attemptId: "confirm:authenticated-login",
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
      attemptId: "confirm:authenticated-login",
      slot: "password",
      secret: "password",
    }),
  ).toMatchObject({ ok: true });
  expect(input("password").value).toBe("Person-chosen-synthetic!");
  document.body.innerHTML =
    '<label>Password<input id="replacement" name="verification" type="password"></label>';
  expect(
    await fill("replacement", {
      attemptId: "confirm:authenticated-login",
      stepIndex: 2,
      slot: "password",
      secret: "password",
    }),
  ).toMatchObject({ ok: false, mutation: "none", detail: "form-changed" });
  expect(input("replacement").value).toBe("");
});

test.each(['autocomplete="one-time-code"', 'inputmode="numeric" maxlength="6"'])(
  "a confirmation refuses a code-marked password control: %s",
  async (attributes) => {
    await install(
      `<label>Verification code<input id="password" type="password" ${attributes}></label>`,
    );
    expect(
      await fill("password", {
        attemptId: "confirm:authenticated-login",
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
        attemptId: "confirm:authenticated-login",
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
      attemptId: "confirm:authenticated-login",
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
      attemptId: "confirm:authenticated-login",
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
    attemptId: "confirm:authenticated-login",
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
