import {
  SYNC_PAGE_LIMIT,
  generationRequestSchema,
  recipeCompletionRequestSchema,
  syncRecipeIdSchema,
  syncRecipeWriteSchema,
} from "@pateat/contracts";
import { asc, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import { recipeHeads } from "../db/schema";
import { apiError } from "../http";
import { purgeExpiredLog } from "../claude/calls";
import { selectHeads, toChange, writeRecipe } from "../recipe-store";
import { generateEntry, generateRecipe, judgeCompletion } from "../recipes/generate";
import { jsonBody, requireJsonBody, validate } from "../validation";

const recipeParam = validate("param", v.strictObject({ recipeId: syncRecipeIdSchema }));

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
