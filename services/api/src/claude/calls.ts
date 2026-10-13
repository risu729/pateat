import type { GenerationUnavailableReason } from "@pateat/contracts";
import {
  claudeGeneration,
  createClaudeGenerationModel,
  estimateClaudeCostUsd,
  outputRejection,
  unknownUsage,
  type InferenceOutcome,
} from "@pateat/inference";
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { inferenceLocks, inferenceLog, inferenceSpend } from "../db/schema";
import { resolveClaudeCredential } from "./credentials";
import { newId } from "@pateat/contracts/ids";
import { Temporal } from "temporal-polyfill-lite";

// Every Claude call the service makes goes through here (ADR 0018): one call at a time
// per owner, the monthly and daily spend stops, and the ADR 0012 request
// log with its 90-day retention.

/** Request bounds shared by both roles; the same as the approved benchmark run. */
export const ROLE_LIMITS = { timeoutMs: 60_000, maxInputBytes: 64 * 1024, maxRetries: 0 };
export const MAX_OUTPUT_TOKENS = 8_192;

const DAY_MS = 24 * 60 * 60 * 1000;
export const CLAUDE_CALL_LIMITS = {
  /** $100 a month (ADR 0014), estimated from returned usage. */
  monthlyMicroUsd: 100_000_000,
  /** $5 a day (UTC), counting generation and judgement alike (owner decision, 2026-10-11). */
  dailyMicroUsd: 5_000_000,
  /** Longer than the token exchange and the model timeout together. */
  lockMs: 90_000,
  logRetentionMs: 90 * DAY_MS,
};

/**
 * Charged before each call and corrected afterwards, so a request that never finishes
 * still counts. Usage the provider does not report keeps this upper bound: a request
 * holds at most `maxInputBytes` tokens.
 */
const RESERVED_MICRO_USD =
  ROLE_LIMITS.maxInputBytes * claudeGeneration.rates.input +
  MAX_OUTPUT_TOKENS * claudeGeneration.rates.output;

type Db = DrizzleD1Database<Record<string, never>>;
type CallEnv = { DB: D1Database; OIDC_ISSUER?: string; OIDC_SIGNING_KEYS?: string };
type ClaudeModel = ReturnType<typeof createClaudeGenerationModel>;

export type ClaudeCall<T> = {
  role: "generate" | "judge";
  /**
   * The role's prompt version (`generationPromptVersion`, `entryGenerationPromptVersion`,
   * `accountListGenerationPromptVersion`, `completionPromptVersion`).
   */
  promptVersion: string;
  origin: string;
  path: string;
  /** What is sent: the instructions and the input, as ADR 0012 requires. */
  request: unknown;
  /** Checked under the owner's lock, before credentials are resolved. */
  gate?: (db: Db, now: number) => Promise<GenerationUnavailableReason | undefined>;
  /** Written together with the spend reservation, once a call is certain. */
  reserved?: (db: Db, now: number) => BatchItem<"sqlite">[];
  invoke: (model: ClaudeModel) => Promise<InferenceOutcome<T>>;
  /** The structured result to log for an `ok` outcome. */
  logValue: (value: T) => unknown;
};

export type ClaudeCallResult<T> =
  | { status: "unavailable"; reason: GenerationUnavailableReason }
  | { status: "called"; outcome: InferenceOutcome<T> };

/** The UTC month and day of `now`: `2026-10` and `2026-10-13`. */
const periods = (now: number) => {
  const day = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO("UTC").toPlainDate();
  return [day.toPlainYearMonth().toString(), day.toString()] as const;
};

function addSpend(db: Db, ownerId: string, period: string, calls: number, micro: number) {
  return db
    .insert(inferenceSpend)
    .values({ ownerId, period, calls, costMicroUsd: micro })
    .onConflictDoUpdate({
      target: [inferenceSpend.ownerId, inferenceSpend.period],
      set: {
        calls: sql`${inferenceSpend.calls} + ${calls}`,
        costMicroUsd: sql`${inferenceSpend.costMicroUsd} + ${micro}`,
      },
    });
}

async function acquireLock(db: Db, ownerId: string, now: number) {
  const lockId = newId();
  const expiresAt = now + CLAUDE_CALL_LIMITS.lockMs;
  const result = await db
    .insert(inferenceLocks)
    .values({ ownerId, lockId, expiresAt })
    .onConflictDoUpdate({
      target: inferenceLocks.ownerId,
      set: { lockId, expiresAt },
      // An abandoned lock (its request ended without releasing it) is taken over.
      setWhere: lte(inferenceLocks.expiresAt, now),
    })
    .run();
  return result.meta.changes === 1 ? lockId : undefined;
}

/** Whether the owner reached the monthly or daily spend stop. */
export async function limitReached(db: Db, ownerId: string, now: number) {
  const [month, day] = periods(now);
  const rows = await db
    .select()
    .from(inferenceSpend)
    .where(and(eq(inferenceSpend.ownerId, ownerId), inArray(inferenceSpend.period, [month, day])));
  const spent = (period: string) => rows.find((row) => row.period === period)?.costMicroUsd ?? 0;
  if (spent(month) >= CLAUDE_CALL_LIMITS.monthlyMicroUsd) return "monthly-limit" as const;
  if (spent(day) >= CLAUDE_CALL_LIMITS.dailyMicroUsd) return "daily-limit" as const;
  return undefined;
}

/**
 * Deletes log rows past the 90-day retention. Routine releases do not apply cron
 * triggers, so this runs whenever a call is logged and on every recipe sync read.
 */
export function purgeExpiredLog(db: Db, now: number) {
  return db
    .delete(inferenceLog)
    .where(lt(inferenceLog.createdAt, now - CLAUDE_CALL_LIMITS.logRetentionMs));
}

const credentialUnavailable = {
  not_configured: "credentials-not-configured",
  rejected: "credentials-rejected",
  issuer_unavailable: "issuer-unavailable",
  failed: "token-exchange-failed",
} as const;

/**
 * What the request log keeps of a call's result: the structured result for `ok`, the
 * abstention reason, and for refused output which check refused it, with the output
 * reduced to references the request holds when the role kept one (ADR 0012).
 */
function loggedResult<T>(call: ClaudeCall<T>, outcome: InferenceOutcome<T>): unknown {
  if (outcome.status === "ok") return call.logValue(outcome.value);
  if (outcome.status === "abstained") return { reason: outcome.reason };
  const rejection = outputRejection(outcome);
  if (!rejection) return null;
  return { rejection, ...(outcome.output === undefined ? {} : { output: outcome.output }) };
}

/**
 * Makes one role call for the authenticated owner. `ownerId` must come from the request
 * scope. Nothing is reserved, logged or sent unless every check passes.
 */
export async function callClaude<T>(
  env: CallEnv,
  ownerId: string,
  call: ClaudeCall<T>,
): Promise<ClaudeCallResult<T>> {
  const db = drizzle(env.DB);
  const start = Date.now();
  const lockId = await acquireLock(db, ownerId, start);
  if (!lockId) return { status: "unavailable", reason: "busy" };
  try {
    const blocked = (await call.gate?.(db, start)) ?? (await limitReached(db, ownerId, start));
    if (blocked) return { status: "unavailable", reason: blocked };

    const credential = await resolveClaudeCredential(env, ownerId);
    if (credential.status !== "ready")
      return { status: "unavailable", reason: credentialUnavailable[credential.status] };

    const now = Date.now();
    const [month, day] = periods(now);
    await db.batch([
      addSpend(db, ownerId, month, 1, RESERVED_MICRO_USD),
      addSpend(db, ownerId, day, 1, RESERVED_MICRO_USD),
      ...(call.reserved?.(db, now) ?? []),
    ]);

    let outcome: InferenceOutcome<T>;
    try {
      outcome = await call.invoke(createClaudeGenerationModel(credential.credential));
    } catch {
      // The roles return their errors; this only guards the reservation's correction.
      outcome = { status: "failed", error: "provider-error", calls: 1, usage: unknownUsage };
    }
    const estimate = estimateClaudeCostUsd(outcome.usage);
    const micro =
      outcome.calls === 0
        ? 0
        : estimate === undefined
          ? RESERVED_MICRO_USD * outcome.calls
          : Math.ceil(estimate * 1_000_000);
    const finished = Date.now();
    const corrections = [
      // The reservation's own periods, even when the call ended on the next UTC day.
      addSpend(db, ownerId, month, outcome.calls - 1, micro - RESERVED_MICRO_USD),
      addSpend(db, ownerId, day, outcome.calls - 1, micro - RESERVED_MICRO_USD),
    ] as const;
    // A request the role refused locally was never sent, so it is not logged (ADR 0012).
    if (outcome.calls === 0) {
      await db.batch(corrections);
      return { status: "called", outcome };
    }
    // Codes only, for the Worker's own logs; the request log row holds the rest.
    const rejection = outcome.status === "failed" ? outputRejection(outcome) : undefined;
    if (rejection)
      console.info("Model output refused", {
        role: call.role,
        promptVersion: call.promptVersion,
        rejection,
      });
    await db.batch([
      ...corrections,
      db.insert(inferenceLog).values({
        id: newId(),
        ownerId,
        role: call.role,
        provider: "anthropic",
        modelId: claudeGeneration.modelId,
        promptVersion: call.promptVersion,
        origin: call.origin,
        path: call.path,
        request: call.request,
        result: loggedResult(call, outcome),
        outcome: outcome.status === "failed" ? outcome.error : outcome.status,
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        costMicroUsd: micro,
        createdAt: finished,
      }),
      purgeExpiredLog(db, finished),
    ]);
    return { status: "called", outcome };
  } finally {
    await db
      .delete(inferenceLocks)
      .where(and(eq(inferenceLocks.ownerId, ownerId), eq(inferenceLocks.lockId, lockId)));
  }
}
