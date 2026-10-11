import { describe, expect, it, vi } from "vitest";
import {
  chooserWaitMs,
  createPasskeyRuntime,
  type PasskeyChoice,
  type PasskeyChooser,
  type PasskeySource,
} from "./runtime";
import { CHOOSER_MAX_WAIT_MS, CHOOSER_MIN_WAIT_MS } from "./wire";
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
    candidates: vi.fn(async () => ({ candidates: [candidate], complete: true })),
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
    expect(backing.candidates).toHaveBeenCalledWith(origin, "example.com", expect.any(AbortSignal));
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
    const backing = source({
      candidates: vi.fn(async () => ({
        candidates: [{ ...candidate, counter: 2 }],
        complete: true,
      })),
    });
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
      timeout: 1000,
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

describe("passkey runtime reports", () => {
  it("reports the delegate reason and value-free counts without credential data", async () => {
    const report = vi.fn();
    const stored = [
      { ...candidate, credentialId: "BAUG", preferred: true, discoverable: false },
      candidate,
      { ...candidate, credentialId: "BwgJ" },
    ];
    const runtime = createPasskeyRuntime(
      source({
        candidates: vi.fn(async () => ({
          candidates: stored,
          complete: true,
          siteDefault: "searched" as const,
        })),
      }),
      { extensionId, report },
    );
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "ambiguous-credential",
    });
    // The site default's passkey is not discoverable, so a request without an allow list
    // cannot use it and the two other passkeys stay ambiguous.
    expect(report).toHaveBeenCalledWith({
      tabId: 7,
      origin,
      outcome: "delegate",
      reason: "ambiguous-credential",
      rpId: "example.com",
      allowCredentials: 0,
      stored: 3,
      accepted: 2,
      siteDefault: 1,
      siteDefaultAccepted: 0,
      siteDefaultItem: "searched",
      complete: true,
    });
    expect(report).toHaveBeenCalledTimes(1);
    const serialized = JSON.stringify(report.mock.calls);
    for (const secret of ["AQID", "BAUG", "BwgJ", "dXNlcg"])
      expect(serialized).not.toContain(secret);
  });

  it("reports admission delegations and assertions, and a failing report changes nothing", async () => {
    const report = vi.fn(() => {
      throw new Error("console unavailable");
    });
    const runtime = createPasskeyRuntime(source(), { extensionId, report });
    expect(
      await runtime.handle(
        { ...get(), request: { ...request, mediation: "conditional" } },
        sender(),
      ),
    ).toEqual({ kind: "delegate", reason: "unsupported-mediation" });
    expect(report).toHaveBeenLastCalledWith({
      tabId: 7,
      origin,
      outcome: "delegate",
      reason: "unsupported-mediation",
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(report).toHaveBeenLastCalledWith({
      tabId: 7,
      origin,
      outcome: "assertion",
      rpId: "example.com",
      allowCredentials: 0,
      stored: 1,
      accepted: 1,
      siteDefault: 0,
      siteDefaultAccepted: 0,
      complete: true,
    });
    expect(report).toHaveBeenCalledTimes(2);
  });

  it("reports no request from an invalid sender or a cancellation", async () => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(source(), { extensionId, report });
    await runtime.handle(get(), sender({ frameId: 3 }));
    await runtime.handle(
      { version: 1, type: "passkey.cancel", operationId: crypto.randomUUID() },
      sender(),
    );
    expect(report).not.toHaveBeenCalled();
  });
});

describe("passkey chooser window", () => {
  const pair = [
    { ...candidate, display: { item: "Work", userName: "alice", account: "Personal" } },
    { ...candidate, credentialId: "BAUG" },
  ];
  const several = (overrides: Partial<PasskeySource> = {}, siteDefault?: "searched" | "unset") =>
    source({
      candidates: vi.fn(async () => ({
        candidates: pair,
        complete: true,
        ...(siteDefault ? { siteDefault } : {}),
      })),
      ...overrides,
    });
  const chooser = (
    answer: (input: Parameters<PasskeyChooser["choose"]>[0]) => Promise<PasskeyChoice>,
  ) => ({
    choose: vi.fn(answer),
  });

  it("signs with the chosen passkey and saves it only after answering", async () => {
    const backing = several({}, "searched");
    const choose = chooser(async () => ({ kind: "chosen", index: 1, makeDefault: true }));
    const remember = vi.fn(async () => {});
    const report = vi.fn();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: choose,
      remember,
      report,
    });
    const result = await runtime.handle(get(), sender());
    expect(result).toMatchObject({ kind: "assertion", assertion: { credentialId: "BAUG" } });
    expect(choose.choose).toHaveBeenCalledWith({
      tabId: 7,
      origin,
      rpId: "example.com",
      entries: [{ item: "Work", userName: "alice", account: "Personal" }, { item: "Passkey 2" }],
      replacesDefault: true,
      signal: expect.any(AbortSignal),
    });
    expect(backing.sign).toHaveBeenCalledWith(
      pair[1],
      expect.anything(),
      expect.anything(),
      expect.any(AbortSignal),
    );
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ chooser: "chosen" }));
    expect(remember).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remember).toHaveBeenCalledWith(origin, pair[1]);
  });

  it("does not save a one-time choice", async () => {
    const remember = vi.fn(async () => {});
    const runtime = createPasskeyRuntime(several(), {
      extensionId,
      chooser: chooser(async () => ({ kind: "chosen", index: 0, makeDefault: false })),
      remember,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({
      assertion: { credentialId: "AQID" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remember).not.toHaveBeenCalled();
  });

  it.each(["browser", "closed", "unavailable"] as const)(
    "delegates when the window ends with %s",
    async (kind) => {
      const backing = several();
      const runtime = createPasskeyRuntime(backing, {
        extensionId,
        chooser: chooser(async () => ({ kind })),
      });
      expect(await runtime.handle(get(), sender())).toEqual({
        kind: "delegate",
        reason: `chooser-${kind}`,
      });
      expect(backing.sign).not.toHaveBeenCalled();
    },
  );

  it("delegates an out-of-range answer", async () => {
    const runtime = createPasskeyRuntime(several(), {
      extensionId,
      chooser: chooser(async () => ({ kind: "chosen", index: 2, makeDefault: true })),
    });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "chooser-invalid",
    });
  });

  it("opens no window in incognito, or with fewer than two signable passkeys", async () => {
    const choose = chooser(async () => ({ kind: "closed" }));
    const runtime = createPasskeyRuntime(several(), { extensionId, chooser: choose });
    expect(await runtime.handle(get(), sender({ tab: { id: 7, incognito: true } }))).toEqual({
      kind: "delegate",
      reason: "ambiguous-credential",
    });
    const counted = createPasskeyRuntime(
      source({
        candidates: vi.fn(async () => ({
          candidates: [pair[0]!, { ...pair[1]!, counter: 3 }],
          complete: true,
        })),
      }),
      { extensionId, chooser: choose },
    );
    expect(await counted.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "ambiguous-credential",
    });
    expect(choose.choose).not.toHaveBeenCalled();
  });

  it("closes the window when the page cancels or settings change", async () => {
    const signals: AbortSignal[] = [];
    const choose = chooser(
      (input) =>
        new Promise<PasskeyChoice>(() => {
          signals.push(input.signal);
        }),
    );
    const runtime = createPasskeyRuntime(several(), { extensionId, chooser: choose });
    const operationId = crypto.randomUUID();
    const pending = runtime.handle(get(operationId), sender());
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await runtime.handle({ version: 1, type: "passkey.cancel", operationId }, sender());
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(signals[0]!.aborted).toBe(true);
    const second = runtime.handle(get(), sender());
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    runtime.cancelAll();
    expect(await second).toEqual({ kind: "cancelled" });
    expect(signals[1]!.aborted).toBe(true);
  });

  it("waits past the lookup budget up to the caller's timeout", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const runtime = createPasskeyRuntime(several(), {
        extensionId,
        chooser: chooser(
          (input) =>
            new Promise<PasskeyChoice>(() => {
              signals.push(input.signal);
            }),
        ),
      });
      let settled: unknown;
      void runtime
        .handle({ ...get(), request: { ...request, timeout: 30_000 } }, sender())
        .then((result) => (settled = result));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toEqual({ kind: "delegate", reason: "timeout" });
      expect(signals[0]!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the wait by Pateat's limits", () => {
    expect(chooserWaitMs(undefined)).toBe(CHOOSER_MAX_WAIT_MS);
    expect(chooserWaitMs(600_000)).toBe(CHOOSER_MAX_WAIT_MS);
    expect(chooserWaitMs(0)).toBe(CHOOSER_MIN_WAIT_MS);
    expect(chooserWaitMs(45_000)).toBe(45_000);
  });
});
