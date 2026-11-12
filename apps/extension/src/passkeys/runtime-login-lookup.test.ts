import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPasskeyRuntime, type PasskeyItem, type PasskeySource } from "./runtime";

const extensionId = "synthetic-extension";
const origin = "https://login.example.com";
const sender = {
  id: extensionId,
  tab: { id: 7 },
  frameId: 0,
  documentId: "synthetic-document",
  documentLifecycle: "active",
  origin,
  url: `${origin}/login`,
};
const get = () => ({
  version: 1,
  type: "passkey.get",
  operationId: crypto.randomUUID(),
  userActivation: true,
  focused: true,
  request: { challenge: "AAECAwQFBgcICQoLDA0ODw", rpId: "example.com", allowCredentials: [] },
});
const login: PasskeyItem = { connectionId: "synthetic-connection", itemId: "synthetic-item" };
function source(): PasskeySource {
  return {
    candidates: vi.fn(async () => ({
      candidates: [
        {
          credentialId: "AQID",
          rpId: "example.com",
          userHandle: "dXNlcg",
          discoverable: true,
          counter: 0,
        },
      ],
      complete: true,
    })),
    sign: vi.fn(async () => Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01)),
  };
}

const cleanup: (() => Promise<unknown>)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((finish) => finish()));
  vi.useRealTimers();
});

describe("a passkey request waiting for its tab's login records", () => {
  it.each(["timeout", "page cancellation", "settings change"] as const)(
    "ends on %s, releases its hold once and ignores a late lookup",
    async (stop) => {
      const lookup = Promise.withResolvers<PasskeyItem | undefined>();
      const backing = source();
      const leave = vi.fn();
      const hold = vi.fn(async () => leave);
      // The first lookup belongs only to the value-free report. The second gates signing.
      const loginAccount = vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(lookup.promise);
      const report = vi.fn();
      const runtime = createPasskeyRuntime(backing, {
        extensionId,
        loginAccount,
        hold,
        report,
        timeoutMs: () => 100,
      });
      const message = get();
      const pending = runtime.handle(message, sender);
      cleanup.push(async () => {
        lookup.resolve(login);
        return pending;
      });
      let result: unknown;
      void pending.then((value) => (result = value));
      await vi.advanceTimersByTimeAsync(0);
      expect(loginAccount).toHaveBeenCalledTimes(2);
      expect(hold).toHaveBeenCalledOnce();
      expect(leave).not.toHaveBeenCalled();
      expect(backing.candidates).not.toHaveBeenCalled();
      if (stop === "timeout") await vi.advanceTimersByTimeAsync(100);
      else {
        if (stop === "settings change") runtime.settingsChanged();
        else
          expect(
            await runtime.handle(
              { version: 1, type: "passkey.cancel", operationId: message.operationId },
              sender,
            ),
          ).toEqual({ ok: true });
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(result).toEqual(
        stop === "timeout" ? { kind: "delegate", reason: "timeout" } : { kind: "cancelled" },
      );
      expect(leave).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining(
          stop === "timeout"
            ? { outcome: "delegate", reason: "timeout" }
            : {
                outcome: "cancelled",
                cause: stop === "settings change" ? "settings-changed" : "page-cancelled",
              },
        ),
      );
      lookup.resolve(login);
      await pending;
      await vi.advanceTimersByTimeAsync(0);
      expect(backing.candidates).not.toHaveBeenCalled();
      expect(backing.sign).not.toHaveBeenCalled();
      expect(leave).toHaveBeenCalledOnce();
      // The cancelled operation no longer consumes its document's admission slot.
      expect(
        await runtime.handle(
          { version: 1, type: "passkey.cancel", operationId: message.operationId },
          sender,
        ),
      ).toEqual({ ok: false });
    },
  );

  it.each(["throw", "reject"] as const)(
    "still delegates when the lookup fails by %s",
    async (failure) => {
      const backing = source();
      const leave = vi.fn();
      const loginAccount = vi
        .fn()
        .mockReturnValueOnce(undefined)
        .mockImplementationOnce(() => {
          if (failure === "throw") throw new Error("Synthetic records unavailable");
          return Promise.reject(new Error("Synthetic records unavailable"));
        });
      const runtime = createPasskeyRuntime(backing, {
        extensionId,
        loginAccount,
        hold: async () => leave,
      });
      expect(await runtime.handle(get(), sender)).toEqual({
        kind: "delegate",
        reason: "assertion-failed",
      });
      expect(leave).toHaveBeenCalledOnce();
      expect(backing.candidates).not.toHaveBeenCalled();
      expect(backing.sign).not.toHaveBeenCalled();
    },
  );

  it("does not wait for the separate report lookup before answering a delegated request", async () => {
    const reporting = Promise.withResolvers<PasskeyItem | undefined>();
    const backing = source();
    const report = vi.fn();
    const leave = vi.fn();
    const loginAccount = vi
      .fn()
      .mockReturnValueOnce(reporting.promise)
      .mockRejectedValueOnce(new Error("Synthetic answer lookup failed"));
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      loginAccount,
      report,
      hold: async () => leave,
    });
    cleanup.push(async () => {
      reporting.resolve(undefined);
    });
    expect(await runtime.handle(get(), sender)).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    expect(leave).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
    reporting.resolve(login);
    await vi.advanceTimersByTimeAsync(0);
    expect(report).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "delegate", duringLogin: true }),
    );
    expect(backing.sign).not.toHaveBeenCalled();
  });
});
