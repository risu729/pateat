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
    if (message["type"] === "login.destination.check") return { ok: true };
    return message["type"] === "login.operation.authorize"
      ? true
      : { ok: false, reason: "stale-document" };
  },
}));

let uninstall: (() => void) | undefined;
let operations = 0;
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
  operations = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

const password = { by: "id" as const, value: "password" };
const signIn = { by: "password-form-text" as const, value: "Sign in" };
async function execute(kind: "fill" | "click") {
  const token = sent.find((message) => typeof message["token"] === "string")?.["token"];
  const path = observedPath(location.pathname);
  const operationId = `operation-form-text-${++operations}`;
  const message = {
    version: 1,
    type: "login.execute",
    token,
    operation: {
      version: 1,
      attemptId: "attempt-form-text",
      operationId,
      policyRevision: 1,
      expiresAt: Date.now() + 60_000,
      document: { origin: self.origin, tabId: 1, frameId: 0, documentId: "document-form-text" },
      stepIndex: kind === "fill" ? 0 : 1,
      step:
        kind === "fill"
          ? { kind, effect: "prepare", path, fields: [{ slot: "password", target: password }] }
          : { kind, path, target: signIn, purpose: "submit" },
    },
    values: kind === "fill" ? [{ slot: "password", value: "synthetic-secret" }] : [],
  };
  const answer: { value?: unknown } = {};
  for (const listener of listeners)
    listener(message, { id: "synthetic-extension" }, (value) => (answer.value = value));
  for (let tick = 0; tick < 100 && answer.value === undefined; tick += 1)
    // eslint-disable-next-line no-await-in-loop
    await vi.advanceTimersByTimeAsync(100);
  expect(answer.value).toMatchObject({ operationId, documentId: "document-form-text" });
  return answer.value;
}

/** A site header's "Sign in" button beside the sign-in form's own (United, #1684). */
async function page(more = "") {
  document.body.innerHTML = `<header><nav><button type="button" id="loginButton"
    aria-label="Sign in">Sign in</button></nav></header>
    <form id="login"><input id="password" type="password"><button type="submit">Sign in</button></form>
    ${more}`;
  const header = vi.fn();
  document.querySelector("#loginButton")!.addEventListener("click", header);
  const submitted = vi.fn((event: SubmitEvent) => event.preventDefault());
  for (const form of document.querySelectorAll("form")) form.addEventListener("submit", submitted);
  uninstall = installLoginContent();
  await vi.advanceTimersByTimeAsync(200);
  expect(await execute("fill")).toMatchObject({ ok: true, mutation: "possible" });
  return { header, submitted };
}

describe("a click on a button named by its text within the sign-in form", () => {
  it("presses the sign-in form's button, never the header's", async () => {
    const { header, submitted } = await page();
    expect(await execute("click")).toMatchObject({ ok: true, mutation: "possible" });
    expect(submitted).toHaveBeenCalledOnce();
    expect(submitted.mock.calls[0]![0].target).toBe(document.querySelector("#login"));
    expect(header).not.toHaveBeenCalled();
  });

  it("presses nothing when a second sign-in form shows the text too", async () => {
    const { header, submitted } = await page(
      `<form><input type="password"><button type="submit">Sign in</button></form>`,
    );
    expect(await execute("click")).toMatchObject({
      ok: false,
      reason: "structural-mismatch",
      mutation: "none",
    });
    expect(submitted).not.toHaveBeenCalled();
    expect(header).not.toHaveBeenCalled();
  });
});
