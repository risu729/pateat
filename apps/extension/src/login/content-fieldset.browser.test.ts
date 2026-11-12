import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observedPath } from "../observation/path";
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
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
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
  vi.clearAllTimers();
  vi.useRealTimers();
  document.body.innerHTML = "";
});
const id = (value: string) => ({ by: "id" as const, value });
const path = () => observedPath(location.pathname);
async function install(html: string) {
  document.body.innerHTML = html;
  uninstall = installLoginContent();
  await vi.advanceTimersByTimeAsync(200);
}
function send(message: Record<string, unknown>) {
  const reply: { value?: unknown } = {};
  const token = sent.find((entry) => typeof entry["token"] === "string")?.["token"];
  for (const listener of listeners)
    listener({ version: 1, token, ...message }, { id: "synthetic-extension" }, (value) => {
      reply.value = value;
    });
  return reply;
}
async function answer(reply: { value?: unknown }) {
  for (let tick = 0; tick < 120 && reply.value === undefined; tick += 1)
    // oxlint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(50);
  expect(reply.value).toBeDefined();
  return reply.value;
}
function fill() {
  return send({
    type: "login.execute",
    operation: {
      version: 1,
      attemptId: "synthetic-attempt",
      operationId: crypto.randomUUID(),
      policyRevision: 1,
      expiresAt: Date.now() + 60_000,
      document: { origin: self.origin, tabId: 1, frameId: 0, documentId: "synthetic-document" },
      stepIndex: 0,
      step: {
        kind: "fill",
        effect: "prepare",
        path: path(),
        fields: [{ slot: "password", target: id("pw") }],
      },
    },
    values: [{ slot: "password", value: "synthetic", secret: "password" }],
  });
}
const controls =
  '<input id="pw" type="password"><input id="pin" type="password" readonly><button id="go" type="button">Continue</button>';

describe("a login step waiting for its fieldset to be enabled", () => {
  it.each(["input", "keypad", "button"])(
    "keeps the %s unready until its fieldset enables it",
    async (kind) => {
      await install(`<form><fieldset disabled>${controls}</fieldset></form>`);
      const target = id(kind === "button" ? "go" : kind === "keypad" ? "pin" : "pw");
      const reply = send({
        type: "login.await",
        timeoutMs: 5_000,
        readiness: {
          path: path(),
          require: kind === "button" ? "clickable" : "writable",
          targets: [target],
          ...(kind === "keypad" ? { keypad: [target] } : {}),
        },
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(reply.value).toBeUndefined();
      document.querySelector("fieldset")!.disabled = false;
      await vi.advanceTimersByTimeAsync(20);
      expect(reply.value).toEqual({ ok: true });
    },
  );

  it("refuses a disabled fieldset before any value or typing event reaches its field", async () => {
    await install(`<form><fieldset disabled>${controls}</fieldset></form>`);
    const input = document.querySelector<HTMLInputElement>("#pw")!;
    const typed = vi.fn();
    for (const type of ["keydown", "beforeinput", "input", "change"])
      input.addEventListener(type, typed);
    expect(await answer(fill())).toMatchObject({
      ok: false,
      reason: "structural-mismatch",
      detail: "target-missing",
      mutation: "none",
    });
    expect(input.value).toBe("");
    expect(typed).not.toHaveBeenCalled();
  });

  it("stops after the first character when the page disables its fieldset during typing", async () => {
    await install(`<form><fieldset>${controls}</fieldset></form>`);
    const input = document.querySelector<HTMLInputElement>("#pw")!;
    const characters: string[] = [];
    const changed = vi.fn();
    input.addEventListener("input", () => {
      characters.push(input.value);
      document.querySelector("fieldset")!.disabled = true;
    });
    input.addEventListener("change", changed);
    expect(await answer(fill())).toMatchObject({
      ok: false,
      reason: "cancelled",
      detail: "field-changed",
      mutation: "possible",
    });
    expect(input.value).toBe("s");
    expect(characters).toEqual(["s"]);
    expect(changed).not.toHaveBeenCalled();
  });

  it("still fills a control in the disabled fieldset's first legend", async () => {
    await install(`<form><fieldset disabled><legend>${controls}</legend></fieldset></form>`);
    expect(await answer(fill())).toMatchObject({ ok: true });
    expect(document.querySelector<HTMLInputElement>("#pw")!.value).toBe("synthetic");
  });
});
