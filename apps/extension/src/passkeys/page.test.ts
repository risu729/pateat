import { afterEach, describe, expect, it, vi } from "vitest";
import { installPasskeyPage } from "./page";
import { PAGE_CHANNEL, type RuntimeResult } from "./wire";

const origin = "https://login.example.com";
type Message = { channel: string; type: string; id: string };

/** Minimal top-level window: same-origin postMessage plus a scripted isolated relay. */
function fakePage(relay: (message: Message) => Array<Record<string, unknown>> = () => []) {
  const listeners: Array<(event: unknown) => void> = [];
  const posted: Message[] = [];
  const nativeGet = vi.fn(async function (this: unknown, _options?: unknown) {
    return "native" as unknown;
  });
  const container: { get: (options?: unknown) => Promise<unknown> } = { get: nativeGet };
  // The wrapper reads only each class's prototype.
  const PublicKeyCredential = { prototype: { kind: "credential" } };
  const AuthenticatorAssertionResponse = { prototype: { kind: "response" } };
  const scope: Record<string, unknown> & { postMessage(data: unknown): void } = {
    navigator: { credentials: container },
    PublicKeyCredential,
    AuthenticatorAssertionResponse,
    AbortSignal,
    location: { origin },
    addEventListener: (_type: string, listener: (event: unknown) => void) =>
      listeners.push(listener),
    postMessage(data: unknown) {
      const copy = structuredClone(data) as Message;
      queueMicrotask(() => {
        for (const listener of listeners) listener({ source: scope, origin, data: copy });
        if (copy.channel !== PAGE_CHANNEL) return;
        if (copy.type === "get" || copy.type === "cancel") {
          posted.push(copy);
          for (const reply of relay(copy)) scope.postMessage({ channel: PAGE_CHANNEL, ...reply });
        }
      });
    },
  };
  scope["top"] = scope;
  installPasskeyPage(scope as unknown as Parameters<typeof installPasskeyPage>[0]);
  return {
    container,
    nativeGet,
    posted,
    prototypes: { credential: PublicKeyCredential.prototype },
  };
}

const publicKey = { challenge: new Uint8Array(16), allowCredentials: [] };
const answer = (result: RuntimeResult) => (message: Message) =>
  message.type === "get"
    ? [
        { type: "ack", id: message.id },
        { type: "result", id: message.id, result },
      ]
    : [];

afterEach(() => {
  vi.useRealTimers();
});

describe("MAIN-world passkey wrapper", () => {
  it("delegates with the caller's exact arguments, signal included", async () => {
    const page = fakePage(answer({ kind: "delegate", reason: "not-configured" }));
    const options = { publicKey, signal: new AbortController().signal };
    await expect(page.container.get(options)).resolves.toBe("native");
    expect(page.nativeGet).toHaveBeenCalledOnce();
    expect(page.nativeGet.mock.calls[0]).toEqual([options]);
    expect(page.nativeGet.mock.calls[0]![0]).toBe(options);
    expect(page.nativeGet.mock.contexts[0]).toBe(page.container);
  });

  it("delegates promptly when no relay acknowledges", async () => {
    vi.useFakeTimers();
    const page = fakePage();
    const result = page.container.get({ publicKey });
    await vi.advanceTimersByTimeAsync(999);
    expect(page.nativeGet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("native");
    expect(page.posted.map((message) => message.type)).toEqual(["get", "cancel"]);
  });

  it("rejects with the caller's abort reason and cancels the operation", async () => {
    const page = fakePage((message) =>
      message.type === "get" ? [{ type: "ack", id: message.id }] : [],
    );
    const controller = new AbortController();
    const result = page.container.get({ publicKey, signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reason = { synthetic: "abort" };
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.posted.map((message) => message.type)).toEqual(["get", "cancel"]);
    expect(page.nativeGet).not.toHaveBeenCalled();
  });

  it("leaves a non-AbortSignal signal to the browser without relaying", async () => {
    const page = fakePage(answer({ kind: "cancelled" }));
    const options = { publicKey, signal: { aborted: false, addEventListener() {} } };
    await expect(page.container.get(options as never)).resolves.toBe("native");
    expect(page.posted).toEqual([]);
  });

  it("returns a credential with native prototypes for a valid assertion", async () => {
    const assertion = {
      credentialId: "AQID",
      clientDataJSON: "e30",
      authenticatorData: "AA",
      signature: "MAA",
      userHandle: null,
    };
    const page = fakePage(answer({ kind: "assertion", assertion }));
    const credential = (await page.container.get({ publicKey })) as unknown as {
      id: string;
      toJSON(): unknown;
    };
    expect(page.nativeGet).not.toHaveBeenCalled();
    expect(credential.id).toBe("AQID");
    expect(Object.getPrototypeOf(credential)).toBe(page.prototypes.credential);
    expect(credential.toJSON()).toMatchObject({ id: "AQID", type: "public-key" });
  });
});
