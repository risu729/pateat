import type { GenerationBackend } from "@pateat/generation";
import { and, count, eq, gt, gte, inArray, lt, notInArray, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { DeviceScope } from "../auth";
import {
  callClaude,
  keepLogRevision,
  logPageSample,
  logUnsent,
  type RequestTrace,
} from "../claude/calls";
import { generationAttempts, pageJudgements, recipeRepairs } from "../db/schema";
import {
  hasRecipeByteRoom,
  hasRecipeRoom,
  markLayoutUsed,
  readHead,
  readLayoutUses,
  readRevision,
  writeRecipe,
} from "../recipe-store";
import { recipeBindingSlots } from "../settings-store";

type GenerationEnv = { DB: D1Database; OIDC_ISSUER?: string; OIDC_SIGNING_KEYS?: string };

/**
 * The generation routes' backend on the service (ADR 0040): the owner's D1 rows and
 * credential, for one device's request, whose model calls `trace` records.
 */
export function d1Backend(
  env: GenerationEnv,
  scope: DeviceScope,
  trace: RequestTrace,
): GenerationBackend {
  const { ownerId, deviceId } = scope;
  const db = drizzle(env.DB);
  const judgementOf = (key: Parameters<GenerationBackend["judgement"]>[0]) =>
    and(
      eq(pageJudgements.ownerId, ownerId),
      eq(pageJudgements.recipeId, key.recipeId),
      eq(pageJudgements.branch, key.branch),
      eq(pageJudgements.revision, key.revision),
      eq(pageJudgements.origin, key.origin),
      eq(pageJudgements.path, key.path),
      eq(pageJudgements.promptVersion, key.promptVersion),
    );
  return {
    deviceId,
    readHead: (recipeId) => readHead(env.DB, ownerId, recipeId),
    readRevision: (recipeId, revision) => readRevision(env.DB, ownerId, recipeId, revision),
    hasRecipeRoom: () => hasRecipeRoom(env.DB, ownerId),
    hasRecipeByteRoom: (bytes) => hasRecipeByteRoom(env.DB, ownerId, bytes),
    bindingSlots: (origin, recipeId) => recipeBindingSlots(env.DB, ownerId, origin, recipeId),
    layoutUses: async (recipeId) => (await readLayoutUses(env.DB, ownerId, recipeId)).get(recipeId),
    markLayoutUsed: async (recipeId, layout) => {
      await markLayoutUsed(db, ownerId, recipeId, layout, Date.now());
    },
    writeRecipe: (recipeId, write, options) =>
      writeRecipe(env.DB, ownerId, recipeId, write, deviceId, options),

    attemptedSince: async (key, since) => {
      const [recent] = await db
        .select()
        .from(generationAttempts)
        .where(
          and(
            eq(generationAttempts.ownerId, ownerId),
            eq(generationAttempts.recipeId, key.recipeId),
            eq(generationAttempts.branch, key.branch),
            eq(generationAttempts.path, key.path),
            eq(generationAttempts.baseRevision, key.baseRevision),
            gt(generationAttempts.attemptedAt, since),
          ),
        )
        .limit(1);
      return recent !== undefined;
    },
    recordAttempt: async (key, now, expired) => {
      await db.batch([
        db
          .insert(generationAttempts)
          .values({ ownerId, ...key, attemptedAt: now })
          .onConflictDoUpdate({
            target: [
              generationAttempts.ownerId,
              generationAttempts.recipeId,
              generationAttempts.branch,
              generationAttempts.path,
              generationAttempts.baseRevision,
            ],
            set: { attemptedAt: now },
          }),
        db
          .delete(generationAttempts)
          .where(
            and(
              eq(generationAttempts.ownerId, ownerId),
              lt(generationAttempts.attemptedAt, expired),
            ),
          ),
      ]);
    },
    repairedSince: async (recipeId, since) => {
      const [recent] = await db
        .select()
        .from(recipeRepairs)
        .where(
          and(
            eq(recipeRepairs.ownerId, ownerId),
            eq(recipeRepairs.recipeId, recipeId),
            eq(recipeRepairs.deviceId, deviceId),
            gte(recipeRepairs.repairedAt, since),
          ),
        )
        .limit(1);
      return recent !== undefined;
    },
    recordRepair: async (recipeId, baseRevision, now, expired) => {
      await db.batch([
        db
          .insert(recipeRepairs)
          .values({ ownerId, recipeId, deviceId, revision: baseRevision, repairedAt: now })
          .onConflictDoUpdate({
            target: [recipeRepairs.ownerId, recipeRepairs.recipeId, recipeRepairs.deviceId],
            set: { revision: baseRevision, repairedAt: now },
          }),
        db
          .delete(recipeRepairs)
          .where(and(eq(recipeRepairs.ownerId, ownerId), lt(recipeRepairs.repairedAt, expired))),
      ]);
    },
    judgement: async (key) => {
      const [judged] = await db
        .select({ verdict: pageJudgements.verdict })
        .from(pageJudgements)
        .where(judgementOf(key))
        .limit(1);
      return judged;
    },
    judgementsSince: async (recipeId, since) => {
      const [judged] = await db
        .select({ value: count() })
        .from(pageJudgements)
        .where(
          and(
            eq(pageJudgements.ownerId, ownerId),
            eq(pageJudgements.recipeId, recipeId),
            gte(pageJudgements.judgedAt, since),
          ),
        );
      return judged?.value ?? 0;
    },
    recordJudgement: async (key, now, stale) => {
      const [taken] = await db.batch([
        db
          .insert(pageJudgements)
          .values({ ownerId, ...key, judgedAt: now })
          .onConflictDoUpdate({
            target: [
              pageJudgements.ownerId,
              pageJudgements.recipeId,
              pageJudgements.branch,
              pageJudgements.revision,
              pageJudgements.origin,
              pageJudgements.path,
              pageJudgements.promptVersion,
            ],
            set: { judgedAt: now, verdict: null },
            setWhere: inArray(pageJudgements.verdict, ["partial", "optional"]),
          }),
        db
          .delete(pageJudgements)
          .where(
            and(
              eq(pageJudgements.ownerId, ownerId),
              eq(pageJudgements.recipeId, key.recipeId),
              or(
                lt(pageJudgements.revision, key.revision),
                notInArray(pageJudgements.promptVersion, [...stale.versions]),
              ),
              lt(pageJudgements.judgedAt, stale.expired),
            ),
          ),
      ]);
      // An insert or a retaken `partial` or `optional` row; none while another request's
      // row is there.
      return taken.meta.changes === 1;
    },
    keepVerdict: async (key, verdict) => {
      await db.update(pageJudgements).set({ verdict }).where(judgementOf(key));
    },

    call: (call) => callClaude(env, ownerId, trace, call),
    logUnsent: (unsent, code) => logUnsent(env.DB, ownerId, unsent, code, trace),
    keepLogRevision: (logId, revision) => keepLogRevision(env.DB, ownerId, logId, revision),
    logPageSample: (sample) => logPageSample(env.DB, ownerId, sample, trace),
  };
}
