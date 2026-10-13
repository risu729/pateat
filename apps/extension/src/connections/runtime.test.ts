import { describe, expect, it, vi } from "vitest";
import type { CryptoHost } from "../crypto/host";
import { createConnectionRuntime } from "./runtime";
import { SETUP_PORT } from "./wire";

vi.mock("wxt/browser", () => ({
  browser: {
    runtime: {
      id: "synthetic-extension",
      getURL: (path: string) => `chrome-extension://synthetic-extension${path}`,
    },
  },
}));
vi.mock("../settings", () => ({ createLocalSettingsRuntime: () => ({}) }));

function settingsPort(postMessage: () => void) {
  const listeners: { message?: (input: unknown) => void } = {};
  return {
    name: SETUP_PORT,
    sender: {
      id: "synthetic-extension",
      url: "chrome-extension://synthetic-extension/options.html",
    },
    postMessage: vi.fn(postMessage),
    disconnect: vi.fn(),
    onDisconnect: { addListener: vi.fn() },
    onMessage: {
      addListener: (listener: (input: unknown) => void) => {
        listeners.message = listener;
      },
    },
    send: (input: unknown) => listeners.message?.(input),
  };
}

describe("settings-page setup port", () => {
  it("disconnects when a reply cannot be sent, so the page fails at once instead of waiting", async () => {
    const runtime = createConnectionRuntime({} as CryptoHost, {
      registry: { list: async () => [], get: async () => undefined } as never,
    });
    const port = settingsPort(() => {
      throw new Error("Message length exceeded maximum allowed length.");
    });
    expect(runtime.attach(port as never)).toBe(true);
    port.send({ requestId: crypto.randomUUID(), type: "connection.status" });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    expect(port.disconnect).toHaveBeenCalledOnce();
  });
});
