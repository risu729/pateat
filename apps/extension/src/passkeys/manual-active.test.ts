import { describe, expect, it, vi } from "vitest";
import { createPasskeyRuntime, type ConditionalDecision, type PasskeySource } from "./runtime";

const extensionId = "synthetic-extension";
const origin = "https://login.example.com";
const candidate = {
  credentialId: "AQID",
  rpId: "example.com",
  userHandle: "dXNlcg",
  discoverable: true,
  counter: 0,
};
const sender = {
  id: extensionId,
  tab: { id: 7 },
  frameId: 0,
  documentId: "document-a",
  documentLifecycle: "active",
  origin,
  url: `${origin}/signin`,
};
const request = () => ({
  version: 1,
  type: "passkey.get",
  operationId: crypto.randomUUID(),
  request: { challenge: "AAECAwQFBgcICQoLDA0ODw", rpId: "example.com", allowCredentials: [] },
  userActivation: true,
  focused: true,
});
const signature = () => Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01);
const source = (overrides: Partial<PasskeySource> = {}): PasskeySource => ({
  candidates: vi.fn(async () => ({ candidates: [candidate], complete: true })),
  sign: vi.fn(async () => signature()),
  ...overrides,
});
const policy = { presence: "always", verification: "always" } as const;

describe("passkey activity fences for manual login handoff", () => {
  it("stays active through policy reads, signing and the synchronous final callback, scoped to its document", async () => {
    const policyGate = Promise.withResolvers<typeof policy>();
    const signing = Promise.withResolvers<Uint8Array>();
    const activeAtReply: boolean[] = [];
    const backing = source({ sign: vi.fn(async () => signing.promise) });
    const answered = vi.fn(() => activeAtReply.push(runtime.active("document-a")));
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      policy: () => policyGate.promise,
      answered,
    });
    const pending = runtime.handle(request(), sender);
    expect(runtime.active("document-a")).toBe(true);
    expect(runtime.active("document-b")).toBe(false);
    policyGate.resolve(policy);
    await vi.waitFor(() => expect(backing.sign).toHaveBeenCalledTimes(1));
    expect(runtime.active("document-a")).toBe(true);
    signing.resolve(signature());

    expect(await pending).toMatchObject({ kind: "assertion" });
    expect(answered).toHaveBeenCalledTimes(1);
    expect(activeAtReply).toEqual([true]);
    expect(runtime.active("document-a")).toBe(false);
  });

  it("does not let a duplicate request clear another pending handle's activity", async () => {
    const policyGate = Promise.withResolvers<typeof policy>();
    const signing = Promise.withResolvers<Uint8Array>();
    const runtime = createPasskeyRuntime(source({ sign: async () => signing.promise }), {
      extensionId,
      policy: () => policyGate.promise,
    });
    const input = request();
    const first = runtime.handle(input, sender);
    expect(runtime.active("document-a")).toBe(true);
    const duplicate = runtime.handle(input, sender);
    policyGate.resolve(policy);
    expect(await duplicate).toMatchObject({ kind: "delegate" });
    expect(runtime.active("document-a")).toBe(true);
    signing.resolve(signature());
    expect(await first).toMatchObject({ kind: "assertion" });
    expect(runtime.active("document-a")).toBe(false);
  });
  it("releases activity after a signing failure", async () => {
    const signing = Promise.withResolvers<Uint8Array>();
    const backing = source({ sign: vi.fn(async () => signing.promise) });
    const runtime = createPasskeyRuntime(backing, { extensionId, policy: () => policy });
    const pending = runtime.handle(request(), sender);
    await vi.waitFor(() => expect(backing.sign).toHaveBeenCalledTimes(1));
    expect(runtime.active("document-a")).toBe(true);
    signing.reject(new Error("synthetic signing failure"));
    expect(await pending).toMatchObject({ kind: "delegate" });
    expect(runtime.active("document-a")).toBe(false);
  });

  it("releases activity after cancellation without a late signing result reviving it", async () => {
    const signing = Promise.withResolvers<Uint8Array>();
    const backing = source({ sign: vi.fn(async () => signing.promise) });
    const answered = vi.fn();
    const runtime = createPasskeyRuntime(backing, { extensionId, policy: () => policy, answered });
    const input = request();
    const pending = runtime.handle(input, sender);
    await vi.waitFor(() => expect(backing.sign).toHaveBeenCalledTimes(1));
    expect(runtime.active("document-a")).toBe(true);
    await runtime.handle(
      { version: 1, type: "passkey.cancel", operationId: input.operationId },
      sender,
    );
    expect(await pending).toMatchObject({ kind: "cancelled" });
    expect(runtime.active("document-a")).toBe(false);
    signing.resolve(signature());
    await Promise.resolve();
    expect(answered).not.toHaveBeenCalled();
    expect(runtime.active("document-a")).toBe(false);
  });
  it("does not count a conditional request waiting for its page's login, until it is handed an item (ADR 0034)", async () => {
    const decision = Promise.withResolvers<ConditionalDecision>();
    const signing = Promise.withResolvers<Uint8Array>();
    const backing = source({ sign: vi.fn(async () => signing.promise) });
    const conditional = vi.fn(async () => decision.promise);
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      policy: () => policy,
      conditional,
    });
    const input = { ...request(), request: { ...request().request, mediation: "conditional" } };
    const pending = runtime.handle(input, sender);
    await vi.waitFor(() => expect(conditional).toHaveBeenCalledTimes(1));
    expect(runtime.active("document-a")).toBe(false);
    const answered = vi.fn();
    decision.resolve({
      kind: "answer",
      item: { connectionId: "personal", itemId: "login-item" },
      answered,
    });
    await vi.waitFor(() => expect(backing.sign).toHaveBeenCalledTimes(1));
    expect(runtime.active("document-a")).toBe(true);
    signing.resolve(signature());
    expect(await pending).toMatchObject({ kind: "assertion" });
    expect(runtime.active("document-a")).toBe(false);
    // The login hears of it once the page says it used the assertion.
    expect(answered).not.toHaveBeenCalled();
    await runtime.handle(
      {
        version: 1,
        type: "passkey.delivered",
        operationId: input.operationId,
        delivered: true,
      },
      sender,
    );
    expect(answered.mock.calls).toEqual([[true]]);
  });

  it("still counts another request of the document while a conditional one waits", async () => {
    const decision = Promise.withResolvers<ConditionalDecision>();
    const signing = Promise.withResolvers<Uint8Array>();
    const backing = source({ sign: vi.fn(async () => signing.promise) });
    const conditional = vi.fn(async () => decision.promise);
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      policy: () => policy,
      conditional,
    });
    const parked = { ...request(), request: { ...request().request, mediation: "conditional" } };
    const waiting = runtime.handle(parked, sender);
    await vi.waitFor(() => expect(conditional).toHaveBeenCalledTimes(1));
    expect(runtime.active("document-a")).toBe(false);
    const modal = runtime.handle(request(), sender);
    await vi.waitFor(() => expect(backing.sign).toHaveBeenCalledTimes(1));
    expect(runtime.active("document-a")).toBe(true);
    signing.resolve(signature());
    expect(await modal).toMatchObject({ kind: "assertion" });
    expect(runtime.active("document-a")).toBe(false);
    await runtime.handle(
      { version: 1, type: "passkey.cancel", operationId: parked.operationId },
      sender,
    );
    expect(await waiting).toMatchObject({ kind: "cancelled" });
    expect(runtime.active("document-a")).toBe(false);
  });
});
