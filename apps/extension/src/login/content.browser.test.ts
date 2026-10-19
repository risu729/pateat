import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLoginContent } from "./content";

const { sent } = vi.hoisted(() => ({ sent: [] as Record<string, unknown>[] }));

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      onMessage: { addListener: () => undefined, removeListener: () => undefined },
    },
  },
}));
// The background answers the first announcement that the page may be sent for generation,
// and any later one that it is being sent.
vi.mock("../messaging/protocol", () => ({
  sendMessage: async (_channel: string, message: Record<string, unknown>) => {
    sent.push(message);
    return sent.length === 1
      ? { ok: false, reason: "recipe-not-found", starts: [], generate: true }
      : { ok: false, reason: "generating" };
  },
}));

let uninstall: (() => void) | undefined;
beforeEach(() => {
  sent.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  uninstall?.();
  uninstall = undefined;
  vi.useRealTimers();
  document.body.innerHTML = "";
});

/** What the page announced after its first announcement. */
const offers = () => sent.slice(1);

describe("a page with a passkey button in the offer wait (ADR 0053, ADR 0057)", () => {
  it("is offered once its DOM is quiet for a second, with the list it would show otherwise", async () => {
    document.body.innerHTML = `<main><h1>Welcome back</h1>
      <button id="login-key">Sign in with a passkey</button></main>`;
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(900);
    expect(offers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    expect(offers()).toEqual([
      expect.objectContaining({
        type: "login.document.ready",
        signIn: { path: expect.any(String), passkey: true },
        list: expect.objectContaining({ names: expect.any(Array) }),
      }),
    ]);
    expect(offers()[0]).not.toHaveProperty("entry");
  });

  it("is offered at the five-second limit while its DOM keeps changing", async () => {
    document.body.innerHTML = `<main><h1>Welcome back</h1><p id="clock">0</p>
      <button id="login-key">Sign in with a passkey</button></main>`;
    let ticks = 0;
    const clock = setInterval(() => {
      document.querySelector("#clock")!.textContent = String(++ticks);
    }, 200);
    uninstall = installLoginContent();
    await vi.advanceTimersByTimeAsync(4_900);
    expect(offers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(200);
    clearInterval(clock);
    expect(offers()).toEqual([
      expect.objectContaining({ signIn: { path: expect.any(String), passkey: true } }),
    ]);
  });
});
