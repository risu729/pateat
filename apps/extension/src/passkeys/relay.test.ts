import { afterEach, describe, expect, it, vi } from "vitest";
import { installPasskeyRelay } from "./relay";
import { PAGE_CHANNEL } from "./wire";

const origin = "https://login.example.com";
const id = "00000000-0000-4000-8000-000000000000";

/** Top-level secure window whose posts reach its own listeners, as a page's listeners see them. */
function fakeWindow() {
  const listeners: Array<(event: unknown) => void> = [];
  const posted: unknown[] = [];
  const scope = {
    isSecureContext: true,
    addEventListener: (_type: string, listener: (event: unknown) => void) =>
      listeners.push(listener),
    removeEventListener: () => {},
    postMessage(data: unknown) {
      posted.push(data);
      for (const listener of listeners) listener({ source: scope, origin, data });
    },
    top: undefined as unknown,
  };
  scope.top = scope;
  vi.stubGlobal("window", scope);
  vi.stubGlobal("location", { origin });
  vi.stubGlobal("navigator", { userActivation: { isActive: false } });
  vi.stubGlobal("document", { featurePolicy: { allowsFeature: () => true } });
  return { scope, posted };
}

afterEach(() => {
  vi.unstubAllGlobals();
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
});
