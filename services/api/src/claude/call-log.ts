import { PAGE_SAMPLE_INTERVAL_MS, pageKindSchema, parseRecipeBranch } from "@pateat/contracts";
import { type GenerationCall, type UnsentOutcome, type UnsentRequest } from "@pateat/generation";
import { irreversibleSchema, outputRejection, type InferenceOutcome } from "@pateat/inference";
import * as v from "valibot";
import { and, count, eq, gt, gte, isNull, lt, ne, notExists, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { inferenceLog, loginOutcomes, loginTimings, owners, problemLog } from "../db/schema";

import { newId } from "@pateat/contracts/ids";

import { CLAUDE_CALL_LIMITS } from "./call-budget";
import type { Db, RequestTrace } from "./call-types";

const DAY_MS = 24 * 60 * 60 * 1000;
/** The layout a request log row is for (ADR 0060): the one given, or the one `branch` names. */
export const loggedLayout = ({ layout, branch }: { layout?: string; branch: string }) =>
  layout ?? parseRecipeBranch(branch)?.layout ?? null;

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
export async function observationHash(observation: unknown) {
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

/**
 * The request log's ADR 0035 columns of a generation request: the `signedIn` hint the
 * request carried, and the page kind and `irreversible` answer of the model's plan, read
 * from its logged answer, so a plan the local checks refused keeps them too.
 */
export function pageKindColumns(request: UnsentRequest["request"], answer: unknown) {
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
export function loggedResult<T>(call: GenerationCall<T>, outcome: InferenceOutcome<T>): unknown {
  if (outcome.status === "ok") return call.logValue(outcome.value);
  if (outcome.status === "abstained") return { reason: outcome.reason };
  if (outcome.error === "refused" && outcome.refusalCategory !== undefined)
    return { refusalCategory: outcome.refusalCategory };
  const rejection = outputRejection(outcome);
  if (!rejection) return null;
  return { rejection, ...(outcome.output === undefined ? {} : { output: outcome.output }) };
}
