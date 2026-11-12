import { expect, it, vi, type Mock } from "vitest";
import type { CryptoHost } from "../../../src/crypto/host";
import { createConnectionRuntime } from "../../../src/connections/runtime";

export function registerSettingsPortCases({
  settingsPort,
}: {
  settingsPort: (
    postMessage: () => void,
    url?: string,
  ) => {
    postMessage: Mock<() => void>;
    disconnect: Mock;
    send: (input: unknown) => void;
  };
}) {
  it("is open to the settings page reloaded at a section link, and to no other page", () => {
    const runtime = createConnectionRuntime({} as CryptoHost, {
      registry: { list: async () => [], get: async () => undefined } as never,
    });
    const page = "chrome-extension://synthetic-extension";
    const reloaded = settingsPort(() => undefined, `${page}/options.html#sync`);
    expect(runtime.attach(reloaded as never)).toBe(true);
    expect(reloaded.disconnect).not.toHaveBeenCalled();
    for (const url of [`${page}/options.html?view=other`, `${page}/popup.html`]) {
      const other = settingsPort(() => undefined, url);
      expect(runtime.attach(other as never)).toBe(true);
      expect(other.disconnect).toHaveBeenCalledOnce();
    }
  });

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

  it("answers the page's heartbeat on the same port, expired when this worker holds no flow", async () => {
    const onVaultStateMayChange = vi.fn();
    const onSignIn = vi.fn();
    const runtime = createConnectionRuntime({} as CryptoHost, {
      registry: { list: async () => [], get: async () => undefined } as never,
      onVaultStateMayChange,
      onSignIn,
    });
    const port = settingsPort(() => undefined);
    expect(runtime.attach(port as never)).toBe(true);
    const requestId = crypto.randomUUID();
    port.send({ requestId, type: "connection.keep-alive", flowId: crypto.randomUUID() });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
    const expired = { ok: false, error: { code: "setup-expired" } };
    expect(port.postMessage).toHaveBeenCalledWith({ requestId, result: expired });
    // The local log gets the sign-in that ended while it waited for its code.
    expect(onSignIn).toHaveBeenCalledExactlyOnceWith("keep-alive", expired);
    expect(port.disconnect).not.toHaveBeenCalled();
    // A heartbeat every 20 seconds changes no vault state, so it re-reads none.
    expect(onVaultStateMayChange).not.toHaveBeenCalled();
    // Each sign-in step is logged too; a status read is not.
    const begin = crypto.randomUUID();
    port.send({
      requestId: begin,
      type: "connection.begin",
      input: {
        kind: "existing",
        connectionId: "synthetic-missing",
        password: "synthetic-password",
      },
    });
    port.send({ requestId: crypto.randomUUID(), type: "connection.status" });
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledTimes(3));
    expect(onSignIn).toHaveBeenCalledTimes(2);
    expect(onSignIn).toHaveBeenLastCalledWith("begin", {
      ok: false,
      error: { code: "invalid-request" },
    });
  });
}
