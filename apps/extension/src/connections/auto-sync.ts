import * as v from "valibot";

/** At most one revision check per connection per minute, however many pages open. */
export const VAULT_CHECK_INTERVAL_MS = 60_000;
/** A check that waited for a login is tried again sooner than a regular one. */
export const VAULT_DEFERRED_RETRY_MS = 10_000;
/** After this long, a sync waiting on a login applies anyway (an abandoned tab counts). */
export const VAULT_DEFER_LIMIT_MS = 2 * 60_000;
/** Back-off after Bitwarden answers 429, as for the Pateat service. */
export const VAULT_RATE_LIMIT_MS = 15 * 60_000;
/** How long a starting login waits for a revision check already in flight. */
export const VAULT_CHECK_WAIT_MS = 5_000;
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

  function due(entry: VaultSyncEntry | undefined, at: number) {
    // A deleted account is not asked again until a manual sync or sign-in succeeds.
    if (entry?.outcome === "account-deleted") return false;
    if (!entry?.checkedAt || entry.checkedAt > at) return true;
    if (
      entry.retryAt !== undefined &&
      entry.retryAt > at &&
      entry.retryAt - at <= VAULT_RATE_LIMIT_MS
    )
      return false;
    const wait = entry.outcome === "deferred" ? VAULT_DEFERRED_RETRY_MS : VAULT_CHECK_INTERVAL_MS;
    return at - entry.checkedAt >= wait;
  }
  function holdFor(deferredSince: number | undefined): VaultApplyHold {
    async function ready() {
      if (starting > 0 || applying) return false;
      const login = await deps.loginActive().catch(() => true);
      // Checked again after the await: a page may have started in between.
      if (starting > 0 || applying) return false;
      return (
        !login || (deferredSince !== undefined && now() - deferredSince >= VAULT_DEFER_LIMIT_MS)
      );
    }
    return {
      ready,
      async take() {
        if (!(await ready())) return undefined;
        // Set in the same task as the last check, so no page can start in between.
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
  async function check() {
    if (!online()) return;
    const ids = await deps.connections();
    for (const connectionId of ids) {
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      const record = await deps.records.read();
      const entry = record.connections[connectionId];
      const at = now();
      if (!due(entry, at)) continue;
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
      try {
        deps.report?.({ connectionId, outcome });
      } catch {
        // A report never changes the schedule.
      }
    }
  }
  /** Starts a check of every due connection unless one is already running. */
  function refreshIfStale() {
    if (running) return;
    running = check()
      .catch(() => undefined)
      .finally(() => {
        running = undefined;
      });
  }
  return {
    refreshIfStale,
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
      };
    },
    /** For tests and diagnostics: whether a check is in flight. */
    running: () => running,
  };
}
export type VaultAutoSync = ReturnType<typeof createVaultAutoSync>;
