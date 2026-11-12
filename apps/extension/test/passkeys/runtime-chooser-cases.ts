import { expect, it, type Mock, vi } from "vitest";
import {
  chooserWaitMs,
  createPasskeyRuntime,
  type PasskeyChoice,
  type PasskeyChooser,
  type PasskeySource,
} from "../../src/passkeys/runtime";
import type { PasskeyCandidates } from "../../src/passkeys/select";
import { CHOOSER_MAX_WAIT_MS, CHOOSER_MIN_WAIT_MS } from "../../src/passkeys/wire";
import type { RuntimeFixtures } from "./runtime-context";

type ChooserCandidate = RuntimeFixtures["candidate"] & {
  preferred?: boolean;
  display?: { item: string; userName: string; account: string };
};

export function registerChooserAnswerCases({
  extensionId,
  origin,
  sender,
  get,
  pair,
  several,
  chooser,
}: Pick<RuntimeFixtures, "extensionId" | "origin" | "sender" | "get"> & {
  pair: ChooserCandidate[];
  several: (
    overrides?: Partial<PasskeySource>,
    siteDefault?: "searched" | "unset",
  ) => PasskeySource;
  chooser: (answer: PasskeyChooser["choose"]) => { choose: Mock<PasskeyChooser["choose"]> };
}) {
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
}

export function registerRepromptCases({
  extensionId,
  sender,
  get,
  chooser,
  guarded,
  one,
}: Pick<RuntimeFixtures, "extensionId" | "sender" | "get"> & {
  chooser: (answer: PasskeyChooser["choose"]) => { choose: Mock<PasskeyChooser["choose"]> };
  guarded: RuntimeFixtures["candidate"] & { reprompt: boolean; display: { item: string } };
  one: (overrides?: Partial<PasskeySource>) => PasskeySource;
}) {
  it("signs with a re-prompt passkey only after its master password is checked", async () => {
    const verifyMasterPassword = vi.fn(
      async (_entry: unknown, password: string) => password === "right",
    );
    const backing = one({ verifyMasterPassword });
    const choose = chooser(async (input) => {
      expect(await input.verify!(0, "wrong")).toBe(false);
      expect(await input.verify!(0, "right")).toBe(true);
      return { kind: "chosen", index: 0, makeDefault: false };
    });
    const runtime = createPasskeyRuntime(backing, { extensionId, chooser: choose });
    expect(await runtime.handle(get(), sender())).toMatchObject({
      kind: "assertion",
      assertion: { credentialId: "AQID" },
    });
    expect(choose.choose).toHaveBeenCalledWith(
      expect.objectContaining({ entries: [{ item: "Bank", reprompt: true }] }),
    );
    expect(verifyMasterPassword).toHaveBeenCalledWith(guarded, "right");
    expect(backing.sign).toHaveBeenCalledOnce();
  });

  it("never signs a re-prompt passkey when the window is closed or cannot check", async () => {
    const closed = one({ verifyMasterPassword: vi.fn(async () => true) });
    expect(
      await createPasskeyRuntime(closed, {
        extensionId,
        chooser: chooser(async () => ({ kind: "closed" })),
      }).handle(get(), sender()),
    ).toEqual({ kind: "delegate", reason: "chooser-closed" });
    expect(closed.sign).not.toHaveBeenCalled();
    const unchecked = one();
    const choose = chooser(async () => ({ kind: "chosen", index: 0, makeDefault: false }));
    expect(
      await createPasskeyRuntime(unchecked, { extensionId, chooser: choose }).handle(
        get(),
        sender(),
      ),
    ).toEqual({ kind: "delegate", reason: "master-password-reprompt" });
    expect(choose.choose).not.toHaveBeenCalled();
    expect(unchecked.sign).not.toHaveBeenCalled();
    // Nor in a tab that cannot show the window.
    const unfocused = one({ verifyMasterPassword: vi.fn(async () => true) });
    expect(
      await createPasskeyRuntime(unfocused, { extensionId, chooser: choose }).handle(
        get(crypto.randomUUID(), true, false),
        sender(),
      ),
    ).toEqual({ kind: "delegate", reason: "master-password-reprompt" });
    expect(unfocused.sign).not.toHaveBeenCalled();
  });
}

export function registerChooserDelegationCases({
  extensionId,
  sender,
  get,
  source,
  pair,
  several,
  chooser,
}: Pick<RuntimeFixtures, "extensionId" | "sender" | "get" | "source"> & {
  pair: ChooserCandidate[];
  several: (
    overrides?: Partial<PasskeySource>,
    siteDefault?: "searched" | "unset",
  ) => PasskeySource;
  chooser: (answer: PasskeyChooser["choose"]) => { choose: Mock<PasskeyChooser["choose"]> };
}) {
  it("does not save a one-time choice", async () => {
    const remember = vi.fn(async () => {});
    const answered = vi.fn();
    const runtime = createPasskeyRuntime(several(), {
      extensionId,
      chooser: chooser(async () => ({ kind: "chosen", index: 0, makeDefault: false })),
      remember,
      answered,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({
      assertion: { credentialId: "AQID" },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(remember).not.toHaveBeenCalled();
    // The person chose it, so it is no sign-in Pateat made by itself (ADR 0062 C).
    expect(answered.mock.lastCall?.[4]).toEqual({ incognito: false, documentId: "document-a" });
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
}

export function registerUnsetDefaultCases({
  extensionId,
  origin,
  sender,
  request,
  get,
  pair,
  chooser,
  withDefault,
}: Pick<RuntimeFixtures, "extensionId" | "origin" | "sender" | "request" | "get"> & {
  pair: ChooserCandidate[];
  chooser: (answer: PasskeyChooser["choose"]) => { choose: Mock<PasskeyChooser["choose"]> };
  withDefault: (items?: ChooserCandidate[]) => PasskeySource;
}) {
  it("opens the chooser with no default preselected, also for one passkey", async () => {
    const choose = chooser(async () => ({ kind: "chosen", index: 0, makeDefault: false }));
    const defaultUnset = vi.fn(async () => true);
    const report = vi.fn();
    const runtime = createPasskeyRuntime(withDefault(), {
      extensionId,
      chooser: choose,
      defaultUnset,
      report,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(defaultUnset).toHaveBeenCalledWith(origin, false);
    expect(choose.choose.mock.calls[0]![0].entries).toEqual([
      { item: "Work", userName: "alice", account: "Personal" },
      { item: "Passkey 2" },
    ]);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ defaultUnset: true, chooser: "chosen" }),
    );
    // One passkey, which would sign without asking, asks as well.
    const single = createPasskeyRuntime(withDefault([{ ...pair[0]!, preferred: true }]), {
      extensionId,
      chooser: choose,
      defaultUnset,
    });
    expect(await single.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(choose.choose).toHaveBeenCalledTimes(2);
    expect(choose.choose.mock.calls[1]![0].entries).toEqual([
      { item: "Work", userName: "alice", account: "Personal" },
    ]);
  });

  it("reads whether the default counts as unset alongside the lookup, so the deadline runs as without it", async () => {
    const backing = withDefault();
    const lookup = Promise.withResolvers<void>();
    const candidates = backing.candidates;
    backing.candidates = vi.fn(async (...args: Parameters<PasskeySource["candidates"]>) => {
      await lookup.promise;
      return candidates(...args);
    });
    const defaultUnset = vi.fn(async () => false);
    const runtime = createPasskeyRuntime(backing, { extensionId, defaultUnset });
    const answer = runtime.handle(get(), sender());
    await vi.waitFor(() => expect(backing.candidates).toHaveBeenCalled());
    // Asked while the lookup still runs.
    await vi.waitFor(() => expect(defaultUnset).toHaveBeenCalledWith(origin, false));
    lookup.resolve();
    expect(await answer).toMatchObject({ kind: "assertion" });
  });

  it("hands the request on where no chooser can open, and signs with the default otherwise", async () => {
    const choose = chooser(async () => ({ kind: "closed" }));
    const unset = createPasskeyRuntime(withDefault(), {
      extensionId,
      chooser: choose,
      defaultUnset: () => true,
    });
    expect(await unset.handle(get(), sender({ tab: { id: 7, incognito: true } }))).toEqual({
      kind: "delegate",
      reason: "default-unset",
    });
    expect(choose.choose).not.toHaveBeenCalled();
    const backing = withDefault();
    const kept = createPasskeyRuntime(backing, {
      extensionId,
      chooser: choose,
      defaultUnset: async () => false,
    });
    expect(await kept.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    expect(choose.choose).not.toHaveBeenCalled();
    expect(backing.sign).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: "AQID", preferred: true }),
      expect.anything(),
      expect.anything(),
      expect.any(AbortSignal),
    );
  });

  it("never asks the hook for a running login's item or a conditional request", async () => {
    const defaultUnset = vi.fn(async () => true);
    const login = createPasskeyRuntime(withDefault([{ ...pair[0]!, preferred: true }]), {
      extensionId,
      chooser: chooser(async () => ({ kind: "closed" })),
      loginAccount: () => ({ connectionId: "connection-1", itemId: "item-1" }),
      defaultUnset,
    });
    expect(await login.handle(get(), sender())).toMatchObject({ kind: "assertion" });
    const conditional = createPasskeyRuntime(withDefault(), { extensionId, defaultUnset });
    expect(
      await conditional.handle(
        { ...get(), request: { ...request, mediation: "conditional" } },
        sender(),
      ),
    ).toMatchObject({ kind: "delegate" });
    expect(defaultUnset).not.toHaveBeenCalled();
  });
}

export function registerChooserLifetimeCases({
  extensionId,
  sender,
  request,
  get,
  pair,
  several,
  chooser,
}: Pick<RuntimeFixtures, "extensionId" | "sender" | "request" | "get"> & {
  pair: ChooserCandidate[];
  several: (
    overrides?: Partial<PasskeySource>,
    siteDefault?: "searched" | "unset",
  ) => PasskeySource;
  chooser: (answer: PasskeyChooser["choose"]) => { choose: Mock<PasskeyChooser["choose"]> };
}) {
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
}
