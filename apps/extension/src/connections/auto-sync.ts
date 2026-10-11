import * as v from "valibot";

/** At most one revision check per connection per minute, however many pages open. */
export const VAULT_CHECK_INTERVAL_MS = 60_000;
/** A check that waited for a login is tried again sooner than a regular one. */
export const VAULT_DEFERRED_RETRY_MS = 10_000;
/** After a page with a recipe finds no matching item, a check may run this soon again. */
export const VAULT_MISS_RETRY_MS = 10_000;
/** How long such a page waits for a check to apply a new snapshot before giving up. */
export const VAULT_MISS_WINDOW_MS = 10_000;
/** After this long, a sync waiting on a login applies anyway (an abandoned tab counts). */
export const VAULT_DEFER_LIMIT_MS = 2 * 60_000;
/** Back-off after Bitwarden answers 429, as for the Pateat service. */
export const VAULT_RATE_LIMIT_MS = 15 * 60_000;
/** How long a starting login waits for a revision check already in flight. */
export const VAULT_CHECK_WAIT_MS = 5_000;
/** How long a replacement waits for page announcements being handled to finish. */
export const VAULT_IDLE_WAIT_MS = 2_000;
/** The alarm that checks while no page is opened (ADR 0025). */
export const VAULT_SYNC_ALARM = "pateat.vault-sync";
export const VAULT_SYNC_ALARM_MINUTES = 5;

export type VaultSyncOutcome =
  | "unchanged"
  | "synced"
  | "deferred"
  | "rate-limited"
  | "failed"
  | "reauthentication-required"
  | "account-deleted"
  | "skipped";

const time = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const entrySchema = v.strictObject({
  /** Local `Date.now()` of the last check that was sent. */
  checkedAt: v.optional(time),
  /** Server milliseconds from `/accounts/revision-date` of the last applied sync. Never
   * compared with local time. */
  revisionMs: v.optional(time),
  outcome: v.optional(
    v.picklist([
      "unchanged",
      "synced",
      "deferred",
      "rate-limited",
      "failed",
      "reauthentication-required",
      "account-deleted",
      "skipped",
    ]),
  ),
  /** Local time the current run of deferrals began. */
  deferredSince: v.optional(time),
  /** Local time before which no check is sent, after a 429. */
  retryAt: v.optional(time),
});
const recordSchema = v.strictObject({
  version: v.literal(1),
  connections: v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(200)), entrySchema),
});
export type VaultSyncEntry = v.InferOutput<typeof entrySchema>;
export type VaultSyncRecord = v.InferOutput<typeof recordSchema>;
export type VaultSyncStorage = {
  read(): Promise<unknown>;
  write(record: VaultSyncRecord): Promise<void>;
};

/**
 * Per-connection check state in one storage key. Writes are serialized so the scheduler
 * and manual syncs never lose each other's fields. An unreadable record reads as empty,
 * which only makes the next check send a full sync.
 */
export function createVaultSyncRecords(storage: VaultSyncStorage) {
  let queue: Promise<unknown> = Promise.resolve();
  async function load(): Promise<VaultSyncRecord> {
    const parsed = v.safeParse(recordSchema, await storage.read().catch(() => undefined));
    return parsed.success ? parsed.output : { version: 1, connections: {} };
  }
  function update(connectionId: string, mutate: (entry: VaultSyncEntry) => VaultSyncEntry | null) {
    const next = queue.then(async () => {
      const record = await load();
      const changed = mutate(record.connections[connectionId] ?? {});
      if (changed === null) delete record.connections[connectionId];
      else record.connections[connectionId] = changed;
      return storage.write(record);
    });
    queue = next.catch(() => undefined);
    return next;
  }
  return {
    read: () => queue.then(load),
    update,
    /** The revision a full sync last applied, if one is known. */
    async revision(connectionId: string): Promise<number | undefined> {
      return (await queue.then(load)).connections[connectionId]?.revisionMs;
    },
    /** Recorded after a full sync applied; it also ends a stop for a deleted account. */
    setRevision: (connectionId: string, revisionMs: number) =>
      update(connectionId, ({ outcome, ...entry }) => ({
        ...entry,
        revisionMs,
        ...(outcome === undefined || outcome === "account-deleted" ? {} : { outcome }),
      })),
    clear: (connectionId: string) => update(connectionId, () => null),
  };
}
export type VaultSyncRecords = ReturnType<typeof createVaultSyncRecords>;

/**
 * How a check asks whether it may replace the open vault. `ready` only looks, so a check
 * skips the full sync while a login is in progress. `take` answers a release function to
 * call when the replacement (accept and settings adoption) has finished, or undefined
 * when a login or passkey request is in progress and the check must wait.
 */
export type VaultApplyHold = {
  ready(): Promise<boolean>;
  take(): Promise<(() => void) | undefined>;
};

export function createVaultAutoSync(deps: {
  records: VaultSyncRecords;
  /** Connections to check: configured, enabled in settings, with automatic unlock. */
  connections(): Promise<string[]>;
  run(connectionId: string, hold: VaultApplyHold): Promise<VaultSyncOutcome>;
  /** Whether a login attempt is in progress, including one between pages. */
  loginActive(): Promise<boolean>;
  online?: () => boolean;
  nowMs?: () => number;
  report?: (event: { connectionId: string; outcome: VaultSyncOutcome }) => void;
}) {
  const now = deps.nowMs ?? Date.now;
  const online = deps.online ?? (() => globalThis.navigator?.onLine !== false);
  let running: Promise<void> | undefined;
  let applying: Promise<void> | undefined;
  let starting = 0;
  let idle: (() => void)[] = [];
  /** A check asked for by a page that found no matching item; kept in memory only. */
  let missWanted = false;
  const missWaiters = new Set<(synced: boolean) => void>();
  /** Resolves true once no page or passkey request is being handled, false after a while. */
  function settled(): Promise<boolean> {
    if (starting === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        idle = idle.filter((waiter) => waiter !== done);
        resolve(false);
      }, VAULT_IDLE_WAIT_MS);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      idle.push(done);
    });
  }

  function due(entry: VaultSyncEntry | undefined, at: number, miss: boolean) {
    // A deleted account is not asked again until a manual sync or sign-in succeeds.
    if (entry?.outcome === "account-deleted") return false;
    if (!entry?.checkedAt || entry.checkedAt > at) return true;
    if (
      entry.retryAt !== undefined &&
      entry.retryAt > at &&
      entry.retryAt - at <= VAULT_RATE_LIMIT_MS
    )
      return false;
    const wait = miss
      ? VAULT_MISS_RETRY_MS
      : entry.outcome === "deferred"
        ? VAULT_DEFERRED_RETRY_MS
        : VAULT_CHECK_INTERVAL_MS;
    return at - entry.checkedAt >= wait;
  }
  function holdFor(deferredSince: number | undefined): VaultApplyHold {
    const forced = () =>
      deferredSince !== undefined && now() - deferredSince >= VAULT_DEFER_LIMIT_MS;
    /** Answers whether no page, passkey request or login stands in the way. */
    async function waitAdmissible(): Promise<() => boolean> {
      if (applying || !(await settled())) return () => false;
      const login = await deps.loginActive().catch(() => true);
      return () => starting === 0 && !applying && (!login || forced());
    }
    return {
      ready: async () => (await waitAdmissible())(),
      async take() {
        const admissible = await waitAdmissible();
        // The last check and the hold run with no await between them, so no page can
        // start in between.
        if (!admissible()) return undefined;
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
          release = resolve;
        });
        applying = current;
        return () => {
          release();
          if (applying === current) applying = undefined;
        };
      },
    };
  }
  /** A miss check uses the shorter limit for every connection it checks. */
  async function check(miss: boolean) {
    if (!online()) return;
    const ids = await deps.connections();
    for (const connectionId of ids) {
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      const record = await deps.records.read();
      const entry = record.connections[connectionId];
      const at = now();
      if (!due(entry, at, miss)) continue;
      // Written before the request, so a restart in between does not send it again at once.
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      await deps.records.update(connectionId, (current) => ({ ...current, checkedAt: at }));
      let outcome: VaultSyncOutcome;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        outcome = await deps.run(connectionId, holdFor(entry?.deferredSince));
      } catch {
        outcome = "failed";
      }
      const finished = now();
      // A connection removed or disabled meanwhile keeps no record of this check; a failed
      // read keeps the outcome, so a 429 back-off or a deleted account is not lost.
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      const listed = await deps.connections().catch(() => undefined);
      if (listed && !listed.includes(connectionId)) {
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        await deps.records.clear(connectionId);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      await deps.records.update(connectionId, (current) => {
        const { deferredSince, retryAt: _retryAt, ...rest } = current;
        return {
          ...rest,
          outcome,
          ...(outcome === "deferred" ? { deferredSince: deferredSince ?? finished } : {}),
          ...(outcome === "rate-limited" ? { retryAt: finished + VAULT_RATE_LIMIT_MS } : {}),
        };
      });
      if (outcome === "synced") {
        // Any applied snapshot answers the pages waiting after a miss; they announce again.
        const waiting = [...missWaiters];
        missWaiters.clear();
        for (const done of waiting) done(true);
      }
      try {
        deps.report?.({ connectionId, outcome });
      } catch {
        // A report never changes the schedule.
      }
    }
  }
  /**
   * Starts a check of every due connection unless one is already running. A miss asked
   * for during a check runs once that check ends.
   */
  function start() {
    if (running) return;
    const miss = missWanted;
    missWanted = false;
    running = check(miss)
      .catch(() => undefined)
      .finally(() => {
        running = undefined;
        if (missWanted) start();
      });
  }
  return {
    refreshIfStale: start,
    /**
     * Asked after a page with a recipe found no matching item: a check of each connection
     * last checked at least ten seconds ago. Answers true once any check applies a new
     * snapshot within ten seconds, else false. A 429 back-off, a deleted account and
     * offline still send nothing.
     */
    checkAfterMiss(): Promise<boolean> {
      const answer = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          missWaiters.delete(done);
          resolve(false);
        }, VAULT_MISS_WINDOW_MS);
        const done = (synced: boolean) => {
          clearTimeout(timer);
          resolve(synced);
        };
        missWaiters.add(done);
      });
      missWanted = true;
      start();
      return answer;
    },
    /**
     * Entered by each page that may start a login and each passkey request. It waits for
     * a replacement in progress and, when asked, briefly for a running check, then holds
     * replacements off until the returned function is called.
     */
    async enter(waitForCheck: boolean): Promise<() => void> {
      if (waitForCheck && running)
        await Promise.race([
          running,
          new Promise<void>((resolve) => setTimeout(resolve, VAULT_CHECK_WAIT_MS)),
        ]);
      for (let current = applying; current; current = applying) {
        // oxlint-disable-next-line no-await-in-loop -- waits for each replacement in turn
        await current;
      }
      starting += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        starting -= 1;
        if (starting > 0) return;
        const waiting = idle;
        idle = [];
        for (const done of waiting) done();
      };
    },
    /** For tests and diagnostics: whether a check is in flight. */
    running: () => running,
  };
}
export type VaultAutoSync = ReturnType<typeof createVaultAutoSync>;
