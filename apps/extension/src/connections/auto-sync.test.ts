import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VAULT_CHECK_INTERVAL_MS,
  VAULT_CHECK_WAIT_MS,
  VAULT_DEFER_LIMIT_MS,
  VAULT_DEFERRED_RETRY_MS,
  VAULT_IDLE_WAIT_MS,
  VAULT_MISS_RETRY_MS,
  VAULT_MISS_WINDOW_MS,
  VAULT_RATE_LIMIT_MS,
  createVaultAutoSync,
  createVaultSyncRecords,
  type VaultApplyHold,
  type VaultSyncOutcome,
} from "./auto-sync";

function harness(options: { ids?: string[]; online?: boolean } = {}) {
  let clock = 1_800_000_000_000;
  let stored: unknown;
  let login = false;
  const records = createVaultSyncRecords({
    read: async () => structuredClone(stored),
    write: async (record) => {
      stored = structuredClone(record);
    },
  });
  const run = vi.fn<(id: string, hold: VaultApplyHold) => Promise<VaultSyncOutcome>>(
    async () => "unchanged",
  );
  const report = vi.fn();
  const auto = createVaultAutoSync({
    records,
    connections: async () => [...(options.ids ?? ["a"])],
    run,
    report,
    loginActive: async () => login,
    online: () => options.online ?? true,
    nowMs: () => clock,
  });
  return {
    auto,
    run,
    report,
    records,
    stored: () => stored as { connections: Record<string, Record<string, unknown>> } | undefined,
    setStored: (value: unknown) => {
      stored = value;
    },
    setLogin: (value: boolean) => {
      login = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    settle: async () => {
      await auto.running();
    },
  };
}

afterEach(() => vi.useRealTimers());

/** A run that takes the replacement hold and applies a new snapshot, as a sync does. */
async function applied(_id: string, hold: VaultApplyHold): Promise<VaultSyncOutcome> {
  const release = await hold.take();
  release?.();
  return release ? "synced" : "deferred";
}

describe("vault check schedule", () => {
  it("checks each connection at most once per interval and records the outcome", async () => {
    const h = harness({ ids: ["a", "b"] });
    h.auto.refreshIfStale();
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(h.stored()?.connections["a"]).toEqual({
      checkedAt: h.now(),
      unchangedAt: h.now(),
      outcome: "unchanged",
    });
    h.advance(VAULT_CHECK_INTERVAL_MS - 1);
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run).toHaveBeenCalledTimes(2);
    h.advance(1);
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run).toHaveBeenCalledTimes(4);
  });
  it("reports each outcome with the stored one before it, which outlives the worker", async () => {
    const h = harness();
    h.run.mockResolvedValue("reauthentication-required");
    h.auto.refreshIfStale();
    await h.settle();
    h.advance(VAULT_CHECK_INTERVAL_MS);
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.report.mock.calls.map(([event]) => event)).toEqual([
      { connectionId: "a", outcome: "reauthentication-required", previous: undefined },
      {
        connectionId: "a",
        outcome: "reauthentication-required",
        previous: "reauthentication-required",
      },
    ]);
  });
  it("sends nothing while the browser reports offline", async () => {
    const h = harness({ online: false });
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run).not.toHaveBeenCalled();
  });
  it("treats a check time in the future as due and keeps the revision", async () => {
    const h = harness();
    h.setStored({
      version: 1,
      connections: { a: { checkedAt: h.now() + 3_600_000, revisionMs: 5 } },
    });
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run).toHaveBeenCalledTimes(1);
    expect(h.stored()?.connections["a"]?.["revisionMs"]).toBe(5);
  });
  it("waits after a 429 and retries a deferred check sooner", async () => {
    const h = harness();
    h.run.mockResolvedValueOnce("rate-limited");
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.stored()?.connections["a"]?.["retryAt"]).toBe(h.now() + VAULT_RATE_LIMIT_MS);
    h.advance(VAULT_RATE_LIMIT_MS - 1);
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.run.mockResolvedValueOnce("deferred");
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.stored()?.connections["a"]).toMatchObject({
      outcome: "deferred",
      deferredSince: h.now(),
    });
    expect(h.stored()?.connections["a"]?.["retryAt"]).toBeUndefined();
    h.advance(VAULT_DEFERRED_RETRY_MS);
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run).toHaveBeenCalledTimes(3);
    expect(h.stored()?.connections["a"]?.["deferredSince"]).toBeUndefined();
  });
  it("stops after a deleted account until a full sync records a revision", async () => {
    const h = harness();
    h.run.mockResolvedValueOnce("account-deleted");
    h.auto.refreshIfStale();
    await h.settle();
    h.advance(VAULT_RATE_LIMIT_MS);
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run).toHaveBeenCalledTimes(1);
    await h.records.setRevision("a", 7);
    expect(h.stored()?.connections["a"]).toEqual({ checkedAt: expect.any(Number), revisionMs: 7 });
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run).toHaveBeenCalledTimes(2);
  });
  it("an unreadable record reads as empty", async () => {
    const h = harness();
    h.setStored({ version: 2 });
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run).toHaveBeenCalledTimes(1);
  });
  it("a thrown check counts as failed and does not stop the next connection", async () => {
    const h = harness({ ids: ["a", "b"] });
    h.run.mockRejectedValueOnce(new Error("synthetic"));
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.stored()?.connections["a"]?.["outcome"]).toBe("failed");
    expect(h.run).toHaveBeenCalledTimes(2);
  });
});

describe("vault replacement hold", () => {
  it("is refused while a login is active, until the deferral limit", async () => {
    const h = harness();
    h.setLogin(true);
    let hold!: VaultApplyHold;
    h.run.mockImplementation(async (_id, value) => {
      hold = value;
      return (await value.take()) ? "synced" : "deferred";
    });
    h.auto.refreshIfStale();
    await h.settle();
    expect(await hold.ready()).toBe(false);
    expect(h.stored()?.connections["a"]?.["outcome"]).toBe("deferred");
    h.advance(VAULT_DEFER_LIMIT_MS);
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.stored()?.connections["a"]?.["outcome"]).toBe("synced");
  });
  it("records an unchanged time only when that check answers, and keeps it after a failed one", async () => {
    const h = harness();
    h.auto.refreshIfStale();
    await h.settle();
    const confirmed = h.now();
    h.advance(VAULT_CHECK_INTERVAL_MS);
    let finish!: (outcome: VaultSyncOutcome) => void;
    h.run.mockImplementationOnce(
      () =>
        new Promise<VaultSyncOutcome>((resolve) => {
          finish = resolve;
        }),
    );
    h.auto.refreshIfStale();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(2));
    // A check in flight, or one cut off, has its check time but confirms nothing yet.
    expect(h.stored()?.connections["a"]).toMatchObject({
      checkedAt: h.now(),
      unchangedAt: confirmed,
    });
    finish("failed");
    await h.settle();
    expect(h.stored()?.connections["a"]).toMatchObject({
      outcome: "failed",
      unchangedAt: confirmed,
    });
  });
  it("is refused while a page has entered, and blocks pages while held", async () => {
    vi.useFakeTimers();
    const h = harness();
    const release = await h.auto.enter(false);
    let hold!: VaultApplyHold;
    h.run.mockImplementationOnce(async (_id, value) => {
      hold = value;
      return "unchanged";
    });
    h.auto.refreshIfStale();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalled());
    await h.settle();
    const refused = hold.take();
    await vi.advanceTimersByTimeAsync(VAULT_IDLE_WAIT_MS);
    expect(await refused).toBeUndefined();
    release();
    const done = await hold.take();
    expect(done).toBeTypeOf("function");
    let entered = false;
    const page = h.auto.enter(false).then((leave) => {
      entered = true;
      return leave;
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(entered).toBe(false);
    done!();
    (await page)();
    expect(entered).toBe(true);
  });
  it("waits briefly for a page being handled before replacing", async () => {
    vi.useFakeTimers();
    const h = harness();
    const release = await h.auto.enter(false);
    let hold!: VaultApplyHold;
    h.run.mockImplementationOnce(async (_id, value) => {
      hold = value;
      return "unchanged";
    });
    h.auto.refreshIfStale();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalled());
    await h.settle();
    const taking = hold.take();
    await vi.advanceTimersByTimeAsync(VAULT_IDLE_WAIT_MS - 1);
    release();
    const done = await taking;
    expect(done).toBeTypeOf("function");
    done!();
  });
  it("a starting login waits for a running check at most briefly", async () => {
    vi.useFakeTimers();
    const h = harness();
    let finish!: () => void;
    h.run.mockImplementationOnce(
      () =>
        new Promise<VaultSyncOutcome>((resolve) => {
          finish = () => resolve("unchanged");
        }),
    );
    h.auto.refreshIfStale();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalled());
    let entered = false;
    void h.auto.enter(true).then(() => {
      entered = true;
      return undefined;
    });
    await vi.advanceTimersByTimeAsync(VAULT_CHECK_WAIT_MS - 1);
    expect(entered).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(entered).toBe(true);
    finish();
  });
});

describe("vault check after a page finds no matching item", () => {
  /** Settles every pass, including one that a miss asked for during another. */
  async function settleAll(h: ReturnType<typeof harness>) {
    for (let pass = h.auto.running(); pass; pass = h.auto.running())
      // oxlint-disable-next-line no-await-in-loop -- one pass after another
      await pass;
  }
  it("checks again after ten seconds while a regular check still waits a minute", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.auto.refreshIfStale();
    await settleAll(h);
    h.advance(VAULT_MISS_RETRY_MS - 1);
    void h.auto.checkAfterMiss();
    await settleAll(h);
    expect(h.run).toHaveBeenCalledTimes(1);
    h.advance(1);
    h.auto.refreshIfStale();
    await settleAll(h);
    expect(h.run).toHaveBeenCalledTimes(1);
    void h.auto.checkAfterMiss();
    await settleAll(h);
    expect(h.run).toHaveBeenCalledTimes(2);
    // The miss check moved the stored check time, which the regular limit counts from.
    h.advance(VAULT_CHECK_INTERVAL_MS - 1);
    h.auto.refreshIfStale();
    await settleAll(h);
    expect(h.run).toHaveBeenCalledTimes(2);
  });
  it("runs once more when a miss is asked for during a running check", async () => {
    vi.useFakeTimers();
    const h = harness();
    let finish!: () => void;
    h.run.mockImplementationOnce(
      () =>
        new Promise<VaultSyncOutcome>((resolve) => {
          finish = () => resolve("unchanged");
        }),
    );
    h.auto.refreshIfStale();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    h.advance(VAULT_MISS_RETRY_MS);
    h.run.mockImplementationOnce(applied);
    const synced = h.auto.checkAfterMiss();
    void h.auto.checkAfterMiss();
    expect(h.run).toHaveBeenCalledTimes(1);
    finish();
    await settleAll(h);
    // The running check counted from its own start; one follow-up checks after ten seconds.
    expect(h.run).toHaveBeenCalledTimes(2);
    expect(await synced).toBe(true);
  });
  it("answers true only when a check applies a new snapshot within ten seconds", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.run.mockImplementationOnce(applied);
    expect(await h.auto.checkAfterMiss()).toBe(true);
    for (const outcome of [
      "unchanged",
      "deferred",
      "failed",
      "skipped",
      "reauthentication-required",
    ] as const) {
      h.advance(VAULT_MISS_RETRY_MS);
      h.run.mockResolvedValueOnce(outcome);
      let answered: boolean | undefined;
      void h.auto.checkAfterMiss().then((value) => {
        answered = value;
        return undefined;
      });
      // oxlint-disable-next-line no-await-in-loop -- one outcome after another
      await settleAll(h);
      // oxlint-disable-next-line no-await-in-loop -- one outcome after another
      await vi.advanceTimersByTimeAsync(VAULT_MISS_WINDOW_MS - 1);
      expect(answered).toBeUndefined();
      // oxlint-disable-next-line no-await-in-loop -- one outcome after another
      await vi.advanceTimersByTimeAsync(1);
      expect(answered).toBe(false);
    }
  });
  it("answers false when the snapshot is applied only after ten seconds", async () => {
    vi.useFakeTimers();
    const h = harness();
    let finish!: () => void;
    h.run.mockImplementationOnce(
      () =>
        new Promise<VaultSyncOutcome>((resolve) => {
          finish = () => resolve("synced");
        }),
    );
    const synced = h.auto.checkAfterMiss();
    await vi.advanceTimersByTimeAsync(VAULT_MISS_WINDOW_MS);
    expect(await synced).toBe(false);
    finish();
    await settleAll(h);
    expect(h.stored()?.connections["a"]?.["outcome"]).toBe("synced");
  });
  it("is answered by a regular check that applies a new snapshot after the miss", async () => {
    vi.useFakeTimers();
    const h = harness();
    let proceed!: () => void;
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    h.run.mockImplementationOnce(async (id, hold) => {
      await gate;
      return applied(id, hold);
    });
    h.auto.refreshIfStale();
    await vi.waitFor(() => expect(h.run).toHaveBeenCalledTimes(1));
    // Asked while the regular check is still fetching; its replacement comes after.
    const synced = h.auto.checkAfterMiss();
    proceed();
    await settleAll(h);
    expect(await synced).toBe(true);
  });
  it("is not answered by a snapshot applied before the miss was asked", async () => {
    vi.useFakeTimers();
    const h = harness();
    let finish!: () => void;
    const recorded = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let missed: Promise<boolean> | undefined;
    h.run.mockImplementationOnce(async (_id, hold) => {
      const release = await hold.take();
      release?.();
      // A page plans with the new snapshot, still finds nothing and asks.
      missed = h.auto.checkAfterMiss();
      finish();
      return "synced";
    });
    h.auto.refreshIfStale();
    await recorded;
    await settleAll(h);
    await vi.advanceTimersByTimeAsync(VAULT_MISS_WINDOW_MS);
    expect(await missed).toBe(false);
  });
  it.each<[string, (h: ReturnType<typeof harness>) => void]>([
    [
      "after a 429",
      (h) =>
        h.setStored({
          version: 1,
          connections: {
            a: { checkedAt: h.now() - 60_000, outcome: "rate-limited", retryAt: h.now() + 60_000 },
          },
        }),
    ],
    [
      "for a deleted account",
      (h) =>
        h.setStored({
          version: 1,
          connections: { a: { checkedAt: h.now() - 60_000, outcome: "account-deleted" } },
        }),
    ],
  ])("sends nothing %s and answers false", async (_name, setup) => {
    vi.useFakeTimers();
    const h = harness();
    setup(h);
    const synced = h.auto.checkAfterMiss();
    await settleAll(h);
    await vi.advanceTimersByTimeAsync(VAULT_MISS_WINDOW_MS);
    expect(await synced).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
  });
  it("sends nothing while offline and answers false", async () => {
    vi.useFakeTimers();
    const h = harness({ online: false });
    const synced = h.auto.checkAfterMiss();
    await settleAll(h);
    await vi.advanceTimersByTimeAsync(VAULT_MISS_WINDOW_MS);
    expect(await synced).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
  });
  it("is not answered by a connection removed during its check", async () => {
    vi.useFakeTimers();
    const ids = ["a"];
    const h = harness({ ids });
    h.run.mockImplementationOnce(async (id, hold) => {
      ids.length = 0;
      return applied(id, hold);
    });
    const synced = h.auto.checkAfterMiss();
    await settleAll(h);
    await vi.advanceTimersByTimeAsync(VAULT_MISS_WINDOW_MS);
    expect(await synced).toBe(false);
    expect(h.stored()?.connections["a"]).toBeUndefined();
  });
});
