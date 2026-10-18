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
import type { ServiceTransport } from "./transport";

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
 * starts a fresh attempt.
 */
const notEnded = new Set(["policy-changed", "account-switched"]);

/**
 * The code to send for a login report, or nothing: only for a login that just ended or
 * settled (signed in, blocked, watched after a step left to the person, or settled as
 * unknown) on a service recipe revision. A fill-only login and one that stops before an
 * item's missing password run only part of the revision, so they report nothing.
 */
export function loginOutcomeOf(
  report: LoginReport,
): { recipeId: string; report: LoginOutcomeReport } | undefined {
  if (report.type !== "attempt" || report.recipeRevision < 1) return undefined;
  if (report.reason === "fill-only" || report.stop !== undefined) return undefined;
  const ended =
    report.state === "authenticated" ||
    report.state === "blocked" ||
    report.state === "watching" ||
    (report.state === "reconciling" && report.settled === true);
  if (!ended || !report.outcome || notEnded.has(report.outcome)) return undefined;
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
 * so it is reported at most once; a report the service could not take stays pending, and
 * is sent once at the next ended login or recipe sync, a few at a time. Nothing here
 * throws into, waits on or changes a login.
 */
export function createLoginOutcomes(options: {
  service: { connection(): Promise<ServiceConnection | undefined> };
  transport: Pick<ServiceTransport, "reportOutcome">;
  storage: LoginOutcomeStorage;
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

  /** Sends pending reports of this service and device, oldest first, until one fails. */
  async function send() {
    const connection = await connected();
    if (!connection) return;
    let current = await entries();
    const pending = current
      .filter(
        (entry) =>
          entry.pending &&
          entry.service === connection.origin &&
          entry.deviceId === connection.deviceId,
      )
      .slice(0, MAX_OUTCOME_SENDS);
    for (const entry of pending) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, stopping at a failure
      const result = await transport.reportOutcome(
        connection.origin,
        connection.credential,
        entry.recipeId,
        entry.pending!,
      );
      // A rejected device or an unreachable service keeps the report for the next time.
      if (result.kind !== "kept" && result.kind !== "refused") return;
      const done = sameRevision(connection, entry.recipeId, entry.branch, entry.revision);
      current = current.map((stored) => {
        if (!done(stored)) return stored;
        const { pending: _sent, ...rest } = stored;
        return rest;
      });
      // oxlint-disable-next-line no-await-in-loop -- recorded before the next request
      await write(current);
    }
  }

  return {
    /** Takes every login report; reports a revision's first ended login. Never throws. */
    observe(report: LoginReport): void {
      try {
        const found = loginOutcomeOf(report);
        if (found)
          void enqueue(async () => {
            if (await record(found)) await send();
          });
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
