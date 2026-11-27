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

/**
 * Failure details are diagnostic only; the schedule reads the outcome alone. `cause` is a
 * fixed error code (Bitwarden's, the setup's or `exception`), never a message, and
 * `status` an HTTP status. On `crypto-failed`, `check` names the strict decryption check
 * that refused an item, `item` its ID and `revised` its server revision date.
 */
export type VaultSyncFailure = {
  outcome: "failed";
  cause: string;
  status?: number;
  check?: string;
  item?: string;
  revised?: number;
};
/**
 * Why a replacement hold last answered no (#1819): another replacement is applying, a page
 * or passkey request still held the vault after {@link VAULT_IDLE_WAIT_MS}, or a login is
 * active within {@link VAULT_DEFER_LIMIT_MS}.
 */
export type VaultDeferral = "replacing" | "pages" | "login";
/**
 * Why a check sent nothing or stopped without an answer, as a fixed code: `busy` (disabling,
 * setup, manual work or another automatic run), `no-configuration`, `no-vault`, `locked`
 * (no user key), `session-none` and `session-unavailable` (no usable provider session),
 * `changed` (the connection changed before sending), `not-permitted`, `refresh-claimed`
 * (another refresh holds the session), `stale` (the check was stopped after the refresh),
 * `cancelled` (stopped during the sync), `timeout-unclosed` and `timeout-check-failed` (the
 * vault timeout's check, ADR 0075).
 */
export type VaultSkipReason =
  | "busy"
  | "no-configuration"
  | "no-vault"
  | "locked"
  | "session-none"
  | "session-unavailable"
  | "changed"
  | "not-permitted"
  | "refresh-claimed"
  | "stale"
  | "cancelled"
  | "timeout-unclosed"
  | "timeout-check-failed";
export type VaultSyncSkip = { outcome: "skipped"; reason: VaultSkipReason };
export type VaultSyncResult =
  | Exclude<VaultSyncOutcome, "failed" | "skipped">
  | VaultSyncFailure
  | VaultSyncSkip;
/** A check's own outcome as reported, with what held a deferral or why it skipped. */
export type VaultSyncDetail =
  | { outcome: Exclude<VaultSyncOutcome, "failed" | "skipped" | "deferred"> }
  | VaultSyncFailure
  | {
      outcome: "deferred";
      /** What refused the hold, when the run asked it. */
      blockedBy?: VaultDeferral;
      /** How long this run of deferrals has lasted; 0 for its first. */
      deferredMs: number;
      /** Whether the run has passed {@link VAULT_DEFER_LIMIT_MS}, after which no login holds it. */
      overLimit: boolean;
      /** `blockedBy` or `overLimit` differs from this connection's last reported deferral. */
      changed?: true;
    }
  | {
      outcome: "skipped";
      reason: VaultSkipReason;
      /** A found change still waits: the record held a run of deferrals. */
      pending?: true;
      /** The reason differs from this connection's last pending skip. */
      changed?: true;
    };
export type VaultSyncReport = {
  connectionId: string;
  previous?: VaultSyncOutcome | undefined;
  /** The stored cause of the check before, when it failed too. */
  previousFailure?:
    | {
        cause: string;
        status?: number | undefined;
        check?: string | undefined;
        item?: string | undefined;
      }
    | undefined;
} & VaultSyncDetail;

const time = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const entrySchema = v.strictObject({
  /** Local `Date.now()` of the last check that was sent. */
  checkedAt: v.optional(time),
  /** Local time the last check that found the revision unchanged was sent: the open
   * snapshot matched Bitwarden then. Written only when that check finishes. */
  unchangedAt: v.optional(time),
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
  /** The last check's failure code, HTTP status, decryption check and refused item, so the
   * log tells a new cause from the same failure repeated, and when that check was sent, so
   * the settings page says it; the schedule never reads it. */
  failure: v.optional(
    v.strictObject({
      at: time,
      cause: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
      status: v.optional(time),
      check: v.optional(v.pipe(v.string(), v.minLength(1), v.maxLength(64))),
      item: v.optional(v.pipe(v.string(), v.uuid())),
    }),
  ),
});
const recordSchema = v.strictObject({
  version: v.literal(1),
  connections: v.record(v.pipe(v.string(), v.minLength(1), v.maxLength(200)), entrySchema),
});
export type VaultSyncEntry = v.InferOutput<typeof entrySchema>;
/** A stored failure as the log compares it: when its check ran is not part of its cause. */
function withoutTime({ at: _at, ...failure }: NonNullable<VaultSyncEntry["failure"]>) {
  return failure;
}
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
    /**
     * Recorded after a full sync applied; it also ends a stop for a deleted account. It
     * drops the last failure, so the next failed check warns again.
     */
    setRevision: (connectionId: string, revisionMs: number) =>
      update(connectionId, ({ outcome, failure: _failure, ...entry }) => ({
        ...entry,
        revisionMs,
        ...(outcome === undefined || outcome === "account-deleted" ? {} : { outcome }),
      })),
    /** Recorded after a full sync applied without a known revision: the stored failure no
     * longer describes the open vault. */
    forgetFailure: (connectionId: string) =>
      update(connectionId, ({ failure: _failure, ...entry }) => entry),
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
  run(connectionId: string, hold: VaultApplyHold): Promise<VaultSyncResult>;
  /** Whether a login attempt is in progress, including one between pages. */
  loginActive(): Promise<boolean>;
  online?: () => boolean;
  nowMs?: () => number;
  /** Each check's outcome, with the stored one of the check before it. */
  report?: (event: VaultSyncReport) => void;
}) {
  const now = deps.nowMs ?? Date.now;
  const online = deps.online ?? (() => globalThis.navigator?.onLine !== false);
  let running: Promise<void> | undefined;
  let applying: Promise<void> | undefined;
  let starting = 0;
  let idle: (() => void)[] = [];
  /** A check asked for by a page that found no matching item; kept in memory only. */
  let missWanted = false;
  /** Each waiter with the number of replacements begun before it asked. */
  const missWaiters = new Map<(synced: boolean) => void, number>();
  /** Replacements begun; only one begun after a miss is one the page cannot have seen. */
  let applies = 0;
  /**
   * Per connection, what the last reported deferral named and the last pending skip's
   * reason, so a new blocker is logged at info (#1819); forgotten when a check ends
   * otherwise. Kept in memory only: a new worker reports its first one as changed.
   */
  const lastDeferral = new Map<
    string,
    { blockedBy: VaultDeferral | undefined; overLimit: boolean }
  >();
  const lastSkip = new Map<string, VaultSkipReason>();
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
  function holdFor(
    deferredSince: number | undefined,
  ): VaultApplyHold & { blockedBy(): VaultDeferral | undefined } {
    const forced = () =>
      deferredSince !== undefined && now() - deferredSince >= VAULT_DEFER_LIMIT_MS;
    /** Why the last `ready` or `take` answered no; undefined after a yes. */
    let blocked: VaultDeferral | undefined;
    /** Answers what stands in the way: a replacement, a page or passkey request, a login. */
    async function waitAdmissible(): Promise<() => VaultDeferral | undefined> {
      if (applying) return () => "replacing";
      if (!(await settled())) return () => "pages";
      const login = await deps.loginActive().catch(() => true);
      return () =>
        applying ? "replacing" : starting > 0 ? "pages" : login && !forced() ? "login" : undefined;
    }
    return {
      blockedBy: () => blocked,
      async ready() {
        blocked = (await waitAdmissible())();
        return blocked === undefined;
      },
      async take() {
        const admissible = await waitAdmissible();
        // The last check and the hold run with no await between them, so no page can
        // start in between.
        blocked = admissible();
        if (blocked) return undefined;
        const { promise: current, resolve: release } = Promise.withResolvers<void>();
        applying = current;
        applies += 1;
        return () => {
          release();
          if (applying === current) applying = undefined;
        };
      },
    };
  }
  /**
   * A check's outcome as reported: a deferral with what held it and for how long, a skip
   * with its reason and whether a found change still waits, each marked `changed` when it
   * differs from the last one reported for the connection.
   */
  function detail(
    connectionId: string,
    result: VaultSyncResult,
    deferredSince: number | undefined,
    finished: number,
    blockedBy: VaultDeferral | undefined,
  ): VaultSyncDetail {
    if (result === "deferred") {
      const deferredMs = deferredSince === undefined ? 0 : Math.max(0, finished - deferredSince);
      const overLimit = deferredMs >= VAULT_DEFER_LIMIT_MS;
      const last = lastDeferral.get(connectionId);
      lastDeferral.set(connectionId, { blockedBy, overLimit });
      return {
        outcome: "deferred",
        ...(blockedBy === undefined ? {} : { blockedBy }),
        deferredMs,
        overLimit,
        ...(last !== undefined && last.blockedBy === blockedBy && last.overLimit === overLimit
          ? {}
          : { changed: true as const }),
      };
    }
    if (typeof result !== "string" && result.outcome === "skipped") {
      if (deferredSince === undefined) return result;
      const changed = lastSkip.get(connectionId) !== result.reason;
      lastSkip.set(connectionId, result.reason);
      return { ...result, pending: true, ...(changed ? { changed: true as const } : {}) };
    }
    lastDeferral.delete(connectionId);
    lastSkip.delete(connectionId);
    return typeof result === "string" ? { outcome: result } : result;
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
      let result: VaultSyncResult;
      const hold = holdFor(entry?.deferredSince);
      try {
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        result = await deps.run(connectionId, hold);
      } catch {
        result = { outcome: "failed", cause: "exception" };
      }
      const outcome = typeof result === "string" ? result : result.outcome;
      const finished = now();
      // A connection removed or disabled meanwhile keeps no record of this check; a failed
      // read keeps the outcome, so a 429 back-off or a deleted account is not lost.
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      const listed = await deps.connections().catch(() => undefined);
      if (listed && !listed.includes(connectionId)) {
        lastDeferral.delete(connectionId);
        lastSkip.delete(connectionId);
        // oxlint-disable-next-line no-await-in-loop -- one connection at a time
        await deps.records.clear(connectionId);
        continue;
      }
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      await deps.records.update(connectionId, (current) => {
        const { deferredSince, retryAt: _retryAt, failure: _failure, ...rest } = current;
        return {
          ...rest,
          outcome,
          ...(typeof result === "string" || result.outcome !== "failed"
            ? {}
            : {
                failure: {
                  at,
                  cause: result.cause,
                  ...(result.status === undefined ? {} : { status: result.status }),
                  ...(result.check === undefined ? {} : { check: result.check }),
                  ...(result.item === undefined ? {} : { item: result.item }),
                },
              }),
          // Only this check's own answer confirms the snapshot; a record cleared meanwhile
          // has no check time and gets none.
          ...(outcome === "unchanged" && current.checkedAt === at ? { unchangedAt: at } : {}),
          ...(outcome === "deferred" ? { deferredSince: deferredSince ?? finished } : {}),
          // A skipped check learned nothing, so a change found earlier still waits since
          // then and the deferral limit keeps counting (#1819).
          ...(outcome === "skipped" && deferredSince !== undefined ? { deferredSince } : {}),
          ...(outcome === "rate-limited" ? { retryAt: finished + VAULT_RATE_LIMIT_MS } : {}),
        };
      });
      if (outcome === "synced") {
        // A snapshot applied after a page's miss answers it, whichever connection it came
        // from; one the page may already have seen does not.
        for (const [done, before] of [...missWaiters])
          if (before < applies) {
            missWaiters.delete(done);
            done(true);
          }
      }
      try {
        deps.report?.({
          connectionId,
          ...detail(connectionId, result, entry?.deferredSince, finished, hold.blockedBy()),
          previous: entry?.outcome,
          ...(entry?.outcome === "failed" && entry.failure
            ? { previousFailure: withoutTime(entry.failure) }
            : {}),
        });
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
        missWaiters.set(done, applies);
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
