import {
  SYNC_PAGE_LIMIT,
  generationRequestSchema,
  loginOutcomeReportSchema,
  loginRecordSchema,
  recipeCompletionRequestSchema,
  recipePageSampleRequestSchema,
  syncRecipeIdSchema,
  syncRecipeWriteSchema,
} from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import { and, asc, desc, eq, gt, isNotNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import { loginOutcomes, loginTimings, recipeHeads, recipeRevisions } from "../db/schema";
import { apiError } from "../http";
import { purgeExpiredLog } from "../claude/calls";
import { revokeUnusedRecipes, selectHeads, toChange, writeRecipe } from "../recipe-store";
import { generateEntry, generateRecipe, judgeCompletion, samplePage } from "../recipes/generate";
import { jsonBody, requireJsonBody, validate } from "../validation";

const recipeParam = validate("param", v.strictObject({ recipeId: syncRecipeIdSchema }));
/** A login result code is a few short codes and numbers. */
const MAX_OUTCOME_BYTES = 1024;
/** A login record is a few short codes, the build and five numbers. */
const MAX_LOGIN_RECORD_BYTES = 1024;

const changesQuerySchema = v.strictObject({
  after: v.optional(
    v.pipe(v.string(), v.regex(/^(?:0|[1-9][0-9]{0,14})$/), v.transform(Number)),
    "0",
  ),
  limit: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[1-9][0-9]{0,2}$/),
      v.transform(Number),
      v.maxValue(SYNC_PAGE_LIMIT),
    ),
    String(SYNC_PAGE_LIMIT),
  ),
});

export const recipeRoutes = new Hono<ApiEnv>()
  // "generate" names the generation route, never a recipe.
  .on(["PUT"], "/generate", (c) =>
    apiError(c, 405, { error: "method_not_allowed" }, { Allow: "POST" }),
  )
  .get("/", validate("query", changesQuerySchema), async (c) => {
    const { after, limit } = c.req.valid("query");
    const scope = c.get("scope");
    // Devices read this often, so expired request log rows go even without new calls.
    try {
      await purgeExpiredLog(drizzle(c.env.DB), Date.now());
    } catch {
      console.error("Inference log purge failed");
    }
    // Before the page, so this sync already drops the recipes it revokes (ADR 0058).
    try {
      await revokeUnusedRecipes(c.env.DB, scope.ownerId, Date.now());
    } catch {
      console.error("Unused recipe revocation failed");
    }
    const rows = await selectHeads(c.env.DB, scope.ownerId, gt(recipeHeads.sequence, after))
      .orderBy(asc(recipeHeads.sequence))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return c.json({
      version: 1 as const,
      changes: page.map((row) => toChange(row)),
      cursor: page.at(-1)?.sequence ?? after,
      complete: rows.length <= limit,
    });
  })
  // Registered before `/:recipeId` routes; ADR 0018. Answers are 200 with a status.
  .post("/generate", requireJsonBody, jsonBody(generationRequestSchema), async (c) => {
    const request = c.req.valid("json");
    // A request without slots asks for a page's sign-in entry (ADR 0031).
    const result =
      "slots" in request
        ? await generateRecipe(c.env, c.get("scope"), request, c.get("trace"))
        : await generateEntry(c.env, c.get("scope"), request, c.get("trace"));
    return result ? c.json(result) : apiError(c, 400, { error: "bad_request" });
  })
  .post(
    "/:recipeId/completion",
    recipeParam,
    requireJsonBody,
    jsonBody(recipeCompletionRequestSchema),
    async (c) => {
      const { recipeId } = c.req.valid("param");
      const result = await judgeCompletion(
        c.env,
        c.get("scope"),
        recipeId,
        c.req.valid("json"),
        c.get("trace"),
      );
      if (result === undefined) return apiError(c, 404, { error: "not_found" });
      if (result === null) return apiError(c, 400, { error: "bad_request" });
      return c.json(result);
    },
  )
  /**
   * How the first login of a recipe revision on a device ended (ADR 0019 and ADR 0012,
   * amended 2026-10-18): codes only, for a revision the owner holds or held. The first
   * report of each revision is kept and later ones are ignored, so a second device or a
   * repeated send changes nothing.
   */
  .post(
    "/:recipeId/outcome",
    recipeParam,
    bodyLimit({
      maxSize: MAX_OUTCOME_BYTES,
      onError: (c) => apiError(c, 413, { error: "payload_too_large" }),
    }),
    requireJsonBody,
    jsonBody(loginOutcomeReportSchema),
    async (c) => {
      const { ownerId } = c.get("scope");
      const { recipeId } = c.req.valid("param");
      const { revision, branch, outcome, cause, step } = c.req.valid("json");
      const db = drizzle(c.env.DB);
      const [head] = await db
        .select({ revision: recipeHeads.revision, state: recipeHeads.state })
        .from(recipeHeads)
        .where(and(eq(recipeHeads.ownerId, ownerId), eq(recipeHeads.recipeId, recipeId)));
      // Revisions count up from 1, so any up to the head was the owner's; a revoked head
      // is a tombstone no login ran.
      if (
        !head ||
        revision > head.revision ||
        (revision === head.revision && head.state !== "active")
      )
        return apiError(c, 404, { error: "not_found" });
      const now = Date.now();
      await db
        .insert(loginOutcomes)
        .values({
          ownerId,
          recipeId,
          branch: branch ?? "",
          revision,
          outcome,
          cause: cause ?? null,
          step,
          createdAt: now,
        })
        .onConflictDoNothing();
      try {
        await purgeExpiredLog(db, now);
      } catch {
        console.error("Inference log purge failed");
      }
      return c.body(null, 204);
    },
  )
  /**
   * One login on a recipe revision that ended, signed in or blocked (ADR 0055): its result
   * code and how long it took, for a revision the owner holds or held, one row per report.
   * The site is the recipe revision's own origin, read here; the device sends none. The
   * login marks an active recipe used, so it is not revoked as unused (ADR 0058).
   */
  .post(
    "/:recipeId/logins",
    recipeParam,
    bodyLimit({
      maxSize: MAX_LOGIN_RECORD_BYTES,
      onError: (c) => apiError(c, 413, { error: "payload_too_large" }),
    }),
    requireJsonBody,
    jsonBody(loginRecordSchema),
    async (c) => {
      const { ownerId } = c.get("scope");
      const { recipeId } = c.req.valid("param");
      const record = c.req.valid("json");
      const db = drizzle(c.env.DB);
      const [[head], [kept]] = await db.batch([
        db
          .select({ revision: recipeHeads.revision, state: recipeHeads.state })
          .from(recipeHeads)
          .where(and(eq(recipeHeads.ownerId, ownerId), eq(recipeHeads.recipeId, recipeId))),
        // The reported revision's document, else the newest kept one: a recipe's origin
        // never changes, and older revisions are pruned (`KEPT_RECIPE_REVISIONS`).
        db
          .select({ origin: sql<unknown>`json_extract(${recipeRevisions.document}, '$.origin')` })
          .from(recipeRevisions)
          .where(
            and(
              eq(recipeRevisions.ownerId, ownerId),
              eq(recipeRevisions.recipeId, recipeId),
              isNotNull(recipeRevisions.document),
            ),
          )
          .orderBy(
            desc(sql`${recipeRevisions.revision} = ${record.revision}`),
            desc(recipeRevisions.revision),
          )
          .limit(1),
      ]);
      // As for a login result: any revision up to the head was the owner's, and a revoked
      // head is a tombstone no login ran. A recipe without a kept document, as after its
      // revocation, names no site, so its logins are refused too.
      if (
        !head ||
        record.revision > head.revision ||
        (record.revision === head.revision && head.state !== "active") ||
        typeof kept?.origin !== "string"
      )
        return apiError(c, 404, { error: "not_found" });
      const now = Date.now();
      await db.batch([
        db.insert(loginTimings).values({
          id: newId(),
          ownerId,
          recipeId,
          branch: record.branch ?? "",
          revision: record.revision,
          origin: kept.origin,
          outcome: record.outcome,
          cause: record.cause ?? null,
          extensionBuild: record.extensionBuild,
          totalMs: record.totalMs,
          serviceMs: record.serviceMs,
          networkMs: record.networkMs,
          personMs: record.personMs,
          pageMs: record.pageMs,
          createdAt: now,
        }),
        // A login on an older revision counts as use of the recipe too.
        db
          .update(recipeHeads)
          .set({ lastUsedAt: now })
          .where(
            and(
              eq(recipeHeads.ownerId, ownerId),
              eq(recipeHeads.recipeId, recipeId),
              eq(recipeHeads.state, "active"),
            ),
          ),
      ]);
      try {
        await purgeExpiredLog(db, now);
      } catch {
        console.error("Inference log purge failed");
      }
      return c.body(null, 204);
    },
  )
  // A repeat login's signed-in page, logged for evaluation without a model call (ADR 0029).
  .post(
    "/:recipeId/page-sample",
    recipeParam,
    requireJsonBody,
    jsonBody(recipePageSampleRequestSchema),
    async (c) => {
      const { recipeId } = c.req.valid("param");
      const result = await samplePage(
        c.env,
        c.get("scope"),
        recipeId,
        c.req.valid("json"),
        c.get("trace"),
      );
      if (result === undefined) return apiError(c, 404, { error: "not_found" });
      if (result === null) return apiError(c, 400, { error: "bad_request" });
      return c.body(null, result === "sampled" ? 201 : 204);
    },
  )
  .put("/:recipeId", recipeParam, requireJsonBody, jsonBody(syncRecipeWriteSchema), async (c) => {
    const scope = c.get("scope");
    const { recipeId } = c.req.valid("param");
    const write = c.req.valid("json");
    if (write.state === "active" && write.recipe.id !== recipeId)
      return apiError(c, 400, { error: "bad_request" });

    const result = await writeRecipe(c.env.DB, scope.ownerId, recipeId, write, scope.deviceId);
    if (!result.ok)
      return result.limited
        ? apiError(c, 409, { error: "recipe_limit" })
        : c.json({ error: "recipe_conflict" as const, current: result.current }, 409);
    return c.json({ version: 1 as const, change: result.change });
  });
