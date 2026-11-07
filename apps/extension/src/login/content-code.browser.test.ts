import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observedPath } from "../observation/path";
import { installLoginContent } from "./content";

// A `totp` handler's code fill into the code inputs the judge names (ADR 0027 amendment of
// 2026-11-07): Epic Games' six inputs without `maxlength`, HCP Cloud's one numeric input
// without `maxlength`, and a split the page's description would not show whole. Synthetic
// pages and values only.
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
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    // The background authorizes every operation of a login's synthetic steps.
    if (message["type"] === "login.operation.authorize") return true;
    return { ok: false, reason: "stale-document" };
  },
}));

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
});

/** Sends `message` to the content script and waits for its answer. */
async function ask(message: Record<string, unknown>) {
  const token = sent.find((entry) => typeof entry["token"] === "string")?.["token"];
  const answer: { value?: unknown } = {};
  for (const listener of listeners)
    listener({ version: 1, token, ...message }, { id: "synthetic-extension" }, (value) => {
      answer.value = value;
    });
  for (let tick = 0; tick < 100 && answer.value === undefined; tick += 1)
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(100);
  return answer.value;
}
const id = (value: string) => ({ by: "id" as const, value });
let operations = 0;
/** The page's answer to a `totp` handler's code fill into `field`, submitted by `#go`. */
async function fillCode(field: string, code = "123456"): Promise<unknown> {
  operations += 1;
  const answer = await ask({
    type: "login.execute",
    operation: {
      version: 1,
      attemptId: "attempt-code",
      operationId: `operation-${operations}`,
      policyRevision: 1,
      expiresAt: Date.now() + 60_000,
      document: { origin: self.origin, tabId: 1, frameId: 0, documentId: "document-code" },
      stepIndex: 0,
      step: {
        kind: "fill",
        effect: "prepare",
        path: observedPath(location.pathname),
        fields: [{ slot: "totp", target: id(field) }],
      },
    },
    values: [{ slot: "totp", value: code, secret: "otp" }],
    code: { submit: id("go") },
  });
  if (typeof answer !== "object" || answer === null) return answer;
  const {
    operationId: _operation,
    documentId: _document,
    ...rest
  } = answer as Record<string, unknown>;
  return rest;
}
async function install(page: string) {
  document.body.innerHTML = page;
  uninstall?.();
  listeners.length = 0;
  sent.length = 0;
  uninstall = installLoginContent();
  await vi.advanceTimersByTimeAsync(200);
}
const values = () =>
  [...document.querySelectorAll<HTMLInputElement>("input[data-digit]")].map((input) => input.value);
const digits = (attributes: string) =>
  Array.from(
    { length: 6 },
    (_, at) =>
      `<input id="d${at}" data-digit name="code-input-${at}" type="text" inputmode="numeric" ${attributes}>`,
  ).join("");
const button = '<button id="go" type="button" disabled>Continue</button>';

describe("a totp handler's code (ADR 0027 amendment of 2026-11-07)", () => {
  it("types one digit into each of six inputs without maxlength, as on Epic Games", async () => {
    await install(`<form>${digits('autocomplete="one-time-code"')}${button}</form>`);
    await fillCode("d0");
    expect(values()).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("types one digit into number inputs whose first alone declares maxlength 1", async () => {
    // The description leaves a number input's length out, so the service reads them as a
    // split without maxlength.
    const numbers = Array.from(
      { length: 6 },
      (_, at) =>
        `<input id="d${at}" data-digit type="number" ${at === 0 ? 'maxlength="1" autocomplete="one-time-code"' : ""}>`,
    ).join("");
    await install(`<form>${numbers}${button}</form>`);
    await fillCode("d0");
    expect(values()).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("types the whole code into one numeric input without maxlength, as on HCP Cloud", async () => {
    await install(
      `<form><input id="code" type="text" inputmode="numeric" autocomplete="off">${button}</form>`,
    );
    await fillCode("code");
    expect((document.getElementById("code") as HTMLInputElement).value).toBe("123456");
  });

  it.each([
    ["a text input", '<input id="site" type="text" aria-hidden="true">'],
    ["a numeric one", '<input id="site" type="tel" aria-hidden="true">'],
    [
      "one moved off the screen",
      '<input id="site" type="text" style="position:absolute;left:-9999px">',
    ],
    ["a transparent one", '<input id="site" type="text" style="opacity:0">'],
    [
      "a tiny one",
      '<input id="site" type="tel" maxlength="1" style="box-sizing:border-box;width:1px;height:1px;padding:0;border:0">',
    ],
  ])("leaves out %s hidden as the description leaves it out", async (_label, decoy) => {
    // A honeypot, or a field for SMS autofill, that the service never saw.
    await install(`<form>${decoy}${digits('autocomplete="one-time-code"')}${button}</form>`);
    await fillCode("d0");
    expect(values()).toEqual(["1", "2", "3", "4", "5", "6"]);
    expect((document.getElementById("site") as HTMLInputElement).value).toBe("");
  });

  it("never types a code of another length whole into the first digit input", async () => {
    await install(`<form>${digits('autocomplete="one-time-code"')}${button}</form>`);
    expect(await fillCode("d0", "1234567")).toMatchObject({ ok: false, reason: "value-mismatch" });
    expect(values()).toEqual(["", "", "", "", "", ""]);
  });

  it("never types the code whole into the first of digits beside another field", async () => {
    await install(
      `<form><input id="mail" type="email">${digits('autocomplete="one-time-code"')}${button}</form>`,
    );
    expect(await fillCode("d0")).toMatchObject({ ok: false, reason: "value-mismatch" });
    expect(values()).toEqual(["", "", "", "", "", ""]);
  });

  it("still types a code whole into a lone code input beside other fields", async () => {
    await install(
      `<form><input id="code" type="text" autocomplete="one-time-code"><input type="email"><input type="tel">${button}</form>`,
    );
    await fillCode("code");
    expect((document.getElementById("code") as HTMLInputElement).value).toBe("123456");
  });
});
