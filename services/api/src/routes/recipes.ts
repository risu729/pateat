import {
  SYNC_PAGE_LIMIT,
  generationRequestSchema,
  loginOutcomeReportSchema,
  recipeCompletionRequestSchema,
  syncRecipeIdSchema,
  syncRecipeWriteSchema,
} from "@pateat/contracts";
import { and, asc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import { loginOutcomes, recipeHeads } from "../db/schema";
import { apiError } from "../http";
import { purgeExpiredLog } from "../claude/calls";
import { selectHeads, toChange, writeRecipe } from "../recipe-store";
import { generateEntry, generateRecipe, judgeCompletion } from "../recipes/generate";
import { jsonBody, requireJsonBody, validate } from "../validation";

const recipeParam = validate("param", v.strictObject({ recipeId: syncRecipeIdSchema }));
/** A login result code is a few short codes and numbers. */
const MAX_OUTCOME_BYTES = 1024;

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
        ? await generateRecipe(c.env, c.get("scope"), request)
        : await generateEntry(c.env, c.get("scope"), request);
    return result ? c.json(result) : apiError(c, 400, { error: "bad_request" });
  })
  .post(
    "/:recipeId/completion",
    recipeParam,
    requireJsonBody,
    jsonBody(recipeCompletionRequestSchema),
    async (c) => {
      const { recipeId } = c.req.valid("param");
      const result = await judgeCompletion(c.env, c.get("scope"), recipeId, c.req.valid("json"));
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
