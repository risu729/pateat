import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";

type Listener = (
  message: unknown,
  sender: { id: string },
  respond: (value: unknown) => void,
) => boolean | undefined;
const { sent, listeners, replies } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: [] as Listener[],
  replies: [] as ((message: Record<string, unknown>) => unknown)[],
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
// The background answers each announcement with the next queued reply.
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    return (replies.shift() ?? (() => ({ ok: false, reason: "stale-document" })))(message);
  },
}));

const start = location.pathname;
let uninstall: (() => void) | undefined;
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
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

const starts = [
  { path: "/signin", require: "writable", targets: [{ by: "name", value: "email" }] },
  {
    path: "/signin/password",
    require: "writable",
    targets: [{ by: "name", value: "password" }],
    later: true,
  },
];
const refused = () => ({ ok: false, reason: "form-not-ready", starts });
const emailPage = `<main><form><label>Email <input type="email" name="email"></label>
  <button type="submit">Continue with email</button></form></main>`;
const passwordPage = `<main><form><label>Email <input type="text" name="email" readonly
  value="me@example.com"></label><label>Password <input type="password" name="password"
  autocomplete="current-password"></label><button type="submit">Sign in</button></form></main>`;
/** The announcements that reported a ready step, by path. */
const announced = () =>
  sent.flatMap((message) =>
    message["start"] ? [(message["start"] as { path: string }).path] : [],
  );

describe("a single-page sign-in that shows its next step in place (ADR 0049)", () => {
  it("announces the later step once the same document moves to its path", async () => {
    history.replaceState(null, "", "/signin");
    document.body.innerHTML = emailPage;
    // The first announcement learns the starts; the email step's login then runs and ends,
    // as a login stopped there does, and the page announces again with no start.
    replies.push(refused, () => ({ ok: true }), refused);
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    expect(announced()).toEqual(["/signin"]);
    const token = sent[0]!["token"];
    for (const listener of listeners)
      listener(
        { version: 1, type: "login.status", token, state: "blocked", stepIndex: 1 },
        { id: "synthetic-extension" },
        () => undefined,
      );
    await vi.advanceTimersByTimeAsync(200);
    expect(sent).toHaveLength(3);
    // The person presses the button; the app renders the password step in one change.
    history.pushState(null, "", "/signin/password");
    document.body.innerHTML = passwordPage;
    await vi.advanceTimersByTimeAsync(300);
    expect(announced()).toEqual(["/signin", "/signin/password"]);
  });

  it("does not announce the same step again while it stays on its path", async () => {
    history.replaceState(null, "", "/signin/password");
    document.body.innerHTML = passwordPage;
    // The first announcement learns the starts; a watched login's reply to the step's
    // announcement keeps the page watching with the step announced.
    replies.push(refused, () => ({ ok: true, starts }));
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(200);
    expect(announced()).toEqual(["/signin/password"]);
    document.querySelector("label")!.append(" ");
    await vi.advanceTimersByTimeAsync(300);
    expect(announced()).toEqual(["/signin/password"]);
  });
});
