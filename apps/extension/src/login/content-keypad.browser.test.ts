import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";

const { sent, replies } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  replies: [] as ((message: Record<string, unknown>) => unknown)[],
}));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    },
  },
}));
// The background answers each announcement with the next queued reply.
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    return (replies.shift() ?? (() => ({ ok: false, reason: "generating" })))(message);
  },
}));

const start = location.pathname;
let uninstall: (() => void) | undefined;
beforeEach(() => {
  sent.length = 0;
  replies.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
  history.replaceState(null, "", start);
});

const keys = [..."0123456789"].map((digit) => `<button type="button">${digit}</button>`).join("");
/** A PIN page whose read-only input takes its digits from `#pad`, or with no keypad. */
const pinPage = (keypad = true) =>
  `<main><form><label>PIN <input id="pin" type="password" readonly></label>${keypad ? `<div id="pad">${keys}</div>` : ""}<button id="go" type="button">Sign in</button></form></main>`;
/** The announcements that reported a ready step, by path. */
const announced = () =>
  sent.flatMap((message) =>
    message["start"] ? [(message["start"] as { path: string }).path] : [],
  );
/** The announcements that offered the page for generation as a sign-in page. */
const offered = () => sent.filter((message) => message["signIn"] !== undefined);

describe("a read-only field entered on the page's software keyboard (ADR 0067)", () => {
  it("is ready only for a step that names it as entered on a keypad", async () => {
    history.replaceState(null, "", "/pin");
    const target = { by: "id", value: "pin" };
    const step = { path: "/pin", require: "writable", targets: [target] };
    for (const [keypad, ready] of [
      [[target], true],
      [undefined, false],
    ] as const) {
      sent.length = 0;
      document.body.innerHTML = pinPage();
      replies.push(() => ({
        ok: false,
        reason: "form-not-ready",
        starts: [{ ...step, ...(keypad ? { keypad } : {}) }],
      }));
      uninstall = installLoginContent();
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(300);
      expect(announced(), String(ready)).toEqual(ready ? ["/pin"] : []);
      uninstall();
      uninstall = undefined;
    }
  });

  it("makes a page without a recipe a sign-in page only beside a keypad", async () => {
    for (const keypad of [true, false]) {
      sent.length = 0;
      document.body.innerHTML = pinPage(keypad);
      replies.push(() => ({ ok: false, reason: "recipe-not-found", starts: [], generate: true }));
      uninstall = installLoginContent();
      // eslint-disable-next-line no-await-in-loop
      await vi.advanceTimersByTimeAsync(300);
      expect(offered(), String(keypad)).toEqual(
        keypad ? [expect.objectContaining({ signIn: { path: expect.any(String) } })] : [],
      );
      uninstall();
      uninstall = undefined;
    }
  });
});
