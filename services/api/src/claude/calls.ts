import {
  INFERENCE_LOG_RETENTION_MS,
  PAGE_SAMPLE_INTERVAL_MS,
  type GenerationUnavailableReason,
  type RecipeGenerationResult,
} from "@pateat/contracts";
import {
  claudeRoles,
  createClaudeModel,
  estimateClaudeCostUsd,
  type ClaudeRole,
  outputRejection,
  unknownUsage,
  type InferenceOutcome,
} from "@pateat/inference";
import { and, count, eq, gt, gte, inArray, isNull, lt, lte, ne, notExists, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  inferenceLocks,
  inferenceLog,
  inferenceSpend,
  loginOutcomes,
  loginTimings,
  owners,
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
  /**
   * Rows of requests answered without a call per owner and UTC day, since spend no longer
   * bounds them (agent's choice, not confirmed by the owner).
   */
  unsentRowsPerDay: 500,
};

/**
 * Charged before each call at its role's rates and corrected afterwards, so a request
 * that never finishes still counts. Usage the provider does not report keeps this upper
 * bound: a request holds at most `maxInputBytes` tokens.
 */
const reservedMicroUsd = (role: ClaudeRole) =>
  ROLE_LIMITS.maxInputBytes * claudeRoles[role].rates.input +
  MAX_OUTPUT_TOKENS * claudeRoles[role].rates.output;

type Db = DrizzleD1Database<Record<string, never>>;
const DAY_MS = 24 * 60 * 60 * 1000;
type CallEnv = { DB: D1Database; OIDC_ISSUER?: string; OIDC_SIGNING_KEYS?: string };
type ClaudeModel = ReturnType<typeof createClaudeModel>;
type RecipePage = (typeof inferenceLogRecipePages)[number];

export type ClaudeCall<T> = {
  role: ClaudeRole;
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

/**
 * The code a request answered without a model call is logged under: its unavailable
 * reason or failure code, or `recipe` for a recipe another request stored.
 */
export type UnsentOutcome =
  | GenerationUnavailableReason
  | Extract<RecipeGenerationResult, { status: "failed" }>["error"]
  | "recipe";

/**
 * Milliseconds a call spent, as its request log row keeps them: from the request's start
 * to just before the model call, the credential's token exchange, and the model call.
 */
export type ClaudeCallTimings = { preModelMs: number; tokenMs: number; modelMs: number };

export type ClaudeCallResult<T> =
  /** `tokenMs` once the credential step ran, as for a missing credential or a failed exchange. */
  | { status: "unavailable"; reason: GenerationUnavailableReason; tokenMs?: number }
  /**
   * `logId` names the request log row. A call refused locally has none here: its route logs
   * it with the answer it gives (`logUnsent`).
   */
  | {
      status: "called";
      outcome: InferenceOutcome<T>;
      logId?: string;
      timings: ClaudeCallTimings;
    };

/**
 * One request's timing: when the Worker received it, the call `callClaude` made for it,
 * which the request's middleware reports in `Server-Timing`, and the request log row it
 * wrote (`logId`), by `callClaude` or, for a request answered without a call, by
 * `logUnsent`, which the middleware completes with the server time once the response is
 * out.
 */
export type RequestTrace = {
  startedAt: number;
  call?: ClaudeCallResult<unknown>;
  logId?: string;
};

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
 * Deletes request log rows, login result codes and login records past the one-year
 * retention. Routine releases do not apply cron triggers, so this runs whenever a call, a
 * login result or a login record is logged and on every recipe sync read.
 */
export async function purgeExpiredLog(db: Db, now: number) {
  const before = now - CLAUDE_CALL_LIMITS.logRetentionMs;
  await db.batch([
    db.delete(inferenceLog).where(lt(inferenceLog.createdAt, before)),
    db.delete(loginOutcomes).where(lt(loginOutcomes.createdAt, before)),
    db.delete(loginTimings).where(lt(loginTimings.createdAt, before)),
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
 * `busy` or over a limit cannot fill the log, and past `unsentRowsPerDay` rows an owner's
 * UTC day adds none; signed-in page samples (`logPageSample`) do not count toward it. The
 * checks and the insert are not atomic, so two identical requests at once can both be
 * logged. A failed write never changes the answer. The row has no time before the model,
 * token exchange or model call; it names itself on `trace`, so the request's middleware
 * records its server time.
 */
export async function logUnsent(
  d1: D1Database,
  ownerId: string,
  unsent: UnsentRequest,
  outcome: UnsentOutcome,
  trace: RequestTrace,
) {
  const db = drizzle(d1);
  const now = Date.now();
  const { recipeId, branch, baseRevision, page } = unsent.recipe;
  try {
    const unsentOfOwner = and(eq(inferenceLog.ownerId, ownerId), isNull(inferenceLog.modelId));
    const [today] = await db
      .select({ rows: count() })
      .from(inferenceLog)
      .where(
        and(
          unsentOfOwner,
          // Signed-in page samples have their own once-in-30-days bound (ADR 0029).
          ne(inferenceLog.outcome, "sampled"),
          gte(inferenceLog.createdAt, now - (now % DAY_MS)),
        ),
      );
    if ((today?.rows ?? 0) >= CLAUDE_CALL_LIMITS.unsentRowsPerDay) {
      console.warn("Inference log row over the daily cap", { role: unsent.role, outcome });
      return;
    }
    const [repeated] = await db
      .select({ id: inferenceLog.id })
      .from(inferenceLog)
      .where(
        and(
          unsentOfOwner,
          gt(inferenceLog.createdAt, now - CLAUDE_CALL_LIMITS.unsentRepeatMs),
          eq(inferenceLog.outcome, outcome),
          eq(inferenceLog.role, unsent.role),
          eq(inferenceLog.promptVersion, unsent.promptVersion),
          eq(inferenceLog.origin, unsent.origin),
          eq(inferenceLog.path, unsent.path),
          eq(inferenceLog.recipeId, recipeId),
          eq(inferenceLog.branch, branch),
          eq(inferenceLog.baseRevision, baseRevision),
          // The whole request as stored, so other slots or another judged route count.
          eq(inferenceLog.request, unsent.request),
        ),
      )
      .limit(1);
    if (repeated) return;
    const id = newId();
    await db.insert(inferenceLog).values({
      id,
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
      observationHash: await observationHash(unsent.request.observation),
      inputTokens: null,
      outputTokens: null,
      costMicroUsd: 0,
      createdAt: now,
    });
    trace.logId = id;
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

/**
 * Records how long the Worker took to answer the request on its request log row, whatever
 * the answer wrote. A failed update leaves the row without it and never fails the request.
 */
export async function keepServerTime(
  db: D1Database,
  ownerId: string,
  logId: string,
  serverMs: number,
) {
  try {
    await drizzle(db)
      .update(inferenceLog)
      .set({ serverMs })
      .where(and(eq(inferenceLog.id, logId), eq(inferenceLog.ownerId, ownerId)));
  } catch {
    console.warn("Inference log server time not kept");
  }
}

/**
 * Keeps a repeat login's signed-in page (ADR 0029, owner 2026-10-18 08:05 UTC) as a `judge`
 * row with the outcome `sampled`: the request built as the judge's would be (the judge
 * route answers such a page `not-judgeable` and never sends it), no provider, model, usage,
 * result or answer, and no cost. The statement writes the row only while the owner has no
 * `sampled` row of the recipe and branch in the last `PAGE_SAMPLE_INTERVAL_MS`, so two
 * devices sending at once keep one. Like a request answered without a call, the row has no
 * time before the model, token exchange or model call; a row it writes names itself on
 * `trace` for its server time. Returns whether it wrote one.
 */
export async function logPageSample(
  d1: D1Database,
  ownerId: string,
  sample: UnsentRequest,
  trace: RequestTrace,
) {
  const db = drizzle(d1);
  const now = Date.now();
  const id = newId();
  const { recipeId, branch, baseRevision } = sample.recipe;
  const hash = await observationHash(sample.request.observation);
  // Drizzle fills INSERT ... SELECT positionally: keep these in the inferenceLog column order.
  const written = await db
    .insert(inferenceLog)
    .select(
      db
        .select({
          id: sql`${id}`.as("id"),
          ownerId: owners.id,
          role: sql`${sample.role}`.as("role"),
          provider: sql`NULL`.as("provider"),
          modelId: sql`NULL`.as("model_id"),
          promptVersion: sql`${sample.promptVersion}`.as("prompt_version"),
          origin: sql`${sample.origin}`.as("origin"),
          path: sql`${sample.path}`.as("path"),
          request: sql`${JSON.stringify(sample.request)}`.as("request"),
          result: sql`NULL`.as("result"),
          answer: sql`NULL`.as("answer"),
          outcome: sql`'sampled'`.as("outcome"),
          recipeId: sql`${recipeId}`.as("recipe_id"),
          branch: sql`${branch}`.as("branch"),
          baseRevision: sql`${baseRevision}`.as("base_revision"),
          revision: sql`NULL`.as("revision"),
          recipePage: sql`NULL`.as("recipe_page"),
          build: sql`${PATEAT_BUILD_REVISION}`.as("build"),
          observationHash: sql`${hash}`.as("observation_hash"),
          inputTokens: sql`NULL`.as("input_tokens"),
          outputTokens: sql`NULL`.as("output_tokens"),
          costMicroUsd: sql`0`.as("cost_micro_usd"),
          preModelMs: sql`NULL`.as("pre_model_ms"),
          tokenMs: sql`NULL`.as("token_ms"),
          modelMs: sql`NULL`.as("model_ms"),
          serverMs: sql`NULL`.as("server_ms"),
          createdAt: sql`${now}`.as("created_at"),
        })
        .from(owners)
        .where(
          and(
            eq(owners.id, ownerId),
            notExists(
              db
                .select({ id: inferenceLog.id })
                .from(inferenceLog)
                .where(
                  and(
                    eq(inferenceLog.ownerId, ownerId),
                    eq(inferenceLog.outcome, "sampled"),
                    eq(inferenceLog.recipeId, recipeId),
                    eq(inferenceLog.branch, branch),
                    gt(inferenceLog.createdAt, now - PAGE_SAMPLE_INTERVAL_MS),
                  ),
                ),
            ),
          ),
        ),
    )
    .run();
  const kept = written.meta.changes === 1;
  if (kept) trace.logId = id;
  try {
    await purgeExpiredLog(db, now);
  } catch {
    console.error("Inference log purge failed");
  }
  return kept;
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
 * Makes one role call for the authenticated owner and records its result on `trace`.
 * `ownerId` must come from the request scope. Nothing is reserved, logged or sent unless
 * every check passes; the route logs a call that was not sent with the answer it gives
 * (`logUnsent`).
 */
export async function callClaude<T>(
  env: CallEnv,
  ownerId: string,
  trace: RequestTrace,
  call: ClaudeCall<T>,
): Promise<ClaudeCallResult<T>> {
  const result = await runCall(env, ownerId, call, trace.startedAt);
  trace.call = result;
  if (result.status === "called" && result.logId !== undefined) trace.logId = result.logId;
  return result;
}

async function runCall<T>(
  env: CallEnv,
  ownerId: string,
  call: ClaudeCall<T>,
  startedAt: number,
): Promise<ClaudeCallResult<T>> {
  const db = drizzle(env.DB);
  const start = Date.now();
  const lockId = await acquireLock(db, ownerId, start);
  if (!lockId) return { status: "unavailable", reason: "busy" };
  try {
    const blocked = (await call.gate?.(db, start)) ?? (await limitReached(db, ownerId, start));
    if (blocked) return { status: "unavailable", reason: blocked };

    const tokenStart = Date.now();
    const credential = await resolveClaudeCredential(env, ownerId);
    const tokenMs = Date.now() - tokenStart;
    if (credential.status !== "ready")
      return { status: "unavailable", reason: credentialUnavailable[credential.status], tokenMs };

    const now = Date.now();
    const [month, day] = periods(now);
    const reserved = reservedMicroUsd(call.role);
    await db.batch([
      addSpend(db, ownerId, month, 1, reserved),
      addSpend(db, ownerId, day, 1, reserved),
      ...(call.reserved?.(db, now) ?? []),
    ]);

    let outcome: InferenceOutcome<T>;
    const modelStart = Date.now();
    try {
      outcome = await call.invoke(createClaudeModel({ ...credential.credential, role: call.role }));
    } catch {
      // The roles return their errors; this only guards the reservation's correction.
      outcome = { status: "failed", error: "provider-error", calls: 1, usage: unknownUsage };
    }
    // Date.now() advances across I/O on Workers, which is all these spans wait on.
    const timings = {
      preModelMs: modelStart - startedAt,
      tokenMs,
      modelMs: Date.now() - modelStart,
    };
    const estimate = estimateClaudeCostUsd(outcome.usage, call.role);
    const micro =
      outcome.calls === 0
        ? 0
        : estimate === undefined
          ? reserved * outcome.calls
          : Math.ceil(estimate * 1_000_000);
    const finished = Date.now();
    const corrections = [
      // The reservation's own periods, even when the call ended on the next UTC day.
      addSpend(db, ownerId, month, outcome.calls - 1, micro - reserved),
      addSpend(db, ownerId, day, outcome.calls - 1, micro - reserved),
    ] as const;
    // A request the role refused locally was never sent: its route logs it (ADR 0012).
    if (outcome.calls === 0) {
      await db.batch(corrections);
      return { status: "called", outcome, timings };
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
        modelId: claudeRoles[call.role].modelId,
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
        ...timings,
        createdAt: finished,
      }),
    ]);
    try {
      await purgeExpiredLog(db, finished);
    } catch {
      console.error("Inference log purge failed");
    }
    return { status: "called", outcome, logId, timings };
  } finally {
    await db
      .delete(inferenceLocks)
      .where(and(eq(inferenceLocks.ownerId, ownerId), eq(inferenceLocks.lockId, lockId)));
  }
}
