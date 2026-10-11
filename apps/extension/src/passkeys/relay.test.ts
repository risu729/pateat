import { afterEach, describe, expect, it, vi } from "vitest";
import { installPasskeyRelay } from "./relay";
import { PAGE_CHANNEL, RELAY_HEARTBEAT_MS } from "./wire";

const origin = "https://login.example.com";
const id = "00000000-0000-4000-8000-000000000000";

/** Top-level secure window whose posts reach its own listeners, as a page's listeners see them. */
function fakeWindow() {
  const listeners: Array<{ type: string; listener: (event: unknown) => void }> = [];
  const posted: unknown[] = [];
  const scope = {
    isSecureContext: true,
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.push({ type, listener }),
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      const index = listeners.findIndex(
        (entry) => entry.type === type && entry.listener === listener,
      );
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatch(type: string, event: unknown) {
      for (const entry of [...listeners]) if (entry.type === type) entry.listener(event);
    },
    postMessage(data: unknown) {
      posted.push(data);
      scope.dispatch("message", { source: scope, origin, data });
    },
    top: undefined as unknown,
  };
  scope.top = scope;
  vi.stubGlobal("window", scope);
  vi.stubGlobal("location", { origin });
  vi.stubGlobal("navigator", { userActivation: { isActive: false } });
  vi.stubGlobal("document", {
    featurePolicy: { allowsFeature: () => true },
    visibilityState: "visible",
    hasFocus: () => true,
  });
  return { scope, posted };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("isolated passkey relay", () => {
  it("tells the page that Pateat delegated, never why", async () => {
    const { scope, posted } = fakeWindow();
    const send = vi.fn(async () => ({ kind: "delegate", reason: "ambiguous-credential" }));
    installPasskeyRelay(send);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect(send).toHaveBeenCalledOnce();
    expect(posted.slice(1)).toEqual([
      { channel: PAGE_CHANNEL, type: "ack", id },
      { channel: PAGE_CHANNEL, type: "result", id, result: { kind: "delegate" } },
    ]);
  });

  it("passes on a failure after the chooser window's wait ran out", async () => {
    const { scope, posted } = fakeWindow();
    installPasskeyRelay(vi.fn(async () => ({ kind: "not-allowed" })));
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect(posted[2]).toEqual({
      channel: PAGE_CHANNEL,
      type: "result",
      id,
      result: { kind: "not-allowed" },
    });
  });

  it("drops the reason of delegations the relay decides itself", async () => {
    const { scope, posted } = fakeWindow();
    vi.stubGlobal("document", { featurePolicy: { allowsFeature: () => false } });
    const send = vi.fn();
    installPasskeyRelay(send);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: {} });
    await vi.waitFor(() => expect(posted).toHaveLength(3));
    expect(send).not.toHaveBeenCalled();
    expect(posted[2]).toEqual({
      channel: PAGE_CHANNEL,
      type: "result",
      id,
      result: { kind: "delegate" },
    });
  });

  it("repeats its acknowledgement while the background works, until it answers", async () => {
    vi.useFakeTimers();
    const { scope, posted } = fakeWindow();
    let answer!: (value: unknown) => void;
    const send = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    installPasskeyRelay(send);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    const acks = () => posted.filter((data) => (data as { type: string }).type === "ack").length;
    expect(acks()).toBe(1);
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS * 3);
    expect(acks()).toBe(4);
    answer({ kind: "delegate", reason: "chooser-closed" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS * 3);
    expect(acks()).toBe(4);
    expect(posted.at(-1)).toEqual({
      channel: PAGE_CHANNEL,
      type: "result",
      id,
      result: { kind: "delegate" },
    });
  });

  it("stops vouching once its extension context is gone", async () => {
    vi.useFakeTimers();
    const { scope, posted } = fakeWindow();
    let alive = true;
    installPasskeyRelay(
      () => new Promise(() => {}),
      () => alive,
    );
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS);
    alive = false;
    await vi.advanceTimersByTimeAsync(RELAY_HEARTBEAT_MS * 3);
    expect(posted.filter((data) => (data as { type: string }).type === "ack")).toHaveLength(2);
  });

  it("cancels pending requests when the page is left", async () => {
    const { scope } = fakeWindow();
    const send = vi.fn((message: unknown) =>
      (message as { type: string }).type === "passkey.get"
        ? new Promise(() => {})
        : Promise.resolve({ ok: true }),
    );
    installPasskeyRelay(send);
    scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    scope.dispatch("pagehide", {});
    await vi.waitFor(() =>
      expect(send).toHaveBeenLastCalledWith({
        version: 1,
        type: "passkey.cancel",
        operationId: id,
      }),
    );
    // A second pagehide finds nothing left to cancel.
    scope.dispatch("pagehide", {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["a focused, visible", "visible", true, true],
    ["a hidden", "hidden", true, false],
    ["an unfocused", "visible", false, false],
  ])(
    "reports %s document as focused only when it is both",
    async (_name, visibility, focus, expected) => {
      const { scope } = fakeWindow();
      vi.stubGlobal("document", {
        featurePolicy: { allowsFeature: () => true },
        visibilityState: visibility,
        hasFocus: () => focus,
      });
      const send = vi.fn(async () => ({ kind: "delegate", reason: "no-credential" }));
      installPasskeyRelay(send);
      scope.postMessage({ channel: PAGE_CHANNEL, type: "get", id, request: { challenge: "AA" } });
      await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ focused: expected }));
    },
  );
});
