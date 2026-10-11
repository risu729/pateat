import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VAULT_CHECK_INTERVAL_MS,
  VAULT_CHECK_WAIT_MS,
  VAULT_DEFER_LIMIT_MS,
  VAULT_DEFERRED_RETRY_MS,
  VAULT_IDLE_WAIT_MS,
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
  const auto = createVaultAutoSync({
    records,
    connections: async () => [...(options.ids ?? ["a"])],
    run,
    loginActive: async () => login,
    online: () => options.online ?? true,
    nowMs: () => clock,
  });
  return {
    auto,
    run,
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

describe("vault check schedule", () => {
  it("checks each connection at most once per interval and records the outcome", async () => {
    const h = harness({ ids: ["a", "b"] });
    h.auto.refreshIfStale();
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run.mock.calls.map(([id]) => id)).toEqual(["a", "b"]);
    expect(h.stored()?.connections["a"]).toEqual({ checkedAt: h.now(), outcome: "unchanged" });
    h.advance(VAULT_CHECK_INTERVAL_MS - 1);
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run).toHaveBeenCalledTimes(2);
    h.advance(1);
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.run).toHaveBeenCalledTimes(4);
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
  it("keeps no record for a connection removed during its check", async () => {
    const ids = ["a"];
    const h = harness({ ids });
    h.run.mockImplementationOnce(async () => {
      ids.length = 0;
      return "failed";
    });
    h.auto.refreshIfStale();
    await h.settle();
    expect(h.stored()?.connections["a"]).toBeUndefined();
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
