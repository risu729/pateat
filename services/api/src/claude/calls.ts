import {
  DEVICE_MODEL_URL,
  deviceModelHeaderNames,
  deviceModelRequestHash,
  INFERENCE_LOG_RETENTION_MS,
  PAGE_SAMPLE_INTERVAL_MS,
  pageKindSchema,
  parseRecipeBranch,
  type DeviceModel,
  type DeviceModelCall,
  type GenerationUnavailableReason,
} from "@pateat/contracts";
import {
  choiceAttempts,
  MAX_OUTPUT_TOKENS,
  nextAttempt,
  ROLE_LIMITS,
  roleChoices,
  servedModel,
  type GenerationCall,
  type GenerationCallResult,
  type GenerationCallTimings,
  type RoleChoice,
  type UnsentOutcome,
  type UnsentRequest,
} from "@pateat/generation";
import {
  claudeWorstCaseRates,
  createClaudeGenerationModel,
  estimateClaudeCostUsd,
  irreversibleSchema,
  outputRejection,
  unknownUsage,
  type ClaudeCredential,
  type ClaudeModelChoice,
  type InferenceOutcome,
} from "@pateat/inference";
import * as v from "valibot";
import { and, count, eq, gt, gte, inArray, isNull, lt, lte, ne, notExists, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import {
  inferenceLocks,
  inferenceLog,
  inferenceSpend,
  loginOutcomes,
  loginTimings,
  owners,
  problemLog,
} from "../db/schema";
import { resolveClaudeCredential } from "./credentials";
import { fastFailingModels, readModelConfig } from "./models";
import { newId } from "@pateat/contracts/ids";

// Every Claude call the service makes goes through here (ADR 0018): at most
// `CLAUDE_CALL_LIMITS.concurrentCalls` requests at a time per owner, the monthly and daily
// spend stops, and the ADR 0012 request log with its one-year retention, which also keeps
// requests answered without a call.

export const CLAUDE_CALL_LIMITS = {
  /** $100 a month (ADR 0014), estimated from returned usage. */
  monthlyMicroUsd: 100_000_000,
  /** $5 a day (UTC), counting generation and judgement alike (owner decision, 2026-10-11). */
  dailyMicroUsd: 5_000_000,
  /**
   * Requests of one owner whose calls run at once, against abuse; more answer `busy`. Five
   * stays acceptable once Pateat is public (owner decision, 2026-10-23 22:05-22:06 UTC).
   */
  concurrentCalls: 5,
  /**
   * How long a request holds its slot: longer than the token exchange and the most calls
   * one request makes in turn, up to three choices, each fast then standard, at the 10 s
   * model timeout.
   */
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
 * What a call is charged when the provider reports no usage: its upper bound at its
 * model's rates, since a request holds at most `maxInputBytes` tokens (ADR 0003).
 */
const worstCaseMicroUsd = ({ rates }: ClaudeModelChoice) => {
  const { input, output } = claudeWorstCaseRates(rates, ROLE_LIMITS.maxInputBytes);
  return ROLE_LIMITS.maxInputBytes * input + MAX_OUTPUT_TOKENS * output;
};

type Db = DrizzleD1Database<Record<string, never>>;
const DAY_MS = 24 * 60 * 60 * 1000;
type CallEnv = { DB: D1Database; OIDC_ISSUER?: string; OIDC_SIGNING_KEYS?: string };
/** The layout a request log row is for (ADR 0060): the one given, or the one `branch` names. */
const loggedLayout = ({ layout, branch }: { layout?: string; branch: string }) =>
  layout ?? parseRecipeBranch(branch)?.layout ?? null;

/**
 * One request's timing: when the Worker received it, the call `callClaude` made for it,
 * which the request's middleware reports in `Server-Timing`, and the request log row it
 * wrote (`logId`), by `callClaude` or, for a request answered without a call, by
 * `logUnsent`, which the middleware completes with the server time once the response is
 * out.
 */
export type RequestTrace = {
  startedAt: number;
  /**
   * Keeps a promise running after the response or a client disconnect (the request's
   * `waitUntil`), so a call already sent is still charged and logged.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
  call?: GenerationCallResult<unknown>;
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

/**
 * Takes the first of the owner's call slots that is free or abandoned (its request ended
 * without releasing it), each with one conditional statement, so two requests never hold
 * the same slot. Returns undefined while every slot is held.
 */
async function acquireSlot(db: Db, ownerId: string, now: number) {
  const lockId = newId();
  const expiresAt = now + CLAUDE_CALL_LIMITS.lockMs;
  for (let slot = 0; slot < CLAUDE_CALL_LIMITS.concurrentCalls; slot++) {
    // oxlint-disable-next-line no-await-in-loop
    const result = await db
      .insert(inferenceLocks)
      .values({ ownerId, slot, lockId, expiresAt })
      .onConflictDoUpdate({
        target: [inferenceLocks.ownerId, inferenceLocks.slot],
        set: { lockId, expiresAt },
        setWhere: lte(inferenceLocks.expiresAt, now),
      })
      .run();
    if (result.meta.changes === 1) return { slot, lockId };
  }
  return undefined;
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
 * Deletes request log rows, login result codes, login records and devices' problem lines
 * (ADR 0066) past the one-year retention. Routine
 * releases do not apply cron triggers, so this runs whenever a call, a login result, a
 * login record or problem lines are logged and on every recipe sync read.
 */
export async function purgeExpiredLog(db: Db, now: number) {
  const before = now - CLAUDE_CALL_LIMITS.logRetentionMs;
  await db.batch([
    db.delete(inferenceLog).where(lt(inferenceLog.createdAt, before)),
    db.delete(loginOutcomes).where(lt(loginOutcomes.createdAt, before)),
    db.delete(loginTimings).where(lt(loginTimings.createdAt, before)),
    db.delete(problemLog).where(lt(problemLog.createdAt, before)),
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
      layout: loggedLayout(unsent.recipe),
      baseRevision,
      recipePage: page ?? null,
      ...pageKindColumns(unsent.request, null),
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
          source: sql`'service'`.as("source"),
          modelId: sql`NULL`.as("model_id"),
          effort: sql`NULL`.as("effort"),
          speed: sql`NULL`.as("speed"),
          promptVersion: sql`${sample.promptVersion}`.as("prompt_version"),
          origin: sql`${sample.origin}`.as("origin"),
          path: sql`${sample.path}`.as("path"),
          request: sql`${JSON.stringify(sample.request)}`.as("request"),
          result: sql`NULL`.as("result"),
          answer: sql`NULL`.as("answer"),
          outcome: sql`'sampled'`.as("outcome"),
          recipeId: sql`${recipeId}`.as("recipe_id"),
          branch: sql`${branch}`.as("branch"),
          layout: sql`${loggedLayout(sample.recipe)}`.as("layout"),
          baseRevision: sql`${baseRevision}`.as("base_revision"),
          revision: sql`NULL`.as("revision"),
          recipePage: sql`NULL`.as("recipe_page"),
          signedIn: sql`NULL`.as("signed_in"),
          pageKind: sql`NULL`.as("page_kind"),
          irreversible: sql`NULL`.as("irreversible"),
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
 * The request log's ADR 0035 columns of a generation request: the `signedIn` hint the
 * request carried, and the page kind and `irreversible` answer of the model's plan, read
 * from its logged answer, so a plan the local checks refused keeps them too.
 */
function pageKindColumns(request: UnsentRequest["request"], answer: unknown) {
  const plan = v.safeParse(answeredPlanSchema, answer);
  return {
    signedIn: typeof request["signedIn"] === "boolean" ? request["signedIn"] : null,
    pageKind: plan.success ? plan.output.pageKind : null,
    irreversible: plan.success ? plan.output.irreversible : null,
  };
}
const answeredPlanSchema = v.object({
  decision: v.literal("plan"),
  pageKind: pageKindSchema,
  irreversible: irreversibleSchema,
});

/**
 * What the request log keeps of a call's result: the structured result for `ok`, the
 * abstention reason, for refused output which check refused it, with the output
 * reduced to references the request holds when the role kept one (ADR 0012), and for a
 * `refused` call the provider's refusal category code when it reported one (ADR 0014),
 * never its explanation.
 */
function loggedResult<T>(call: GenerationCall<T>, outcome: InferenceOutcome<T>): unknown {
  if (outcome.status === "ok") return call.logValue(outcome.value);
  if (outcome.status === "abstained") return { reason: outcome.reason };
  if (outcome.error === "refused" && outcome.refusalCategory !== undefined)
    return { refusalCategory: outcome.refusalCategory };
  const rejection = outputRejection(outcome);
  if (!rejection) return null;
  return { rejection, ...(outcome.output === undefined ? {} : { output: outcome.output }) };
}

/**
 * Makes one role call for the authenticated owner and records its result on `trace`.
 * `ownerId` must come from the request scope. Nothing is charged, logged or sent unless
 * every check passes; the route logs a call that was not sent with the answer it gives
 * (`logUnsent`).
 */
export async function callClaude<T>(
  env: CallEnv,
  ownerId: string,
  trace: RequestTrace,
  call: GenerationCall<T>,
): Promise<GenerationCallResult<T>> {
  // A client that disconnects mid-call must not end the Worker before the call is charged
  // (ADR 0014): nothing is reserved before it.
  const running = runCall(env, ownerId, call, trace.startedAt);
  trace.waitUntil?.(running);
  const result = await running;
  trace.call = result;
  if (result.status === "called" && result.logId !== undefined) trace.logId = result.logId;
  return result;
}

type Called<T> = Extract<GenerationCallResult<T>, { status: "called" }>;

/**
 * A request's `beforeSend` writes, run once before its first model request. `settled`
 * waits for a write that outlived the call, as one the role's timeout cut short; `ms` is
 * its duration, which belongs before the model call.
 */
type Reservation = {
  run: () => Promise<void>;
  settled: () => Promise<void>;
  ms: number;
  error?: unknown;
};

/** A request `beforeSend` stopped before its first model request, with the answer's reason. */
class Unsent extends Error {
  readonly reason: GenerationUnavailableReason;
  constructor(reason: GenerationUnavailableReason) {
    super("Model call not sent");
    this.reason = reason;
  }
}

function reserveOnce(write: () => Promise<void>): Reservation {
  let written: Promise<void> | undefined;
  const reservation: Reservation = {
    run: () => {
      written ??= (async () => {
        const start = Date.now();
        try {
          await write();
        } catch (error) {
          reservation.error = error;
          throw error;
        }
        reservation.ms = Date.now() - start;
      })();
      return written;
    },
    settled: async () => {
      await written?.catch(() => {});
    },
    ms: 0,
  };
  return reservation;
}

/** Whose key a request's calls use: the owner's credential, or the device's (ADR 0040). */
type CallerKey =
  | { credential: ClaudeCredential }
  /** `index` is the call's place among the request's calls, so its response's. */
  | { device: DeviceModel; index: number };

/**
 * The fetch of a call the device makes (ADR 0040). With the device's response for this
 * call, it answers with that response once the request's `beforeSend` writes ran, as a
 * sent call would; without one, or when this run built another body than the one the
 * device sent, it keeps the call in `next` for the device to make and fails the role's
 * request, which is then neither charged nor logged.
 */
function deviceRelay(
  caller: { device: DeviceModel; index: number },
  /** Absent for a dry run, which writes nothing. */
  reservation: Reservation | undefined,
) {
  const relay: {
    fetch: typeof globalThis.fetch;
    next?: DeviceModelCall["call"];
    timedOut?: true;
  } = {
    fetch: async (input, init) => {
      const outbound = new Request(input, init);
      // The provider adapter pins the URL; anything else is never handed to the device.
      if (outbound.url !== DEVICE_MODEL_URL || outbound.method !== "POST")
        throw new TypeError("Unexpected model request");
      const body = await outbound.text();
      const response = caller.device.responses[caller.index];
      if (!response || response.request !== (await deviceModelRequestHash(body))) {
        const headers: Partial<Record<(typeof deviceModelHeaderNames)[number], string>> = {};
        for (const name of deviceModelHeaderNames) {
          const value = outbound.headers.get(name);
          if (value !== null) headers[name] = value;
        }
        relay.next = { index: caller.index, headers, body };
        throw new Error("Model call left to the device");
      }
      await reservation?.run();
      if (response.kind === "timeout") relay.timedOut = true;
      if (response.kind !== "response") throw new Error("No model response on the device");
      return new Response(response.body, {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return relay;
}

async function runCall<T>(
  env: CallEnv,
  ownerId: string,
  call: GenerationCall<T>,
  startedAt: number,
): Promise<GenerationCallResult<T>> {
  const db = drizzle(env.DB);
  const start = Date.now();
  const held = await acquireSlot(db, ownerId, start);
  if (!held) return { status: "unavailable", reason: "busy" };
  try {
    const { device } = call;
    // The spend stops count the owner's credential only; a device's key pays its own calls.
    const blocked =
      (await call.gate?.(start)) ?? (device ? undefined : await limitReached(db, ownerId, start));
    if (blocked) return { status: "unavailable", reason: blocked };

    let caller: CallerKey;
    let tokenMs = 0;
    if (device) caller = { device, index: 0 };
    else {
      const tokenStart = Date.now();
      const credential = await resolveClaudeCredential(env, ownerId);
      tokenMs = Date.now() - tokenStart;
      if (credential.status !== "ready")
        return { status: "unavailable", reason: credentialUnavailable[credential.status], tokenMs };
      caller = { credential: credential.credential };
    }

    const [{ config }, fastFailing] = await Promise.all([
      readModelConfig(env.DB, ownerId),
      fastFailingModels(env.DB, ownerId, Date.now(), device ? "device" : "service"),
    ]);
    const choices = roleChoices(config, call.role, fastFailing);
    const reservation = reserveOnce(async () => {
      const refused = await call.beforeSend?.(Date.now());
      if (refused) throw new Unsent(refused);
    });

    // The role's choices in order (owner decision, 2026-10-23 11:31 UTC): a refusal asks
    // the next choice; fast mode that failed asks the same model at the standard speed; any
    // other failure ends the request. Each call first checks the spend stops. The calls
    // depend on each other's outcome, so they run in turn. A `dry` run writes and logs
    // nothing: it only finds whether the device still has a call to make (ADR 0040).
    const run = async (
      dry: boolean,
    ): Promise<Called<T> | Extract<GenerationCallResult<T>, { status: "device-call" }>> => {
      let last: Called<T> | undefined;
      let key = caller;
      for (const attempt of choices.flatMap(choiceAttempts)) {
        if (last !== undefined) {
          const next = nextAttempt(last, attempt);
          if (next === "skip") continue;
          // oxlint-disable-next-line no-await-in-loop
          if (next === "stop" || (!device && (await limitReached(db, ownerId, Date.now())))) {
            break;
          }
        }
        // Later calls' time before the model includes the calls before; they run no exchange.
        // oxlint-disable-next-line no-await-in-loop
        const sent = await sendCall(
          db,
          ownerId,
          call,
          { choice: attempt, caller: key, reservation, dry },
          { startedAt, tokenMs: last === undefined ? tokenMs : 0 },
        );
        if ("deviceCall" in sent) return { status: "device-call", call: sent.deviceCall };
        if ("device" in key) key = { ...key, index: key.index + 1 };
        last = {
          status: "called",
          ...sent,
          timings: last
            ? { ...last.timings, modelMs: last.timings.modelMs + sent.timings.modelMs }
            : sent.timings,
          served: servedModel(attempt),
        };
      }
      return last!;
    };
    // The device's responses take effect only once it has made every call the request needs,
    // so a request it answers in several runs reserves its attempt and logs its calls once.
    if (device) {
      const probe = await run(true);
      if (probe.status === "device-call") return probe;
    }
    try {
      return await run(false);
    } catch (error) {
      // `beforeSend` stopped the request before its first model request was sent.
      if (error instanceof Unsent) return { status: "unavailable", reason: error.reason };
      throw error;
    }
  } finally {
    // Only this request's slot: one it lost after `lockMs` belongs to another request now.
    await db
      .delete(inferenceLocks)
      .where(
        and(
          eq(inferenceLocks.ownerId, ownerId),
          eq(inferenceLocks.slot, held.slot),
          eq(inferenceLocks.lockId, held.lockId),
        ),
      );
  }
}

/**
 * Sends one model call for `runCall`, in its slot, then charges it to the spend stops
 * from reported usage at its model's rates (the worst case when usage is unknown) and logs
 * it. Nothing is reserved before the call (owner, 2026-10-23 11:31 and 12:16 UTC): with at
 * most `concurrentCalls` requests at a time per owner, a stop is overshot by at most the
 * calls running when it was crossed (owner, 2026-10-23 22:05 UTC).
 * `callClaude` keeps the calls running past a client disconnect so each is charged. A
 * request the role refused locally was never sent, so it gets no log row here: its route
 * logs it (ADR 0012).
 */
async function sendCall<T>(
  db: Db,
  ownerId: string,
  call: GenerationCall<T>,
  model: { choice: RoleChoice; caller: CallerKey; reservation: Reservation; dry?: boolean },
  time: { startedAt: number; tokenMs: number },
): Promise<
  | { outcome: InferenceOutcome<T>; logId?: string; timings: GenerationCallTimings }
  | { deviceCall: DeviceModelCall["call"] }
> {
  const { choice, caller, reservation, dry } = model;
  // The periods the call started in, even when it ends on the next UTC day.
  const [month, day] = periods(Date.now());

  let outcome: InferenceOutcome<T>;
  const modelStart = Date.now();
  const relay = "device" in caller ? deviceRelay(caller, dry ? undefined : reservation) : undefined;
  try {
    outcome = await call.invoke(
      "device" in caller
        ? // No key is sent: the relay hands the request to the device instead.
          createClaudeGenerationModel({ apiKey: "device", choice, fetch: relay!.fetch })
        : createClaudeGenerationModel({
            ...caller.credential,
            choice,
            beforeRequest: reservation.run,
          }),
    );
  } catch {
    // The roles return their errors; this only guards the spend and the log row.
    outcome = { status: "failed", error: "provider-error", calls: 1, usage: unknownUsage };
  }
  // A call the device has not made yet: nothing was written, charged or logged for it.
  if (relay?.next) return { deviceCall: relay.next };
  // The device's own time limit ran out, which the role cannot tell from a failed request.
  if (relay?.timedOut && outcome.status === "failed") outcome = { ...outcome, error: "timeout" };
  if (dry) return { outcome, timings: { preModelMs: 0, tokenMs: 0, modelMs: 0 } };
  // A failed write stopped the request before it was sent, so it fails as before a call.
  await reservation.settled();
  if (reservation.error !== undefined) throw reservation.error;
  // Date.now() advances across I/O on Workers, which is all these spans wait on. The
  // first call's writes count before the model call, as they did before it was sent.
  const reservedMs = reservation.ms;
  reservation.ms = 0;
  const timings = {
    preModelMs: modelStart - time.startedAt + reservedMs,
    tokenMs: time.tokenMs,
    modelMs: Date.now() - modelStart - reservedMs,
  };
  const estimate = estimateClaudeCostUsd(outcome.usage, choice.rates);
  if (outcome.calls === 0) return { outcome, timings };
  const source = relay ? "device" : "service";
  const micro =
    estimate === undefined
      ? worstCaseMicroUsd(choice) * outcome.calls
      : Math.ceil(estimate * 1_000_000);
  const finished = Date.now();
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
    db.insert(inferenceLog).values({
      id: logId,
      ownerId,
      role: call.role,
      provider: "anthropic",
      source,
      modelId: choice.modelId,
      effort: choice.effort,
      speed: choice.speed,
      promptVersion: call.promptVersion,
      origin: call.origin,
      path: call.path,
      request: call.request,
      result: loggedResult(call, outcome),
      answer: outcome.answer ?? null,
      outcome: outcome.status === "failed" ? outcome.error : outcome.status,
      recipeId,
      branch,
      layout: loggedLayout(call.recipe),
      baseRevision,
      recipePage: page ?? null,
      ...pageKindColumns(call.request, outcome.answer),
      build: PATEAT_BUILD_REVISION,
      observationHash: await observationHash(call.request.observation),
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      costMicroUsd: micro,
      ...timings,
      // The device's token exchange and model call happen where the service cannot time them.
      ...(relay ? { tokenMs: null, modelMs: null } : {}),
      createdAt: finished,
    }),
    // The spend stops count the owner's credential only (ADR 0040).
    ...(relay
      ? []
      : [
          addSpend(db, ownerId, month, outcome.calls, micro),
          addSpend(db, ownerId, day, outcome.calls, micro),
        ]),
  ]);
  try {
    await purgeExpiredLog(db, finished);
  } catch {
    console.error("Inference log purge failed");
  }
  return { outcome, logId, timings };
}
