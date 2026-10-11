import { SYNC_PAGE_LIMIT, syncRecipeIdSchema, syncRecipeWriteSchema } from "@pateat/contracts";
import { asc, gt } from "drizzle-orm";
import { Hono } from "hono";
import { validator } from "hono/validator";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import { recipeHeads } from "../db/schema";
import { apiError } from "../http";
import { selectHeads, toChange, writeRecipe } from "../recipe-store";
import { jsonBody, requireJsonBody } from "../validation";

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
  .get(
    "/",
    validator("query", (value, c) => {
      const result = v.safeParse(changesQuerySchema, value);
      return result.success ? result.output : apiError(c, 400, { error: "bad_request" });
    }),
    async (c) => {
      const { after, limit } = c.req.valid("query");
      const scope = c.get("scope");
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
    },
  )
  .put(
    "/:recipeId",
    validator("param", (value, c) => {
      const result = v.safeParse(v.strictObject({ recipeId: syncRecipeIdSchema }), value);
      return result.success ? result.output : apiError(c, 400, { error: "bad_request" });
    }),
    requireJsonBody,
    jsonBody(syncRecipeWriteSchema),
    async (c) => {
      const scope = c.get("scope");
      const { recipeId } = c.req.valid("param");
      const write = c.req.valid("json");
      if (write.state === "active" && write.recipe.id !== recipeId)
        return apiError(c, 400, { error: "bad_request" });

      const result = await writeRecipe(c.env.DB, scope.ownerId, recipeId, write, scope.deviceId);
      if (!result.ok)
        return c.json({ error: "recipe_conflict" as const, current: result.current }, 409);
      return c.json({ version: 1 as const, change: result.change });
    },
  );
