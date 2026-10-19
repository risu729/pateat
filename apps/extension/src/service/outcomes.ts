import {
  chooserBranchSchema,
  loginOutcomeCauseSchema,
  loginOutcomeReportSchema,
  loginOutcomeSchema,
  syncRecipeIdSchema,
  type ChooserBranch,
  type LoginOutcomeCause,
  type LoginOutcomeReport,
} from "@pateat/contracts";
import * as v from "valibot";
import type { LoginReport, StopCause } from "../login/runtime";
import type { ServiceConnection } from "./runtime";
import type { OutcomeResult, ServiceTransport } from "./transport";

// The one exception to "logs are never synced" (ADR 0019, amended 2026-10-18): how the
// first login of each recipe revision on this device ended, as codes only, for the
// service's evaluation corpus (ADR 0012). Sending is best-effort and never touches a login.

/** Every worker stop cause is a code the service accepts. */
const stopCauses: StopCause extends LoginOutcomeCause ? true : never = true;
void stopCauses;

/** Revisions remembered at once; the oldest go first. */
export const MAX_LOGIN_OUTCOMES = 500;
/** Reports sent in one go, so a backlog never bursts against the owner's request limit. */
export const MAX_OUTCOME_SENDS = 5;
/**
 * A report still pending after this long is dropped, and its revision stays reported: the
 * local log keeps its login this long too (`LOG_RETENTION_MS`, ADR 0019).
 */
export const PENDING_OUTCOME_MS = 14 * 24 * 60 * 60 * 1000;
/** After a run a failure stopped, no run starts for this long, so an outage costs little. */
export const OUTCOME_RETRY_MS = 60 * 1000;

/** One request that left the device, for the local log (ADR 0019): codes only. */
export type LoginOutcomeSent = {
  recipeId: string;
  revision: number;
  branch?: ChooserBranch;
  /** `kept`, `refused`, `rejected`, or `failed:<code>`. */
  result: string;
};

/**
 * The revisions this device reported, per service and device like the generated slot
 * maps: `pending` holds a report the service has not taken yet, to send when it next can.
 */
const outcomesSchema = v.strictObject({
  version: v.literal(1),
  entries: v.pipe(
    v.array(
      v.strictObject({
        service: v.pipe(v.string(), v.maxLength(2048)),
        deviceId: v.pipe(v.string(), v.maxLength(200)),
        recipeId: syncRecipeIdSchema,
        branch: v.optional(chooserBranchSchema),
        revision: v.pipe(v.number(), v.integer(), v.minValue(1)),
        at: v.pipe(v.number(), v.integer(), v.minValue(0)),
        pending: v.optional(loginOutcomeReportSchema),
      }),
    ),
    v.maxLength(MAX_LOGIN_OUTCOMES),
  ),
});
type LoginOutcomes = v.InferOutput<typeof outcomesSchema>;
type Entry = LoginOutcomes["entries"][number];

export interface LoginOutcomeStorage {
  read(): Promise<unknown>;
  write(outcomes: LoginOutcomes): Promise<void>;
}

/**
 * Results that leave the revision for a later login, because they say nothing about its
 * plan: settings or the vault changed under the login, or the recipe's account switch
 * starts a fresh attempt. A `cancelled` end without a cause is left too (below).
 */
const notEnded = new Set(["policy-changed", "account-switched"]);

/**
 * The code to send for a login report, or nothing: only for a login on a service recipe
 * revision that just ended (signed in or blocked) or, unless it is watched, settled as
 * unknown. A watched login (ADR 0027) reports how its watch ends, as signed in or blocked
 * with the outcome the watch left, never where it first stopped. A fill-only login and one
 * of an item without a password run only part of the revision, so they report nothing:
 * every report of the latter names its stop, so it reports nothing even when it fails
 * before the stop. A listed cause is sent as it is and takes precedence over the
 * `settled` and `unconfirmed` flags, which stand in only when there is none.
 */
export function loginOutcomeOf(
  report: LoginReport,
): { recipeId: string; report: LoginOutcomeReport } | undefined {
  if (report.type !== "attempt" || report.recipeRevision < 1) return undefined;
  if (report.reason === "fill-only" || report.stop !== undefined) return undefined;
  const ended =
    report.state === "authenticated" ||
    report.state === "blocked" ||
    (report.state === "reconciling" && report.settled === true && !report.watched);
  if (!ended || !report.outcome || notEnded.has(report.outcome)) return undefined;
  // A cancel with no cause, as a navigation the login did not expect, says nothing of the plan.
  if (report.outcome === "cancelled" && !v.is(loginOutcomeCauseSchema, report.cause))
    return undefined;
  const cause: LoginOutcomeCause | undefined = v.is(loginOutcomeCauseSchema, report.cause)
    ? report.cause
    : report.settled
      ? "settled"
      : report.unconfirmed
        ? "unconfirmed"
        : undefined;
  const parsed = v.safeParse(loginOutcomeReportSchema, {
    version: 1,
    revision: report.recipeRevision,
    ...(report.branch ? { branch: report.branch } : {}),
    outcome: v.is(loginOutcomeSchema, report.outcome) ? report.outcome : undefined,
    ...(cause ? { cause } : {}),
    step: report.stepIndex,
  });
  return parsed.success && v.is(syncRecipeIdSchema, report.recipeId)
    ? { recipeId: report.recipeId, report: parsed.output }
    : undefined;
}

const sameRevision =
  (
    connection: ServiceConnection,
    recipeId: string,
    branch: ChooserBranch | undefined,
    revision: number,
  ) =>
  (entry: Entry) =>
    entry.service === connection.origin &&
    entry.deviceId === connection.deviceId &&
    entry.recipeId === recipeId &&
    entry.branch === branch &&
    entry.revision === revision;

/**
 * Sends the service the result code of the first login of each recipe revision on this
 * device (ADR 0019, amended 2026-10-18). A revision is recorded before its report is sent,
 * so it is reported once; a report the service could not take stays pending, and every
 * ended login that is not a repeat and every successful recipe sync sends what is pending,
 * a few at a time and not within a minute of a failure, until it is 14 days old. Nothing
 * here throws into, waits on or changes a login.
 */
export function createLoginOutcomes(options: {
  service: { connection(): Promise<ServiceConnection | undefined> };
  transport: Pick<ServiceTransport, "reportOutcome">;
  storage: LoginOutcomeStorage;
  /** Told of each request sent, for the local log; never changes the sending. */
  report?: (sent: LoginOutcomeSent) => void;
  now?: () => number;
}) {
  const { service, transport, storage } = options;
  const now = options.now ?? Date.now;
  // One read-modify-write at a time, so two logins ending together are both recorded and
  // no report is sent twice.
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (work: () => Promise<unknown>) => {
    const next = queue.then(work).catch(() => undefined);
    queue = next;
    return next.then(() => undefined);
  };

  async function connected() {
    const connection = await service.connection().catch(() => undefined);
    return connection && !connection.rejected ? connection : undefined;
  }
  /** The stored entries; ones that do not parse count as none, as no older format is kept. */
  async function entries(): Promise<Entry[]> {
    const parsed = v.safeParse(outcomesSchema, await storage.read());
    return parsed.success ? parsed.output.entries : [];
  }
  const write = (next: Entry[]) =>
    storage.write({ version: 1, entries: next.slice(-MAX_LOGIN_OUTCOMES) });

  /** Records a revision's first result as pending; false when it was recorded before. */
  async function record(found: { recipeId: string; report: LoginOutcomeReport }) {
    const connection = await connected();
    if (!connection) return false;
    const current = await entries();
    const { recipeId, report } = found;
    if (current.some(sameRevision(connection, recipeId, report.branch, report.revision)))
      return false;
    await write([
      ...current,
      {
        service: connection.origin,
        deviceId: connection.deviceId,
        recipeId,
        ...(report.branch ? { branch: report.branch } : {}),
        revision: report.revision,
        at: now(),
        pending: report,
      },
    ]);
    return true;
  }

  /** The entry without its pending report: its revision stays reported. */
  const settledEntry = ({ pending: _pending, ...rest }: Entry): Entry => rest;

  /** No run starts before this time: a failure stopped the last one (`OUTCOME_RETRY_MS`). */
  let retryAt = 0;

  /**
   * Sends pending reports of this service and device, oldest first. A report older than
   * `PENDING_OUTCOME_MS` is dropped unsent. The first failure stops the run, keeps every
   * report still pending and holds off the next run for `OUTCOME_RETRY_MS`, so an outage
   * costs about one request a minute. An unexpected answer, such as a 5xx or an HTML
   * error page, or a call that threw also moves its report behind the others, so one report
   * the service cannot take never holds the others back.
   */
  async function send() {
    if (now() < retryAt) return;
    const connection = await connected();
    if (!connection) return;
    let current = await entries();
    const cutoff = now() - PENDING_OUTCOME_MS;
    if (current.some((entry) => entry.pending && entry.at < cutoff)) {
      current = current.map((entry) =>
        entry.pending && entry.at < cutoff ? settledEntry(entry) : entry,
      );
      await write(current);
    }
    const pending = current
      .filter(
        (entry) =>
          entry.pending &&
          entry.service === connection.origin &&
          entry.deviceId === connection.deviceId,
      )
      .slice(0, MAX_OUTCOME_SENDS);
    for (const entry of pending) {
      let result: OutcomeResult | undefined;
      try {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time, stopping at a failure
        result = await transport.reportOutcome(
          connection.origin,
          connection.credential,
          entry.recipeId,
          entry.pending!,
        );
      } catch {
        result = undefined;
      }
      try {
        options.report?.({
          recipeId: entry.recipeId,
          revision: entry.revision,
          ...(entry.branch ? { branch: entry.branch } : {}),
          result: !result
            ? "failed:threw"
            : result.kind === "failed"
              ? `failed:${result.error}`
              : result.kind,
        });
      } catch {
        // The log never changes the sending.
      }
      const same = sameRevision(connection, entry.recipeId, entry.branch, entry.revision);
      if (result?.kind !== "kept" && result?.kind !== "refused") {
        retryAt = now() + OUTCOME_RETRY_MS;
        if (!result || (result.kind === "failed" && result.error === "unexpected-response"))
          // oxlint-disable-next-line no-await-in-loop -- the run ends here
          await write([
            ...current.filter((stored) => !same(stored)),
            ...current.filter((stored) => same(stored)),
          ]);
        return;
      }
      current = current.map((stored) => (same(stored) ? settledEntry(stored) : stored));
      // oxlint-disable-next-line no-await-in-loop -- recorded before the next request
      await write(current);
    }
  }

  return {
    /**
     * Takes every login report; records a revision's first ended login and sends what is
     * pending. Never throws.
     */
    observe(report: LoginReport): void {
      try {
        const found = loginOutcomeOf(report);
        // Every ended login also sends what is still pending, one it reports nothing for too.
        // A repeat, a new document of a tab whose login already ended, sends nothing more.
        const repeat = report.type === "attempt" && report.repeat === true;
        if (found)
          void enqueue(async () => {
            if ((await record(found)) || !repeat) await send();
          });
        else if (
          report.type === "attempt" &&
          !repeat &&
          (report.state === "authenticated" || report.state === "blocked")
        )
          void enqueue(send);
      } catch {
        // A report must never change the login.
      }
    },
    /** Sends what is still pending, as after a recipe sync reached the service. */
    flush(): Promise<void> {
      return enqueue(send);
    },
  };
}
