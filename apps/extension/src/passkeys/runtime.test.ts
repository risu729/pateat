import { describe, expect, it, vi } from "vitest";
import {
  chooserWaitMs,
  createPasskeyRuntime,
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
    runtime.settingsChanged();
    expect(await Promise.all([...pending, other])).toEqual(
      Array.from({ length: 5 }, () => ({ kind: "cancelled" })),
    );
  });

  it("cancels every in-flight operation on a settings change", async () => {
    const runtime = createPasskeyRuntime(slowSign(), { extensionId });
    const pending = [runtime.handle(get(), sender()), runtime.handle(get(), sender())];
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.settingsChanged();
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
      expect.objectContaining({ outcome: "cancelled", chooser: "cancelled" }),
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

  it("tries a failed signing after a choice once more", async () => {
    const backing = several();
    vi.mocked(backing.sign).mockRejectedValueOnce(new Error("passkey-stale"));
    const runtime = createPasskeyRuntime(backing, {
      extensionId,
      chooser: chooser(async () => ({ kind: "chosen", index: 0, makeDefault: false })),
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(backing.candidates).toHaveBeenCalledTimes(3);
    expect(backing.sign).toHaveBeenCalledTimes(2);

    vi.mocked(backing.sign).mockRejectedValue(new Error("passkey-unavailable"));
    expect(await runtime.handle(get(), sender())).toEqual({
      kind: "delegate",
      reason: "assertion-failed",
    });
    expect(backing.sign).toHaveBeenCalledTimes(4);
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
