import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";

type Listener = (
  message: unknown,
  sender: { id: string },
  respond: (value: unknown) => void,
) => boolean | undefined;
const { sent, listeners } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: [] as Listener[],
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
async function open(): Promise<string> {
  history.replaceState(null, "", "/confirm");
  document.body.innerHTML = choicePage;
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
  const fill = (token: string, overrides: Record<string, unknown> = {}) =>
    command({
      version: 1,
      type: "login.detail.fill",
      token,
      path: "/confirm",
      target: target("phone"),
      value: "1234",
      ...overrides,
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
            token: "another-token",
            path: "/confirm",
            target: target("phone"),
            value: "1234",
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
