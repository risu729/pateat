import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";
import { LOGIN_STEP_WAIT_MS } from "./wire";

type Listener = (
  message: unknown,
  sender: { id: string },
  respond: (value: unknown) => void,
) => boolean | undefined;
const { sent, listeners, next, signInReply } = vi.hoisted(() => ({
  sent: [] as Record<string, unknown>[],
  listeners: [] as Listener[],
  // Answers for the next plain announcements, before the usual one.
  next: [] as (Record<string, unknown> | Promise<Record<string, unknown>>)[],
  // The answer to an announced sign-in.
  signInReply: { current: { ok: false, reason: "generating" } as Record<string, unknown> },
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
// The background answers each plain announcement that the page may be sent for a recipe,
// and an announced sign-in that it is being sent.
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    if (message["signIn"]) return signInReply.current;
    if (message["unoffered"]) return { ok: true };
    const queued = next.shift();
    if (queued) return queued;
    return { ok: false, reason: "recipe-not-found", starts: [], generate: true };
  },
}));

const start = location.pathname;
let uninstall: (() => void) | undefined;
beforeEach(() => {
  sent.length = 0;
  listeners.length = 0;
  next.length = 0;
  signInReply.current = { ok: false, reason: "generating" };
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
  history.replaceState(null, "", start);
});

// Discord's /login on 2026-11-04: its own list of remembered accounts, and after "Add an
// account" its email and password form in place, with no URL change.
const accountList = `<main><h1>Choose an account</h1><ul><li>Remembered account</li></ul>
  <button type="button">Add an account</button></main>`;
const form = `<main><h1>Welcome back!</h1><form><label>Email or Phone Number
  <input name="email" autocomplete="username"></label><label>Password
  <input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Log In</button></form></main>`;
const offers = () => sent.filter((message) => message["signIn"]);
const reconnect = async (message: Record<string, unknown>, token?: unknown) => {
  for (const listener of listeners)
    listener(
      token ? { ...message, token } : message,
      { id: "synthetic-extension" },
      () => undefined,
    );
  await vi.advanceTimersByTimeAsync(200);
};

describe("a form shown in place after the page's window to be sent closed", () => {
  const formShownLate = async () => {
    document.body.innerHTML = accountList;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(LOGIN_STEP_WAIT_MS + 500);
    expect(offers()).toEqual([]);
    document.body.innerHTML = form;
    await vi.advanceTimersByTimeAsync(1000);
  };
  const offer = expect.objectContaining({
    type: "login.document.ready",
    signIn: { path: location.pathname },
  });

  it("is offered once per path (ADR 0016, amended 2026-11-04)", async () => {
    await formShownLate();
    expect(offers()).toEqual([offer]);
    // Shown again on the same path, as a dialog closed and opened again, it is not.
    document.body.innerHTML = accountList;
    await vi.advanceTimersByTimeAsync(500);
    document.body.innerHTML = form;
    await vi.advanceTimersByTimeAsync(1000);
    // Nor does a restarted worker's reconnect offer it again.
    await reconnect({ version: 1, type: "login.reconnect" });
    expect(offers()).toEqual([offer]);
  });

  // A background that does not send it, as within the retry window, answers that the page
  // may still be sent, so the watch goes on.
  const mayStillSend = { ok: false, reason: "recipe-not-found", starts: [], generate: true };

  it("is offered once per path while the page may still be sent", async () => {
    signInReply.current = mayStillSend;
    await formShownLate();
    expect(offers()).toEqual([offer]);
    document.body.innerHTML = accountList;
    await vi.advanceTimersByTimeAsync(500);
    document.body.innerHTML = form;
    await vi.advanceTimersByTimeAsync(1000);
    expect(offers()).toEqual([offer]);
  });

  it("is not offered after the page submitted a password form", async () => {
    signInReply.current = mayStillSend;
    await formShownLate();
    expect(offers()).toEqual([offer]);
    // The test page stays: the submission is stopped once the content script heard it.
    const stay = (event: Event) => event.preventDefault();
    window.addEventListener("submit", stay);
    document.querySelector("form")!.requestSubmit();
    window.removeEventListener("submit", stay);
    // The page signed in moves on, and minutes later asks for the password again on a
    // settings path, as a re-entry before a change.
    history.replaceState(null, "", "/pateat-next");
    await vi.advanceTimersByTimeAsync(500);
    document.body.innerHTML = accountList;
    history.replaceState(null, "", "/pateat-settings");
    await vi.advanceTimersByTimeAsync(LOGIN_STEP_WAIT_MS + 500);
    document.body.innerHTML = form;
    await vi.advanceTimersByTimeAsync(1000);
    history.replaceState(null, "", start);
    expect(offers()).toEqual([offer]);
  });

  it("is offered once when a default is chosen while the page changes", async () => {
    signInReply.current = mayStillSend;
    await formShownLate();
    // The fresh announcement's answer comes after the page changed.
    let answer: (value: Record<string, unknown>) => void = () => undefined;
    next.push(new Promise((resolve) => (answer = resolve)));
    for (const listener of listeners)
      listener(
        { version: 1, type: "login.reconnect", fresh: true },
        { id: "synthetic-extension" },
        () => undefined,
      );
    document.querySelector("h1")!.textContent = "Welcome back";
    await vi.advanceTimersByTimeAsync(500);
    answer(mayStillSend);
    await vi.advanceTimersByTimeAsync(500);
    expect(offers()).toEqual([offer, offer]);
  });

  it("is not offered on a path whose input the window already offered", async () => {
    document.body.innerHTML = form;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(500);
    expect(offers()).toEqual([offer]);
    document.body.innerHTML = accountList;
    await vi.advanceTimersByTimeAsync(LOGIN_STEP_WAIT_MS + 500);
    document.body.innerHTML = form;
    await vi.advanceTimersByTimeAsync(1000);
    expect(offers()).toEqual([offer]);
  });

  it("is offered once more when a default chosen in the popup announces the page anew (ADR 0021)", async () => {
    await formShownLate();
    await reconnect({ version: 1, type: "login.reconnect", fresh: true });
    expect(offers()).toEqual([offer, offer]);
    // Then once only: the page's later changes send nothing more.
    document.querySelector("h1")!.textContent = "Welcome back";
    await vi.advanceTimersByTimeAsync(LOGIN_STEP_WAIT_MS + 1000);
    expect(offers()).toHaveLength(2);
  });

  it("offers nothing more when the fresh announcement is not answered", async () => {
    await formShownLate();
    // A worker that stops meanwhile answers that the document is stale.
    next.push({ ok: false, reason: "stale-document" });
    await reconnect({ version: 1, type: "login.reconnect", fresh: true });
    document.querySelector("h1")!.textContent = "Welcome back";
    await vi.advanceTimersByTimeAsync(LOGIN_STEP_WAIT_MS + 1000);
    expect(offers()).toEqual([offer]);
  });

  it("offers nothing from a document whose login was cancelled", async () => {
    document.body.innerHTML = accountList;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(LOGIN_STEP_WAIT_MS + 500);
    await reconnect({ version: 1, type: "login.cancel" }, sent[0]!["token"]);
    document.body.innerHTML = form;
    await vi.advanceTimersByTimeAsync(1000);
    await reconnect({ version: 1, type: "login.reconnect", fresh: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(offers()).toEqual([]);
  });
});
