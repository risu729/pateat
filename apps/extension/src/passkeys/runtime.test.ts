import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chooserWaitMs,
  createPasskeyRuntime,
  type ConditionalDecision,
  type PasskeyChoice,
  type PasskeyChooser,
  type PasskeyItem,
  type PasskeySource,
} from "./runtime";
import type { PasskeyCandidates } from "./select";
import { CHOOSER_MAX_WAIT_MS, CHOOSER_MIN_WAIT_MS } from "./wire";
import { snapshotGetOptions } from "./page";
import type { SignedTabs } from "./signed-tabs";

const extensionId = "synthetic-extension";
const origin = "https://login.example.com";
const sender = (overrides: Record<string, unknown> = {}) => ({
  id: extensionId,
  tab: { id: 7 },
  frameId: 0,
  documentId: "document-a",
  documentLifecycle: "active",
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
const get = (operationId = crypto.randomUUID(), userActivation = true, focused = true) => ({
  version: 1,
  type: "passkey.get",
  operationId,
  request,
  userActivation,
  focused,
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
    const report = vi.fn();
    const runtime = createPasskeyRuntime(slowSign(), { extensionId, report });
    const operationId = crypto.randomUUID();
    const pending = runtime.handle(get(operationId), sender());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const cancel = { version: 1, type: "passkey.cancel", operationId };
    expect(await runtime.handle(cancel, sender({ documentId: "document-b" }))).toEqual({
      ok: false,
    });
    expect(await runtime.handle(cancel, sender())).toEqual({ ok: true });
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "cancelled", cause: "page-cancelled" }),
    );
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
    runtime.settingsChanged();
    expect(await Promise.all([...pending, other])).toEqual(
      Array.from({ length: 5 }, () => ({ kind: "cancelled" })),
    );
  });

  it("cancels every in-flight operation on a settings change", async () => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(slowSign(), { extensionId, report });
    const pending = [runtime.handle(get(), sender()), runtime.handle(get(), sender())];
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.settingsChanged();
    expect(await Promise.all(pending)).toEqual([{ kind: "cancelled" }, { kind: "cancelled" }]);
    expect(report).toHaveBeenCalledTimes(2);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "cancelled", cause: "settings-changed" }),
    );
  });

  it("names the step that threw when it delegates", async () => {
    const report = vi.fn();
    const backing = source({ sign: vi.fn(async () => Promise.reject(new Error("unavailable"))) });
    const runtime = createPasskeyRuntime(backing, { extensionId, report });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: "assertion-failed", cause: "signing" }),
      ),
    );
    vi.mocked(backing.candidates).mockRejectedValueOnce(new Error("vault-unavailable"));
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: "assertion-failed", cause: "passkey-lookup" }),
      ),
    );

    const lookup = vi.fn();
    const passkeys = source();
    const failing = createPasskeyRuntime(passkeys, {
      extensionId,
      report: lookup,
      loginAccount: async () => Promise.reject(new Error("unavailable")),
    });
    expect(await failing.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    // Never the site's default passkey in place of the login's account.
    expect(passkeys.sign).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(lookup).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: "assertion-failed", cause: "account-lookup" }),
      ),
    );
    // A login lookup that fails leaves the flag out; the report is still sent.
    expect(lookup.mock.lastCall![0]).not.toHaveProperty("duringLogin");
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

describe("passkey runtime required mediation", () => {
  it("answers a page's required-mediation request with Pateat's assertion (ADR 0007)", async () => {
    // As Wise's "Log back in" asks: `navigator.credentials.get({ mediation: "required", ... })`.
    const snapshot = snapshotGetOptions({
      mediation: "required",
      publicKey: {
        challenge: Uint8Array.from({ length: 16 }, (_, index) => index),
        rpId: "example.com",
        userVerification: "required",
        allowCredentials: [{ type: "public-key", id: Uint8Array.of(1, 2, 3) }],
      },
    });
    expect(snapshot).toMatchObject({ mediation: "required" });
    const backing = source();
    const report = vi.fn();
    const answered = vi.fn();
    const runtime = createPasskeyRuntime(backing, { extensionId, report, answered });
    const result = await runtime.handle({ ...get(), request: snapshot }, sender());
    expect(result).toMatchObject({ kind: "assertion", assertion: { credentialId: "AQID" } });
    expect(backing.candidates).toHaveBeenCalledWith(origin, "example.com", expect.any(AbortSignal));
    expect(backing.sign).toHaveBeenCalledOnce();
    expect(answered.mock.calls).toEqual([[7, origin, "example.com", candidate]]);
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    expect(report.mock.lastCall![0]).toMatchObject({
      outcome: "assertion",
      mediation: "required",
    });
    expect(report.mock.lastCall![0]).not.toHaveProperty("reason");
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
    // A delegation is reported after the reply.
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith({
        tabId: 7,
        origin,
        outcome: "delegate",
        reason: "unsupported-mediation",
        mediation: "conditional",
      }),
    );
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

  it("reports which member of an invalid request broke its bounds, without its value", async () => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(source(), { extensionId, report });
    const oversized = btoa("x".repeat(4097)).replace(/=+$/u, "");
    expect(
      await runtime.handle({ ...get(), request: { ...request, challenge: oversized } }, sender()),
    ).toEqual({ kind: "delegate", reason: "invalid-request" });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith({
        tabId: 7,
        origin,
        outcome: "delegate",
        reason: "invalid-request",
        invalid: "challenge",
        invalidLength: 4097,
      }),
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain(oversized.slice(0, 16));
    // Another delegation names no invalid member.
    await runtime.handle({ ...get(), request: { ...request, mediation: "silent" } }, sender());
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(report.mock.lastCall![0]).not.toHaveProperty("invalid");
    expect(report.mock.lastCall![0]).not.toHaveProperty("invalidLength");
  });

  it.each([
    ["conditional", "conditional"],
    ["silent", "silent"],
    ["immediate", "immediate"],
    ["made-up", "other"],
  ])("reports a %s request delegated while the tab's login runs", async (mediation, reported) => {
    // Another provider, such as the Bitwarden extension, may show its prompt then.
    const report = vi.fn();
    let login: { connectionId: string; itemId: string } | undefined = {
      connectionId: "synthetic-connection",
      itemId: "synthetic-item",
    };
    const runtime = createPasskeyRuntime(source(), {
      extensionId,
      report,
      loginAccount: async () => login,
    });
    const delegated = {
      ...get(),
      request: { ...request, mediation },
    };
    expect(await runtime.handle(delegated, sender())).toEqual({
      kind: "delegate",
      reason: "unsupported-mediation",
    });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith({
        tabId: 7,
        origin,
        outcome: "delegate",
        reason: "unsupported-mediation",
        mediation: reported,
        duringLogin: true,
      }),
    );
    login = undefined;
    await runtime.handle(delegated, sender());
    await vi.waitFor(() => expect(report).toHaveBeenCalledTimes(2));
    expect(report.mock.lastCall![0]).not.toHaveProperty("duringLogin");
  });

  it("tells a login of each request outside conditional mediation, from a top frame only", async () => {
    const requested = vi.fn(() => {
      throw new Error("a failing listener changes nothing");
    });
    const runtime = createPasskeyRuntime(source(), { extensionId, requested });
    await runtime.handle({ ...get(), request: { ...request, mediation: "conditional" } }, sender());
    await runtime.handle(get(), sender({ frameId: 3 }));
    expect(requested).not.toHaveBeenCalled();
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    // A delegated request counts too: the page still asked.
    expect(
      await runtime.handle({ ...get(), request: { ...request, mediation: "silent" } }, sender()),
    ).toEqual({ kind: "delegate", reason: "unsupported-mediation" });
    expect(requested.mock.calls).toEqual([
      [7, origin],
      [7, origin],
    ]);
  });

  it("tells a login of each assertion it returns, with its RP ID and passkey", async () => {
    const answered = vi.fn(() => {
      throw new Error("a failing listener changes nothing");
    });
    const runtime = createPasskeyRuntime(source(), { extensionId, answered });
    // A delegated request returns nothing from Pateat.
    expect(
      await runtime.handle({ ...get(), request: { ...request, mediation: "silent" } }, sender()),
    ).toEqual({ kind: "delegate", reason: "unsupported-mediation" });
    expect(answered).not.toHaveBeenCalled();
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(answered.mock.calls).toEqual([[7, origin, "example.com", candidate]]);
  });

  it("reports no request from an invalid sender or a cancellation", async () => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(source(), { extensionId, report });
    await runtime.handle(get(), sender({ frameId: 3 }));
    await runtime.handle(
      { version: 1, type: "passkey.cancel", operationId: crypto.randomUUID() },
      sender(),
    );
    // Delegation reports are sent after the answer, so let them run first.
    await new Promise((resolve) => setTimeout(resolve, 0));
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
      again: false,
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

  it("opens no window in incognito, unfocused or prerendered, or with fewer than two signable passkeys", async () => {
    const choose = chooser(async () => ({ kind: "closed" }));
    const runtime = createPasskeyRuntime(several(), { extensionId, chooser: choose });
    const ambiguous = { kind: "delegate", reason: "ambiguous-credential" };
    expect(await runtime.handle(get(), sender({ tab: { id: 7, incognito: true } }))).toEqual(
      ambiguous,
    );
    expect(await runtime.handle(get(undefined, true, false), sender())).toEqual(ambiguous);
    expect(await runtime.handle(get(), sender({ documentLifecycle: "prerender" }))).toEqual(
      ambiguous,
    );
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

  it("closes the window when the page cancels", async () => {
    const signals: AbortSignal[] = [];
    const choose = chooser(
      (input) =>
        new Promise<PasskeyChoice>(() => {
          signals.push(input.signal);
        }),
    );
    const report = vi.fn();
    const runtime = createPasskeyRuntime(several(), { extensionId, chooser: choose, report });
    const operationId = crypto.randomUUID();
    const pending = runtime.handle(get(operationId), sender());
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    await runtime.handle({ version: 1, type: "passkey.cancel", operationId }, sender());
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(signals[0]!.aborted).toBe(true);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "cancelled",
        chooser: "cancelled",
        cause: "page-cancelled",
      }),
    );
  });

  it("keeps the window open when settings change, and signs if the choice is still offered", async () => {
    let choose!: (choice: PasskeyChoice) => void;
    const signals: AbortSignal[] = [];
    const backing = several();
    const remember = vi.fn(async () => {});
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      remember,
      chooser: chooser((input) => {
        signals.push(input.signal);
        return new Promise<PasskeyChoice>((resolve) => (choose = resolve));
      }),
    });
    const pending = runtime.handle(get(), sender());
    await vi.waitFor(() => expect(signals).toHaveLength(1));
    runtime.settingsChanged();
    expect(signals[0]!.aborted).toBe(false);
    // The new settings already make the chosen passkey the site default.
    const current = { ...pair[1]!, preferred: true, display: { item: "Looked up again" } };
    let lookedUp!: () => void;
    vi.mocked(backing.candidates).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          lookedUp = () => resolve({ candidates: [pair[0]!, current], complete: true });
        }),
    );
    choose({ kind: "chosen", index: 1, makeDefault: true });
    await vi.waitFor(() => expect(lookedUp).toBeDefined());
    // Another change while the choice is looked up does not cancel it either.
    runtime.settingsChanged();
    lookedUp();
    expect(await pending).toMatchObject({ kind: "assertion", assertion: { credentialId: "BAUG" } });
    expect(backing.sign).toHaveBeenCalledWith(
      current,
      expect.anything(),
      expect.anything(),
      expect.any(AbortSignal),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remember).not.toHaveBeenCalled();
  });

  it("tries a failed lookup or signing after a choice once more", async () => {
    const backing = several();
    vi.mocked(backing.sign).mockRejectedValueOnce(new Error("passkey-stale"));
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: chooser(async () => ({ kind: "chosen", index: 0, makeDefault: false })),
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(backing.candidates).toHaveBeenCalledTimes(3);
    expect(backing.sign).toHaveBeenCalledTimes(2);

    // A lookup that throws is tried again too.
    vi.mocked(backing.candidates)
      .mockResolvedValueOnce({ candidates: pair, complete: true })
      .mockRejectedValueOnce(new Error("vault-unavailable"));
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(backing.candidates).toHaveBeenCalledTimes(6);
    expect(backing.sign).toHaveBeenCalledTimes(3);

    // A lookup that could not search the whole vault says so.
    vi.mocked(backing.candidates)
      .mockResolvedValueOnce({ candidates: pair, complete: true })
      .mockResolvedValueOnce({ candidates: [], complete: false });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "vault-incomplete",
    });

    vi.mocked(backing.sign).mockRejectedValue(new Error("passkey-unavailable"));
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    expect(backing.sign).toHaveBeenCalledTimes(5);
  });

  it("delegates a choice the changed settings no longer offer", async () => {
    const answers: ((choice: PasskeyChoice) => void)[] = [];
    const backing = several();
    const remember = vi.fn(async () => {});
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      remember,
      chooser: chooser(() => new Promise<PasskeyChoice>((resolve) => answers.push(resolve))),
    });
    const excluded = runtime.handle(get(), sender());
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    runtime.settingsChanged();
    // The site is now excluded.
    vi.mocked(backing.candidates).mockResolvedValueOnce(undefined);
    answers[0]!({ kind: "chosen", index: 0, makeDefault: true });
    expect(await excluded).toEqual({ kind: "delegate", reason: "settings-changed" });

    // Settings can also change without a sync, for example when another tab's login saves
    // a choice; the lookup after the choice catches that too.
    const removed = runtime.handle(get(), sender());
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    // The chosen passkey's item was removed from the vault or the settings.
    vi.mocked(backing.candidates).mockResolvedValueOnce({ candidates: [pair[0]!], complete: true });
    answers[1]!({ kind: "chosen", index: 1, makeDefault: false });
    expect(await removed).toEqual({ kind: "delegate", reason: "settings-changed" });
    expect(backing.sign).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remember).not.toHaveBeenCalled();
  });

  it("waits past the lookup budget up to the caller's timeout, then fails", async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const report = vi.fn();
      const runtime = createPasskeyRuntime(several(), {
        extensionId,
        report,
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
      // As with the browser's own prompt, an unanswered window fails the request (ADR 0021).
      expect(settled).toEqual({ kind: "not-allowed" });
      expect(signals[0]!.aborted).toBe(true);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({ outcome: "not-allowed", chooser: "timeout" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the window when little of the wait is left, and gives signing its own budget", async () => {
    // Only the runtime's timers are fake; hashing and polling run on real time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    // Polls on the real clock, which the fake timers leave alone, so a slow runner's hashing
    // gets as long as it needs instead of a fixed number of turns.
    const until = async (condition: () => boolean) => {
      const deadline = performance.now() + 10_000;
      while (!condition() && performance.now() < deadline)
        // eslint-disable-next-line no-await-in-loop
        await tick();
      expect(condition()).toBe(true);
    };
    try {
      let lookedUp!: (value: PasskeyCandidates) => void;
      const slowLookup = several({
        candidates: vi.fn(() => new Promise<PasskeyCandidates>((resolve) => (lookedUp = resolve))),
      });
      const unused = chooser(async () => ({ kind: "closed" }));
      const late = createPasskeyRuntime(slowLookup, { extensionId, chooser: unused });
      const skipped = late.handle({ ...get(), request: { ...request, timeout: 10_000 } }, sender());
      await until(() => lookedUp !== undefined);
      await vi.advanceTimersByTimeAsync(6_000);
      lookedUp({ candidates: pair, complete: true });
      expect(await skipped).toEqual({ kind: "delegate", reason: "ambiguous-credential" });
      expect(unused.choose).not.toHaveBeenCalled();

      // Chosen 0.5 s before the chooser's deadline; signing still has its own 10 s.
      let choose!: (choice: PasskeyChoice) => void;
      let signed!: (signature: Uint8Array) => void;
      const signing = several({
        sign: vi.fn(() => new Promise<Uint8Array>((resolve) => (signed = resolve))),
      });
      const runtime = createPasskeyRuntime(signing, {
        extensionId,
        chooser: chooser(() => new Promise<PasskeyChoice>((resolve) => (choose = resolve))),
      });
      const answer = runtime.handle(
        { ...get(), request: { ...request, timeout: 10_000 } },
        sender(),
      );
      await until(() => choose !== undefined);
      await vi.advanceTimersByTimeAsync(9_500);
      choose({ kind: "chosen", index: 0, makeDefault: false });
      await until(() => signed !== undefined);
      await vi.advanceTimersByTimeAsync(1_000);
      signed(Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01));
      expect(await answer).toMatchObject({ kind: "assertion" });
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

describe("passkey requests during a login (ADR 0027)", () => {
  const loginItem = { connectionId: "personal", itemId: "login-item" };
  type Stored = (typeof candidate & { preferred?: boolean }) & { item: string };
  const siteDefault: Stored = {
    ...candidate,
    credentialId: "BBBB",
    preferred: true,
    item: "default-item",
  };
  const ofLogin: Stored = { ...candidate, credentialId: "CCCC", item: "login-item" };
  /** A vault of several items: with `only`, just that item's passkeys, none preferred. */
  const vault = (stored: Stored[], complete = true) =>
    source({
      candidates: vi.fn(async (_origin: string, _rpId: string, _signal, only?: PasskeyItem) => ({
        candidates: only
          ? stored
              .filter((entry) => entry.item === only.itemId)
              .map(({ preferred: _preferred, ...entry }) => entry)
          : stored,
        complete,
      })),
    });
  const chooser = () => ({
    choose: vi.fn(async (): Promise<PasskeyChoice> => ({ kind: "closed" })),
  });

  it("signs with the login's item even when the site default is another item", async () => {
    const backing = vault([siteDefault, ofLogin]);
    const loginAccount = vi.fn(() => loginItem);
    const remember = vi.fn(async () => {});
    const runtime = createPasskeyRuntime(backing, { extensionId, loginAccount, remember });
    expect(await runtime.handle(get(), sender())).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "CCCC" },
    });
    expect(loginAccount).toHaveBeenCalledWith(7, origin);
    expect(backing.candidates).toHaveBeenCalledWith(
      origin,
      "example.com",
      expect.any(AbortSignal),
      loginItem,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remember).not.toHaveBeenCalled();
  });

  it("opens no chooser while a login runs, whatever the vault holds", async () => {
    const choose = chooser();
    const other: Stored = { ...candidate, credentialId: "DDDD", item: "other-item" };
    // Without the login, two items would make a choice; with it, its item answers alone.
    const several = createPasskeyRuntime(vault([other, ofLogin]), {
      extensionId,
      chooser: choose,
      loginAccount: async () => loginItem,
    });
    expect(await several.handle(get(), sender())).toMatchObject({
      assertion: { credentialId: "CCCC" },
    });
    // Two passkeys of the login's own item are never offered as a choice.
    const twice = createPasskeyRuntime(vault([ofLogin, { ...ofLogin, credentialId: "EEEE" }]), {
      extensionId,
      chooser: choose,
      loginAccount: async () => loginItem,
    });
    expect(await twice.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "login-item-ambiguous-credential",
    });
    expect(choose.choose).not.toHaveBeenCalled();
  });

  it.each<[string, Stored[], boolean, string]>([
    ["the login's item has no passkey", [siteDefault], true, "login-item-no-credential"],
    ["the item's search is incomplete", [ofLogin], false, "login-item-vault-incomplete"],
    [
      "the item's passkey has a counter",
      [{ ...ofLogin, counter: 5 }],
      true,
      "login-item-unsupported-counter",
    ],
  ])("delegates to the browser when %s", async (_label, stored, complete, reason) => {
    const backing = vault(stored, complete);
    const choose = chooser();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: choose,
      loginAccount: () => loginItem,
    });
    expect(await runtime.handle(get(), sender())).toEqual({ kind: "delegate", reason });
    expect(backing.sign).not.toHaveBeenCalled();
    expect(choose.choose).not.toHaveBeenCalled();
  });

  it("delegates when the login lookup fails", async () => {
    const backing = vault([siteDefault, ofLogin]);
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      loginAccount: async () => {
        throw new Error("storage unavailable");
      },
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "delegate" });
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it("answers as before once the login has ended", async () => {
    const backing = vault([siteDefault, ofLogin]);
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      loginAccount: async () => undefined,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "BBBB" },
    });
    expect(backing.candidates).toHaveBeenCalledWith(origin, "example.com", expect.any(AbortSignal));
    const choose = chooser();
    const other: Stored = { ...candidate, credentialId: "DDDD", item: "other-item" };
    const ended = createPasskeyRuntime(vault([other, ofLogin]), {
      extensionId,
      chooser: choose,
      loginAccount: () => undefined,
    });
    expect(await ended.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "chooser-closed",
    });
    expect(choose.choose).toHaveBeenCalledTimes(1);
  });
});

describe("asking again after Pateat signed in a tab", () => {
  /** An in-memory record of where Pateat signed. */
  const signedTabs = (...signed: Array<[number, string]>) => {
    const entries = new Set(signed.map(([tabId, rpId]) => `${tabId} ${rpId}`));
    return {
      entries,
      has: vi.fn<SignedTabs["has"]>(async (tabId, rpId) => entries.has(`${tabId} ${rpId}`)),
      add: vi.fn<SignedTabs["add"]>(async (tabId, rpId) => {
        entries.add(`${tabId} ${rpId}`);
      }),
      replaced: vi.fn<SignedTabs["replaced"]>(async () => undefined),
    } satisfies SignedTabs & { entries: Set<string> };
  };
  const chosen = (index = 0, makeDefault = false) => ({
    choose: vi.fn<PasskeyChooser["choose"]>(async () => ({ kind: "chosen", index, makeDefault })),
  });
  const withDefault = [
    { ...candidate, credentialId: "BAUG", display: { item: "Home" } },
    { ...candidate, preferred: true, display: { item: "Work" } },
  ];
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("asks for a single match after a logout clicked on the site in the tab", async () => {
    const choose = chosen();
    const report = vi.fn();
    const logoutClicked = vi.fn(
      async (tabId: number, rpId: string) => tabId === 7 && rpId === "example.com",
    );
    const runtime = createPasskeyRuntime(source(), {
      extensionId,
      chooser: choose,
      signedTabs: signedTabs(),
      logoutClicked,
      report,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(choose.choose).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7, again: true, loggedOut: true }),
    );
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ logoutClicked: true, chooser: "chosen" }),
    );
    expect(report.mock.lastCall?.[0]).not.toHaveProperty("signedBefore");
    // Another tab did not log out.
    expect(await runtime.handle(get(), sender({ tab: { id: 8 } }))).toMatchObject({
      kind: "assertion",
    });
    expect(choose.choose).toHaveBeenCalledOnce();
  });

  it("records the RP ID of each assertion, then asks for a single match in that tab", async () => {
    const signed = signedTabs();
    const choose = chosen();
    const report = vi.fn();
    const backing = source();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: choose,
      signedTabs: signed,
      report,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(choose.choose).not.toHaveBeenCalled();
    await tick();
    expect([...signed.entries]).toEqual(["7 example.com"]);

    expect(await runtime.handle(get(), sender())).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "AQID" },
    });
    expect(choose.choose).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 7, entries: [{ item: "Passkey 1" }], again: true }),
    );
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ signedBefore: true, chooser: "chosen" }),
    );
    // Another tab has not signed in yet.
    expect(await runtime.handle(get(), sender({ tab: { id: 8 } }))).toMatchObject({
      kind: "assertion",
    });
    expect(choose.choose).toHaveBeenCalledOnce();
  });

  it("does not ask again while a login runs in the tab (ADR 0027)", async () => {
    const signed = signedTabs([7, "example.com"]);
    const choose = chosen();
    const loginItem = { connectionId: "personal", itemId: "login-item" };
    const backing = source();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: choose,
      signedTabs: signed,
      loginAccount: async () => loginItem,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "AQID" },
    });
    expect(backing.candidates).toHaveBeenCalledWith(
      origin,
      "example.com",
      expect.any(AbortSignal),
      loginItem,
    );
    expect(choose.choose).not.toHaveBeenCalled();
  });

  it("does not record a delegated request", async () => {
    const signed = signedTabs();
    const runtime = createPasskeyRuntime(source({ candidates: vi.fn(async () => undefined) }), {
      extensionId,
      chooser: chosen(),
      signedTabs: signed,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "delegate" });
    await tick();
    expect(signed.add).not.toHaveBeenCalled();
  });

  it("lists the site default first and saves only a different passkey", async () => {
    const remember = vi.fn(async () => {});
    const backing = source({
      candidates: vi.fn(async () => ({
        candidates: withDefault,
        complete: true,
        siteDefault: "searched" as const,
      })),
    });
    const keep = chosen(0, true);
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: keep,
      remember,
      signedTabs: signedTabs([7, "example.com"]),
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({
      assertion: { credentialId: "AQID" },
    });
    expect(keep.choose).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [{ item: "Work", preferred: true }, { item: "Home" }],
        replacesDefault: true,
        again: true,
      }),
    );
    await tick();
    expect(remember).not.toHaveBeenCalled();

    const replace = createPasskeyRuntime(backing, {
      extensionId,
      chooser: chosen(1, true),
      remember,
      signedTabs: signedTabs([7, "example.com"]),
    });
    expect(await replace.handle(get(), sender())).toMatchObject({
      assertion: { credentialId: "BAUG" },
    });
    await tick();
    expect(remember).toHaveBeenCalledWith(origin, withDefault[0]);
  });

  it("hands the request to the browser when the person asks for it", async () => {
    const backing = source();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: { choose: vi.fn<PasskeyChooser["choose"]>(async () => ({ kind: "browser" })) },
      signedTabs: signedTabs([7, "example.com"]),
    });
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "chooser-browser",
    });
    expect(backing.sign).not.toHaveBeenCalled();
  });

  it("signs named credentials silently, as in a re-authentication", async () => {
    const choose = chosen();
    const runtime = createPasskeyRuntime(source(), {
      extensionId,
      chooser: choose,
      signedTabs: signedTabs([7, "example.com"]),
    });
    const named = {
      ...get(),
      request: { ...request, allowCredentials: [{ type: "public-key", id: "AQID" }] },
    };
    expect(await runtime.handle(named, sender())).toMatchObject({ kind: "assertion" });
    expect(choose.choose).not.toHaveBeenCalled();
  });

  it("never signs unasked when no window can open or the vault was not fully searched", async () => {
    const choose = chosen();
    const backing = source();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: choose,
      signedTabs: signedTabs([7, "example.com"]),
    });
    const unavailable = { kind: "delegate", reason: "chooser-unavailable" };
    expect(await runtime.handle(get(undefined, true, false), sender())).toEqual(unavailable);
    expect(await runtime.handle(get(), sender({ tab: { id: 7, incognito: true } }))).toEqual(
      unavailable,
    );
    expect(await runtime.handle(get(), sender({ documentLifecycle: "prerender" }))).toEqual(
      unavailable,
    );
    const hurried = { ...get(), request: { ...request, timeout: 1 } };
    // The vault lookup uses up the wait before the window could open.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const slow = createPasskeyRuntime(
        source({
          candidates: vi.fn(async () => {
            vi.setSystemTime(Date.now() + 9_000);
            return { candidates: [candidate], complete: true };
          }),
        }),
        { extensionId, chooser: choose, signedTabs: signedTabs([7, "example.com"]) },
      );
      expect(await slow.handle(hurried, sender())).toEqual(unavailable);
    } finally {
      vi.useRealTimers();
    }
    const incomplete = createPasskeyRuntime(
      source({
        candidates: vi.fn(async () => ({ candidates: withDefault, complete: false })),
      }),
      { extensionId, chooser: choose, signedTabs: signedTabs([7, "example.com"]) },
    );
    expect(await incomplete.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "vault-incomplete",
    });
    const none = createPasskeyRuntime(source({ candidates: vi.fn(async () => undefined) }), {
      extensionId,
      chooser: choose,
      signedTabs: signedTabs([7, "example.com"]),
    });
    expect(await none.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "not-configured",
    });
    expect(choose.choose).not.toHaveBeenCalled();
    expect(backing.sign).not.toHaveBeenCalled();
  });
});

describe("a page's own conditional request through a login (ADR 0034)", () => {
  const loginItem = { connectionId: "personal", itemId: "login-item" };
  const conditionalGet = (operationId = crypto.randomUUID()) => ({
    ...get(operationId, false),
    request: { ...request, mediation: "conditional" },
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  type Input = { tabId: number; origin: string; documentId: string; signal: AbortSignal };
  /** A login runtime whose decisions the test gives, one per waiting request. */
  function decisions() {
    const waiting: Array<{ input: Input; decide(decision: ConditionalDecision): void }> = [];
    const conditional = vi.fn(
      (input: Input) =>
        new Promise<ConditionalDecision>((resolve) => waiting.push({ input, decide: resolve })),
    );
    return { conditional, waiting };
  }
  /** A vault hold that records when it is taken and left. */
  function holds() {
    const events: string[] = [];
    const hold = vi.fn(async () => {
      events.push("hold");
      return () => void events.push("leave");
    });
    return { hold, events };
  }

  it("waits for the login's decision and hands the request on with its reason", async () => {
    const report = vi.fn();
    const requested = vi.fn();
    const backing = source();
    const { conditional, waiting } = decisions();
    const { hold, events } = holds();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      report,
      requested,
      conditional,
      hold,
    });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(waiting[0]!.input).toEqual({
      tabId: 7,
      origin,
      documentId: "document-a",
      signal: expect.any(AbortSignal),
    });
    // Nothing is read from the vault, and the vault is not held, while it waits.
    expect(backing.candidates).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    waiting[0]!.decide({ kind: "delegate", reason: "no-login" });
    expect(await pending).toEqual({ kind: "delegate", reason: "no-login" });
    expect(events).toEqual([]);
    expect(requested).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith({
        tabId: 7,
        origin,
        outcome: "delegate",
        reason: "no-login",
        rpId: "example.com",
        allowCredentials: 0,
        mediation: "conditional",
      }),
    );
  });

  it("withholds the request after the login signed in", async () => {
    const report = vi.fn();
    const { conditional, waiting } = decisions();
    const runtime = createPasskeyRuntime(source(), { extensionId, report, conditional });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    waiting[0]!.decide({ kind: "withhold" });
    expect(await pending).toEqual({ kind: "withheld" });
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "withheld", mediation: "conditional" }),
    );
    expect(report.mock.lastCall![0]).not.toHaveProperty("reason");
  });

  it("answers with the login's item, holding the vault only while it signs", async () => {
    const report = vi.fn();
    const answeredTab = vi.fn();
    const other = { ...candidate, credentialId: "BBBB", preferred: true };
    const backing = source({
      candidates: vi.fn(async (_origin: string, _rpId: string, _signal, only?: PasskeyItem) => ({
        candidates: only ? [{ ...candidate, credentialId: "CCCC" }] : [other],
        complete: true,
      })),
    });
    const { conditional, waiting } = decisions();
    const { hold, events } = holds();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      report,
      conditional,
      hold,
      answered: answeredTab,
      // The budget runs only once the login answers.
      timeoutMs: () => 50,
    });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hold).not.toHaveBeenCalled();
    const signed = vi.fn(() => void events.push("answered"));
    waiting[0]!.decide({ kind: "answer", item: loginItem, answered: signed });
    expect(await pending).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "CCCC" },
    });
    expect(signed.mock.calls).toEqual([[true]]);
    expect(backing.candidates).toHaveBeenCalledWith(
      origin,
      "example.com",
      expect.any(AbortSignal),
      loginItem,
    );
    expect(events).toEqual(["hold", "answered", "leave"]);
    // The login's item signed it.
    expect(answeredTab).toHaveBeenCalledWith(
      7,
      origin,
      "example.com",
      expect.objectContaining({ credentialId: "CCCC" }),
    );
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ outcome: "assertion", mediation: "conditional" }),
    );
  });

  it("waits for the login again when its item cannot answer, and never answers twice", async () => {
    const report = vi.fn();
    const backing = source({
      candidates: vi.fn(async () => ({ candidates: [], complete: true })),
    });
    const { conditional, waiting } = decisions();
    const { hold, events } = holds();
    const runtime = createPasskeyRuntime(backing, { extensionId, report, conditional, hold });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    const signed = vi.fn(() => void events.push("answered"));
    waiting[0]!.decide({ kind: "answer", item: loginItem, answered: signed });
    // The login falls back to its password and decides the waiting request again.
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    expect(signed.mock.calls).toEqual([[false]]);
    expect(events).toEqual(["hold", "answered", "leave"]);
    expect(waiting[1]!.input.signal).toBe(waiting[0]!.input.signal);
    expect(waiting[1]!.input.signal.aborted).toBe(false);
    waiting[1]!.decide({ kind: "withhold" });
    expect(await pending).toEqual({ kind: "withheld" });
    expect(events).toEqual(["hold", "answered", "leave"]);
    expect(backing.sign).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "withheld",
        answerFailed: "login-item-no-credential",
        mediation: "conditional",
      }),
    );
  });

  it("tells the login of a failed signing, and of a timeout once it answers", async () => {
    const failing = source({ sign: vi.fn(async () => Promise.reject(new Error("unavailable"))) });
    const { conditional, waiting } = decisions();
    const report = vi.fn();
    const runtime = createPasskeyRuntime(failing, { extensionId, conditional, report });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    const signed = vi.fn();
    waiting[0]!.decide({ kind: "answer", item: loginItem, answered: signed });
    await vi.waitFor(() => expect(waiting).toHaveLength(2));
    expect(signed.mock.calls).toEqual([[false]]);
    waiting[1]!.decide({ kind: "delegate", reason: "login-ended" });
    expect(await pending).toEqual({ kind: "delegate", reason: "login-ended" });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ answerFailed: "assertion-failed", cause: "signing" }),
      ),
    );

    const slow = source({
      sign: vi.fn(
        (_candidate, _data, _hash, signal: AbortSignal) =>
          new Promise<Uint8Array>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    });
    const timed = decisions();
    const { hold, events } = holds();
    const bounded = createPasskeyRuntime(slow, {
      extensionId,
      conditional: timed.conditional,
      hold,
      timeoutMs: () => 20,
    });
    const answering = bounded.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(timed.waiting).toHaveLength(1));
    const late = vi.fn();
    timed.waiting[0]!.decide({ kind: "answer", item: loginItem, answered: late });
    expect(await answering).toEqual({ kind: "delegate", reason: "timeout" });
    expect(late.mock.calls).toEqual([[false]]);
    expect(timed.waiting).toHaveLength(1);
    expect(events).toEqual(["hold", "leave"]);
  });

  it("is not cancelled by a settings change while it waits", async () => {
    const { conditional, waiting } = decisions();
    const runtime = createPasskeyRuntime(source(), { extensionId, conditional });
    const pending = runtime.handle(conditionalGet(), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    runtime.settingsChanged();
    await tick();
    expect(waiting[0]!.input.signal.aborted).toBe(false);
    const signed = vi.fn();
    waiting[0]!.decide({ kind: "answer", item: loginItem, answered: signed });
    expect(await pending).toMatchObject({ kind: "assertion" });
    expect(signed.mock.calls).toEqual([[true]]);
  });

  it("ends when the page cancels it while it waits, without holding the vault", async () => {
    const report = vi.fn();
    const { conditional, waiting } = decisions();
    const { hold } = holds();
    const runtime = createPasskeyRuntime(source(), { extensionId, report, conditional, hold });
    const operationId = crypto.randomUUID();
    const pending = runtime.handle(conditionalGet(operationId), sender());
    await vi.waitFor(() => expect(waiting).toHaveLength(1));
    expect(
      await runtime.handle({ version: 1, type: "passkey.cancel", operationId }, sender()),
    ).toEqual({ ok: true });
    expect(await pending).toEqual({ kind: "cancelled" });
    expect(waiting[0]!.input.signal.aborted).toBe(true);
    // A decision after the cancellation changes nothing.
    const signed = vi.fn();
    waiting[0]!.decide({ kind: "answer", item: loginItem, answered: signed });
    await tick();
    expect(signed).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: "cancelled",
        cause: "page-cancelled",
        mediation: "conditional",
      }),
    );
  });

  it("delegates when the login's decision throws, naming the wait", async () => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(source(), {
      extensionId,
      report,
      conditional: async () => Promise.reject(new Error("storage unavailable")),
    });
    expect(await runtime.handle(conditionalGet(), sender())).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    await vi.waitFor(() =>
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ reason: "assertion-failed", cause: "login-wait" }),
      ),
    );
  });

  it("holds the vault while it answers any other request, and leaves a late hold", async () => {
    const { hold, events } = holds();
    const backing = source({
      candidates: vi.fn(async () => {
        events.push("lookup");
        return { candidates: [candidate], complete: true };
      }),
    });
    const runtime = createPasskeyRuntime(backing, { extensionId, hold });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(events).toEqual(["hold", "lookup", "leave"]);

    // A hold that comes only after the page cancelled is left at once.
    let enter!: (leave: () => void) => void;
    const leave = vi.fn();
    const slowHold = vi.fn(() => new Promise<() => void>((resolve) => (enter = resolve)));
    const waiting = createPasskeyRuntime(source(), { extensionId, hold: slowHold });
    const operationId = crypto.randomUUID();
    const pending = waiting.handle(get(operationId), sender());
    await vi.waitFor(() => expect(slowHold).toHaveBeenCalledOnce());
    await waiting.handle({ version: 1, type: "passkey.cancel", operationId }, sender());
    expect(await pending).toEqual({ kind: "cancelled" });
    enter(leave);
    await vi.waitFor(() => expect(leave).toHaveBeenCalledOnce());
  });

  it.each<[string, unknown, string | undefined]>([
    ["optional", "optional", "optional"],
    ["required", "required", "required"],
    ["no", undefined, undefined],
    ["an unknown", "made-up", "other"],
  ])("reports %s mediation on an answered request", async (_label, mediation, reported) => {
    const report = vi.fn();
    const runtime = createPasskeyRuntime(source(), {
      extensionId,
      report,
      conditional: decisions().conditional,
    });
    const asked = {
      ...get(),
      request: mediation === undefined ? request : { ...request, mediation },
    };
    const result = await runtime.handle(asked, sender());
    await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
    if (reported === "other") {
      expect(result).toEqual({ kind: "delegate", reason: "unsupported-mediation" });
      expect(report.mock.lastCall![0]).toMatchObject({ mediation: "other" });
    } else {
      expect(result).toMatchObject({ kind: "assertion" });
      if (reported) expect(report.mock.lastCall![0]).toMatchObject({ mediation: reported });
      else expect(report.mock.lastCall![0]).not.toHaveProperty("mediation");
    }
  });
});

describe("Immediate UI stored-passkey runtime", () => {
  afterEach(() => vi.useRealTimers());
  const immediate = (overrides: Record<string, unknown> = {}) => ({
    ...get(),
    request: { ...request, uiMode: "immediate" },
    ...overrides,
  });
  it("answers a unique stored passkey without showing a chooser", async () => {
    const backing = source();
    const choose = vi.fn<PasskeyChooser["choose"]>();
    const runtime = createPasskeyRuntime(backing, { extensionId, chooser: { choose } });
    expect(await runtime.handle(immediate(), sender())).toMatchObject({ kind: "assertion" });
    expect(backing.sign).toHaveBeenCalledOnce();
    expect(choose).not.toHaveBeenCalled();
  });
  it.each([
    ["without activation", { userActivation: false }, {}],
    ["without focus", { focused: false }, {}],
    ["in an inactive document", {}, { documentLifecycle: "cached" }],
    ["in incognito", {}, { tab: { id: 7, incognito: true } }],
  ])("delegates %s before reading the vault", async (_, message, context) => {
    const backing = source();
    const runtime = createPasskeyRuntime(backing, { extensionId });
    expect(await runtime.handle(immediate(message), sender(context))).toMatchObject({
      kind: "delegate",
    });
    expect(backing.candidates).not.toHaveBeenCalled();
    expect(backing.sign).not.toHaveBeenCalled();
  });
  it("delegates ambiguous credentials without a chooser", async () => {
    const backing = source({
      candidates: vi.fn(async () => ({
        candidates: [candidate, { ...candidate, credentialId: "BAUG" }],
        complete: true,
      })),
    });
    const choose = vi.fn<PasskeyChooser["choose"]>();
    const runtime = createPasskeyRuntime(backing, { extensionId, chooser: { choose } });
    expect(await runtime.handle(immediate(), sender())).toEqual({
      kind: "delegate",
      reason: "ambiguous-credential",
    });
    expect(choose).not.toHaveBeenCalled();
    expect(backing.sign).not.toHaveBeenCalled();
  });
  it("delegates after an earlier sign-in even without a chooser", async () => {
    const backing = source();
    const signedTabs = { has: vi.fn(async () => true), add: vi.fn(async () => undefined) };
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      signedTabs: signedTabs as unknown as SignedTabs,
    });
    expect(await runtime.handle(immediate(), sender())).toEqual({
      kind: "delegate",
      reason: "immediate-account-choice",
    });
    expect(backing.sign).not.toHaveBeenCalled();
  });
  it("bounds a pending login-account lookup to one second", async () => {
    vi.useFakeTimers();
    const backing = source();
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      loginAccount: () => new Promise<PasskeyItem | undefined>(() => undefined),
    });
    const pending = runtime.handle(immediate(), sender());
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ kind: "delegate", reason: "timeout" });
    expect(backing.candidates).not.toHaveBeenCalled();
  });
  it("discards a signature arriving after the one-second budget", async () => {
    vi.useFakeTimers();
    let finish!: (value: Uint8Array) => void;
    const backing = source({
      sign: vi.fn(
        () =>
          new Promise<Uint8Array>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const answered = vi.fn();
    const runtime = createPasskeyRuntime(backing, { extensionId, answered });
    const pending = runtime.handle(immediate(), sender());
    await vi.waitUntil(() => backing.sign.mock.calls.length === 1);
    expect(backing.sign).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await pending).toEqual({ kind: "delegate", reason: "timeout" });
    finish(Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01));
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).not.toHaveBeenCalled();
  });
});
