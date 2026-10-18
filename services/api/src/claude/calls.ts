import { INFERENCE_LOG_RETENTION_MS, type GenerationUnavailableReason } from "@pateat/contracts";
import {
  claudeGeneration,
  createClaudeGenerationModel,
  estimateClaudeCostUsd,
  outputRejection,
  unknownUsage,
  type InferenceOutcome,
} from "@pateat/inference";
import { and, eq, gt, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  inferenceLocks,
  inferenceLog,
  inferenceSpend,
  loginOutcomes,
  type inferenceLogRecipePages,
} from "../db/schema";
import { resolveClaudeCredential } from "./credentials";
import { newId } from "@pateat/contracts/ids";

// Every Claude call the service makes goes through here (ADR 0018): one call at a time
// per owner, the monthly and daily spend stops, and the ADR 0012 request
// log with its one-year retention, which also keeps requests answered without a call.

/** Request bounds shared by both roles; the same as the approved benchmark run. */
export const ROLE_LIMITS = { timeoutMs: 60_000, maxInputBytes: 64 * 1024, maxRetries: 0 };
export const MAX_OUTPUT_TOKENS = 8_192;

export const CLAUDE_CALL_LIMITS = {
  /** $100 a month (ADR 0014), estimated from returned usage. */
  monthlyMicroUsd: 100_000_000,
  /** $5 a day (UTC), counting generation and judgement alike (owner decision, 2026-10-11). */
  dailyMicroUsd: 5_000_000,
  /** Longer than the token exchange and the model timeout together. */
  lockMs: 90_000,
  /** Every request log row and login result code, for evaluation (owner decision, 2026-10-18). */
  logRetentionMs: INFERENCE_LOG_RETENTION_MS,
  /** The same request answered the same way without a call is logged once in this long. */
  unsentRepeatMs: 10 * 60 * 1000,
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
type RecipePage = (typeof inferenceLogRecipePages)[number];

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
  request: { instructions: string; observation: unknown; [key: string]: unknown };
  /**
   * The recipe the call is for, logged beside the request: the head revision it starts
   * from (0 for none) and, for generation, whether the page starts the recipe.
   */
  recipe: { recipeId: string; branch: string; baseRevision: number; page?: RecipePage };
  /** Checked under the owner's lock, before credentials are resolved. */
  gate?: (db: Db, now: number) => Promise<GenerationUnavailableReason | undefined>;
  /** Written together with the spend reservation, once a call is certain. */
  reserved?: (db: Db, now: number) => BatchItem<"sqlite">[];
  invoke: (model: ClaudeModel) => Promise<InferenceOutcome<T>>;
  /** The structured result to log for an `ok` outcome. */
  logValue: (value: T) => unknown;
};

/** What the request log keeps of a request answered without a model call (ADR 0012). */
export type UnsentRequest = Pick<
  ClaudeCall<unknown>,
  "role" | "promptVersion" | "origin" | "path" | "request" | "recipe"
>;

export type ClaudeCallResult<T> =
  | { status: "unavailable"; reason: GenerationUnavailableReason }
  /**
   * `logId` names the request log row. A call refused locally has none here: its route logs
   * it with the answer it gives (`logUnsent`).
   */
  | { status: "called"; outcome: InferenceOutcome<T>; logId?: string };

const periods = (now: number) => {
  const day = new Date(now).toISOString().slice(0, 10);
  return [day.slice(0, 7), day] as const;
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
 * Deletes request log rows and login result codes past the one-year retention. Routine
 * releases do not apply cron triggers, so this runs whenever a call or a login result is
 * logged and on every recipe sync read.
 */
export async function purgeExpiredLog(db: Db, now: number) {
  const before = now - CLAUDE_CALL_LIMITS.logRetentionMs;
  await db.batch([
    db.delete(inferenceLog).where(lt(inferenceLog.createdAt, before)),
    db.delete(loginOutcomes).where(lt(loginOutcomes.createdAt, before)),
  ]);
}

/** 12 hex digits of the SHA-256 of an observation as JSON, to count repeated pages. */
async function observationHash(observation: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(observation)),
  );
  return new Uint8Array(digest).toHex().slice(0, 12);
}

/**
 * Records the recipe revision a logged call's answer wrote on its request log row. The
 * row is written before the recipe, which may then be refused or lose to a device, so the
 * revision is set only once the write succeeded. A failed update leaves the row without
 * it and never fails the request.
 */
export async function keepLogRevision(
  db: D1Database,
  ownerId: string,
  logId: string | undefined,
  revision: number,
) {
  if (logId === undefined) return;
  try {
    await drizzle(db)
      .update(inferenceLog)
      .set({ revision })
      .where(and(eq(inferenceLog.id, logId), eq(inferenceLog.ownerId, ownerId)));
  } catch {
    console.warn("Inference log revision not kept");
  }
}

/**
 * Logs a request answered without a model call (ADR 0012, owner 2026-10-18 08:04 UTC)
 * under `outcome`, the code of that answer: the request as the model would have received
 * it, no provider, model, usage, result or answer, and no cost. The same request answered
 * the same way within ten minutes adds no row, so a client repeating a page refused as
 * `busy` or over a limit cannot fill the log. A failed write never changes the answer.
 */
export async function logUnsent(
  d1: D1Database,
  ownerId: string,
  unsent: UnsentRequest,
  outcome: string,
) {
  const db = drizzle(d1);
  const now = Date.now();
  const { recipeId, branch, baseRevision, page } = unsent.recipe;
  try {
    const hash = await observationHash(unsent.request.observation);
    const [repeated] = await db
      .select({ id: inferenceLog.id })
      .from(inferenceLog)
      .where(
        and(
          eq(inferenceLog.ownerId, ownerId),
          gt(inferenceLog.createdAt, now - CLAUDE_CALL_LIMITS.unsentRepeatMs),
          isNull(inferenceLog.modelId),
          eq(inferenceLog.outcome, outcome),
          eq(inferenceLog.role, unsent.role),
          eq(inferenceLog.promptVersion, unsent.promptVersion),
          eq(inferenceLog.origin, unsent.origin),
          eq(inferenceLog.path, unsent.path),
          eq(inferenceLog.recipeId, recipeId),
          eq(inferenceLog.branch, branch),
          eq(inferenceLog.baseRevision, baseRevision),
          eq(inferenceLog.observationHash, hash),
        ),
      )
      .limit(1);
    if (repeated) return;
    await db.insert(inferenceLog).values({
      id: newId(),
      ownerId,
      role: unsent.role,
      provider: null,
      modelId: null,
      promptVersion: unsent.promptVersion,
      origin: unsent.origin,
      path: unsent.path,
      request: unsent.request,
      result: null,
      answer: null,
      outcome,
      recipeId,
      branch,
      baseRevision,
      recipePage: page ?? null,
      build: PATEAT_BUILD_REVISION,
      observationHash: hash,
      inputTokens: null,
      outputTokens: null,
      costMicroUsd: 0,
      createdAt: now,
    });
  } catch {
    console.warn("Inference log row not kept", { role: unsent.role, outcome });
    return;
  }
  try {
    await purgeExpiredLog(db, now);
  } catch {
    console.error("Inference log purge failed");
  }
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
 * scope. Nothing is reserved, logged or sent unless every check passes; the route logs a
 * call that was not sent with the answer it gives (`logUnsent`).
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
    // A request the role refused locally was never sent: its route logs it (ADR 0012).
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
    const logId = newId();
    const { recipeId, branch, baseRevision, page } = call.recipe;
    await db.batch([
      ...corrections,
      db.insert(inferenceLog).values({
        id: logId,
        ownerId,
        role: call.role,
        provider: "anthropic",
        modelId: claudeGeneration.modelId,
        promptVersion: call.promptVersion,
        origin: call.origin,
        path: call.path,
        request: call.request,
        result: loggedResult(call, outcome),
        answer: outcome.answer ?? null,
        outcome: outcome.status === "failed" ? outcome.error : outcome.status,
        recipeId,
        branch,
        baseRevision,
        recipePage: page ?? null,
        build: PATEAT_BUILD_REVISION,
        observationHash: await observationHash(call.request.observation),
        inputTokens: outcome.usage.inputTokens,
        outputTokens: outcome.usage.outputTokens,
        costMicroUsd: micro,
        createdAt: finished,
      }),
    ]);
    try {
      await purgeExpiredLog(db, finished);
    } catch {
      console.error("Inference log purge failed");
    }
    return { status: "called", outcome, logId };
  } finally {
    await db
      .delete(inferenceLocks)
      .where(and(eq(inferenceLocks.ownerId, ownerId), eq(inferenceLocks.lockId, lockId)));
  }
}
