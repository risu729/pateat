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
// The background refuses each announcement, so no login runs by itself.
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    return { ok: false, reason: "stale-document" };
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

/** Shows `html` on `/login` and installs the content script; returns its token. */
async function open(html: string): Promise<string> {
  history.replaceState(null, "", "/login");
  document.body.innerHTML = html;
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

const page = `<main><form><input type="email" id="email" name="email">
  <button type="submit" disabled>Log In</button>
  <button type="button">Help</button><button type="button">Help</button></form></main>`;
const wait = (token: string, readiness: Record<string, unknown>) =>
  command({ version: 1, type: "login.await", token, readiness, timeoutMs: 200 });

describe("a step's wait that runs out (#1139)", () => {
  it("says which check still failed, never a value", async () => {
    const token = await open(page);
    const click = (value: string, path = "/login") =>
      wait(token, { path, require: "clickable", targets: [{ by: "text", value }] });
    // A disabled button, a missing one, two that match and another path.
    expect(await click("Log In")).toEqual({ ok: false, reason: "timeout", miss: "not-clickable" });
    expect(await click("Sign in")).toEqual({ ok: false, reason: "timeout", miss: "missing" });
    expect(await click("Help")).toEqual({ ok: false, reason: "timeout", miss: "matches-2" });
    expect(await click("Log In", "/signin")).toEqual({
      ok: false,
      reason: "timeout",
      miss: "path",
    });
    // A fill step's input that shows is ready; the first target that is not names the miss.
    expect(
      await wait(token, {
        path: "/login",
        require: "writable",
        targets: [
          { by: "id", value: "email" },
          { by: "name", value: "password" },
        ],
      }),
    ).toEqual({ ok: false, reason: "timeout", miss: "missing" });
    expect(
      await wait(token, {
        path: "/login",
        require: "writable",
        targets: [{ by: "id", value: "email" }],
      }),
    ).toEqual({ ok: true });
  });
});
