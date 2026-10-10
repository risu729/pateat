import { describe, expect, it, vi } from "vitest";
import { createPasskeyRuntime, type PasskeySource } from "./runtime";
import { snapshotGetOptions } from "./page";

const extensionId = "synthetic-extension";
const origin = "https://login.example.com";
const sender = (overrides: Record<string, unknown> = {}) => ({
  id: extensionId,
  tab: { id: 7 },
  frameId: 0,
  documentId: "document-a",
  origin,
  url: `${origin}/sign-in?next=%2F`,
  ...overrides,
});
const candidate = {
  credentialId: "AQID",
  rpId: "example.com",
  userHandle: "dXNlcg",
  discoverable: true,
  counter: 0,
};
const request = { challenge: "AAECAwQFBgcICQoLDA0ODw", rpId: "example.com", allowCredentials: [] };
const get = (operationId = crypto.randomUUID(), userActivation = true) => ({
  version: 1,
  type: "passkey.get",
  operationId,
  request,
  userActivation,
});

function source(overrides: Partial<PasskeySource> = {}): PasskeySource {
  return {
    candidates: vi.fn(async () => [candidate]),
    sign: vi.fn(async () => Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01)),
    ...overrides,
  };
}

describe("passkey runtime sender binding", () => {
  it("answers a top-frame document from its browser-supplied origin", async () => {
    const backing = source();
    const runtime = createPasskeyRuntime(backing, { extensionId });
    const result = await runtime.handle(get(), sender());
    expect(result).toMatchObject({ kind: "assertion", assertion: { credentialId: "AQID" } });
    expect(backing.candidates).toHaveBeenCalledWith(origin, expect.any(AbortSignal));
    const clientData = JSON.parse(
      atob(
        (result as { assertion: { clientDataJSON: string } }).assertion.clientDataJSON
          .replace(/-/gu, "+")
          .replace(/_/gu, "/"),
      ),
    );
    expect(clientData.origin).toBe(origin);
  });

  it.each([
    ["another extension", { id: "other" }],
    ["a subframe", { frameId: 3 }],
    ["no tab", { tab: undefined }],
    ["no document", { documentId: undefined }],
    ["mismatched URL", { url: "https://evil.example.net/" }],
    ["missing origin", { origin: undefined }],
  ])("delegates requests from %s without a lookup", async (_name, overrides) => {
    const backing = source();
    const runtime = createPasskeyRuntime(backing, { extensionId });
    expect(await runtime.handle(get(), sender(overrides))).toEqual({
      kind: "delegate",
      reason: "invalid-sender",
    });
    expect(backing.candidates).not.toHaveBeenCalled();
  });

  it("delegates without configuration and never signs", async () => {
    const backing = source({ candidates: vi.fn(async () => undefined) });
    const runtime = createPasskeyRuntime(backing, { extensionId });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "not-configured",
    });
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it("delegates a nonzero counter without signing", async () => {
    const backing = source({ candidates: vi.fn(async () => [{ ...candidate, counter: 2 }]) });
    const runtime = createPasskeyRuntime(backing, { extensionId });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "unsupported-counter",
    });
    expect(backing.sign).not.toHaveBeenCalled();
  });
});

describe("passkey runtime cancellation", () => {
  const slowSign = () =>
    source({
      sign: vi.fn(
        (_candidate, _data, _hash, signal: AbortSignal) =>
          new Promise<Uint8Array>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    });

  it("cancels only from the same document", async () => {
    const runtime = createPasskeyRuntime(slowSign(), { extensionId });
    const operationId = crypto.randomUUID();
    const pending = runtime.handle(get(operationId), sender());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancel = { version: 1, type: "passkey.cancel", operationId };
    expect(await runtime.handle(cancel, sender({ documentId: "document-b" }))).toEqual({
      ok: false,
    });
    expect(await runtime.handle(cancel, sender())).toEqual({ ok: true });
    expect(await pending).toEqual({ kind: "cancelled" });
  });

  it("delegates after its deadline and rejects duplicate operation IDs", async () => {
    const runtime = createPasskeyRuntime(slowSign(), { extensionId, timeoutMs: () => 20 });
    const operationId = crypto.randomUUID();
    const first = runtime.handle(get(operationId), sender());
    expect(await runtime.handle(get(operationId), sender())).toEqual({
      kind: "delegate",
      reason: "busy",
    });
    expect(await first).toEqual({ kind: "delegate", reason: "timeout" });
  });

  it("limits concurrent operations per document without starving other documents", async () => {
    const runtime = createPasskeyRuntime(slowSign(), { extensionId });
    const pending = Array.from({ length: 4 }, () => runtime.handle(get(), sender()));
    expect(await runtime.handle(get(), sender())).toEqual({ kind: "delegate", reason: "busy" });
    const other = runtime.handle(get(), sender({ documentId: "document-b" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.cancelAll();
    expect(await Promise.all([...pending, other])).toEqual(
      Array.from({ length: 5 }, () => ({ kind: "cancelled" })),
    );
  });

  it("cancels every in-flight operation on a policy change", async () => {
    const runtime = createPasskeyRuntime(slowSign(), { extensionId });
    const pending = [runtime.handle(get(), sender()), runtime.handle(get(), sender())];
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.cancelAll();
    expect(await Promise.all(pending)).toEqual([{ kind: "cancelled" }, { kind: "cancelled" }]);
  });
});

describe("page option snapshots", () => {
  it("copies buffer sources and keeps only supported members", () => {
    const challenge = new Uint8Array(32).fill(7);
    const id = new Uint8Array([1, 2, 3]);
    const snapshot = snapshotGetOptions({
      mediation: "optional",
      signal: new AbortController().signal,
      publicKey: {
        challenge: challenge.buffer,
        rpId: "example.com",
        userVerification: "preferred",
        timeout: 1000,
        extensions: { prf: {} },
        allowCredentials: [
          { type: "public-key", id: new DataView(id.buffer), transports: ["internal"] },
        ],
      },
    });
    challenge.fill(0);
    expect(snapshot).toEqual({
      challenge: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
      rpId: "example.com",
      userVerification: "preferred",
      mediation: "optional",
      allowCredentials: [{ type: "public-key", id: "AQID", transports: ["internal"] }],
    });
  });

  it.each([
    ["no options", undefined],
    ["password credentials", { password: true, publicKey: { challenge: new Uint8Array(16) } }],
    ["missing challenge", { publicKey: {} }],
    ["string challenge", { publicKey: { challenge: "AAAA" } }],
    [
      "non-array allow list",
      { publicKey: { challenge: new Uint8Array(16), allowCredentials: {} } },
    ],
    ["non-string RP ID", { publicKey: { challenge: new Uint8Array(16), rpId: 1 } }],
    ["shared buffer", { publicKey: { challenge: new Uint8Array(new SharedArrayBuffer(16)) } }],
    ["oversized challenge", { publicKey: { challenge: new Uint8Array(5000) } }],
  ])("leaves %s to the browser", (_name, options) => {
    expect(snapshotGetOptions(options)).toBeUndefined();
  });
});

describe("passkey runtime policy", () => {
  it("claims without a gesture under the initial policy", async () => {
    const runtime = createPasskeyRuntime(source(), { extensionId });
    expect(await runtime.handle(get(undefined, false), sender())).toMatchObject({
      kind: "assertion",
    });
  });

  it("asks the policy for the sender origin and honors a gesture requirement", async () => {
    const policy = vi.fn(() => ({ presence: "activation", verification: "never" }) as const);
    const backing = source();
    const runtime = createPasskeyRuntime(backing, { extensionId, policy });
    expect(await runtime.handle(get(undefined, false), sender())).toEqual({
      kind: "delegate",
      reason: "no-user-activation",
    });
    expect(policy).toHaveBeenCalledWith(origin);
    expect(backing.candidates).not.toHaveBeenCalled();
    expect(backing.sign).not.toHaveBeenCalled();
  });
});
