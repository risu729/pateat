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

describe("a step's wait for a change of the page (ADR 0082)", () => {
  const ready = (token: string, timeoutMs: number) =>
    ({
      version: 1,
      type: "login.await",
      token,
      timeoutMs,
      readiness: {
        path: "/login",
        require: "clickable",
        targets: [{ by: "text", value: "Log In" }],
      },
    }) as const;
  /** Sends `message` and returns the page's answer once it comes, without advancing time. */
  function sendNow(message: Record<string, unknown>): { value?: unknown } {
    const reply: { value?: unknown } = {};
    for (const listener of listeners)
      listener(message, { id: "synthetic-extension" }, (value) => (reply.value = value));
    return reply;
  }

  it("answers within a frame once the button is enabled", async () => {
    const token = await open(page);
    const reply = sendNow(ready(token, 5_000));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reply.value).toBeUndefined();
    document.querySelector("button[type=submit]")!.removeAttribute("disabled");
    await vi.advanceTimersByTimeAsync(20);
    expect(reply.value).toEqual({ ok: true });
  });

  it("ends at once when the login is cancelled", async () => {
    const token = await open(page);
    const reply = sendNow(ready(token, 5_000));
    await vi.advanceTimersByTimeAsync(100);
    sendNow({ version: 1, type: "login.cancel", token });
    await vi.advanceTimersByTimeAsync(0);
    expect(reply.value).toEqual({ ok: false, reason: "cancelled" });
  });
});

describe("a final advance click beside a password input that opens (ADR 0018 amendment of 2026-11-03)", () => {
  // The password block shows only once the email is typed; Log In stays disabled.
  const resendLike = (form = "", other = "") => `<main><form>
    <input type="email" id="email" name="email">
    <div id="block" style="visibility: hidden; height: 0; overflow: hidden">
      <input type="password" id="password" name="password" ${form}>
    </div>
    <button type="submit" disabled>Log In</button></form>${other}</main>`;
  const watching = (token: string, revealed = true) =>
    command({
      version: 1,
      type: "login.await",
      token,
      timeoutMs: 200,
      readiness: {
        path: "/login",
        require: "clickable",
        targets: [{ by: "text", value: "Log In" }],
        ...(revealed ? { revealed: true } : {}),
      },
    });
  const reveal = () => {
    const block = document.querySelector<HTMLElement>("#block")!;
    block.style.visibility = "visible";
    block.style.height = "auto";
  };

  it("answers `revealed` once the password input shows beside the disabled button", async () => {
    const token = await open(resendLike());
    expect(await watching(token)).toEqual({ ok: false, reason: "timeout", miss: "not-clickable" });
    reveal();
    expect(await watching(token)).toEqual({ ok: false, reason: "revealed" });
    // Asked without it, the wait runs out as any step's.
    expect(await watching(token, false)).toEqual({
      ok: false,
      reason: "timeout",
      miss: "not-clickable",
    });
    // An enabled button is ready, whatever shows beside it.
    document.querySelector("button")!.removeAttribute("disabled");
    expect(await watching(token)).toEqual({ ok: true });
  });

  it("ignores a new password, and a password input of another form", async () => {
    let token = await open(resendLike('autocomplete="new-password"'));
    reveal();
    expect(await watching(token)).toEqual({ ok: false, reason: "timeout", miss: "not-clickable" });
    uninstall?.();
    sent.length = 0;
    token = await open(
      `<main><form><input type="email" id="email"><button type="submit" disabled>Log In</button></form>
      <form><input type="password" id="other"></form></main>`,
    );
    expect(await watching(token)).toEqual({ ok: false, reason: "timeout", miss: "not-clickable" });
  });
});
