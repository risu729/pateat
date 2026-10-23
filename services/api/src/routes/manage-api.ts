import {
  deviceIdSchema,
  manageDashboardRangeSchema,
  manageModelsWriteSchema,
  manageRecipeRevokeSchema,
  manageSettingsWriteSchema,
  recipeLayoutKeySchema,
  storedLayouts,
  syncRecipeIdSchema,
  withoutLayout,
  type ManageDevices,
  type ManageRecipes,
  type ManageRequestLog,
  type ManageRequestLogDeleted,
} from "@pateat/contracts";
import { and, count, desc, eq, isNull, min } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import { configOffered, manageModels, readModelCatalog, saveModelConfig } from "../claude/models";
import { readDashboard } from "../dashboard";
import { devices, inferenceLog, loginOutcomes, loginTimings, recipeHeads } from "../db/schema";
import { apiError } from "../http";
import { findOwner } from "../owners";
import {
  readChange,
  readHead,
  readLayoutUses,
  revokeUnusedRecipes,
  selectHeads,
  writeRecipe,
} from "../recipe-store";
import { readSettings, writeSettings } from "../settings-store";
import { jsonBody, requireJsonBody, validate } from "../validation";

const deviceParamSchema = v.strictObject({ deviceId: deviceIdSchema });
const recipeParamSchema = v.strictObject({ recipeId: syncRecipeIdSchema });
const layoutParamSchema = v.strictObject({
  recipeId: syncRecipeIdSchema,
  layout: recipeLayoutKeySchema,
});
const dashboardQuerySchema = v.object({
  range: v.optional(manageDashboardRangeSchema, "7d"),
});

/**
 * The web UI's JSON API. Every route acts for the owner the verified Access token
 * names; an identity that never paired a device has no owner and sees no data.
 */
export const manageApiRoutes = new Hono<ApiEnv>()
  .get("/devices", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    const rows = ownerId
      ? await drizzle(c.env.DB)
          .select({
            id: devices.id,
            label: devices.label,
            createdAt: devices.createdAt,
            lastUsedAt: devices.lastUsedAt,
            revokedAt: devices.revokedAt,
          })
          .from(devices)
          .where(eq(devices.ownerId, ownerId))
          .orderBy(desc(devices.createdAt))
      : [];
    return c.json({ version: 1, devices: rows } satisfies ManageDevices);
  })
  .post(
    "/devices/:deviceId/revoke",
    validate("param", deviceParamSchema, { status: 404, error: "not_found" }),
    async (c) => {
      const { deviceId } = c.req.valid("param");
      const ownerId = await findOwner(c.env.DB, c.get("identity"));
      if (!ownerId) return apiError(c, 404, { error: "not_found" });
      const db = drizzle(c.env.DB);
      const owned = and(eq(devices.id, deviceId), eq(devices.ownerId, ownerId));
      const result = await db
        .update(devices)
        .set({ revokedAt: Date.now() })
        .where(and(owned, isNull(devices.revokedAt)));
      if (result.meta.changes !== 1) {
        // Revoking again is harmless; another owner's device does not exist here.
        const [existing] = await db.select({ id: devices.id }).from(devices).where(owned).limit(1);
        if (!existing) return apiError(c, 404, { error: "not_found" });
      }
      return c.body(null, 204);
    },
  )
  // Speed, counts and failures over the range, aggregated from the owner's rows only.
  .get("/dashboard", validate("query", dashboardQuerySchema), async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    const { range } = c.req.valid("query");
    return c.json(await readDashboard(c.env.DB, ownerId, range, Date.now()));
  })
  // The same revision-checked document devices sync through /v1/settings.
  .get("/settings", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return apiError(c, 404, { error: "not_paired" });
    return c.json(await readSettings(c.env.DB, ownerId));
  })
  .put("/settings", requireJsonBody, jsonBody(manageSettingsWriteSchema), async (c) => {
    // Settings belong to an owner, who exists once a device was paired.
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return apiError(c, 404, { error: "not_paired" });
    const result = await writeSettings(c.env.DB, ownerId, c.req.valid("json"), null);
    if (!result.ok)
      return c.json({ error: "settings_conflict" as const, current: result.current }, 409);
    return c.json(result.state);
  })
  // The owner's model configuration (ADR 0014). Only this API reads or writes it: device
  // tokens cannot, so a stolen one cannot raise the cost of each call.
  .get("/models", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return apiError(c, 404, { error: "not_paired" });
    const catalog = await readModelCatalog(c.env, ownerId, Date.now());
    return c.json(manageModels(catalog, catalog.config, catalog.saved));
  })
  .put("/models", requireJsonBody, jsonBody(manageModelsWriteSchema), async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return apiError(c, 404, { error: "not_paired" });
    const { config } = c.req.valid("json");
    // Checked against what the page offers for the saved configuration, read now with the
    // owner's credential: the newest model of each line, or one already chosen.
    const catalog = await readModelCatalog(c.env, ownerId, Date.now());
    if (!configOffered(config, manageModels(catalog, catalog.config, catalog.saved).models))
      return apiError(c, 400, { error: "model_unavailable" });
    await saveModelConfig(c.env.DB, ownerId, config);
    return c.json(manageModels(catalog, config, true));
  })
  // The recipes devices sync through /v1/recipes; the web UI only reads and revokes them.
  .get("/recipes", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    // Before the list, so it shows the recipes this revokes as revoked (ADR 0058).
    if (ownerId)
      try {
        await revokeUnusedRecipes(c.env.DB, ownerId, Date.now());
      } catch {
        console.error("Unused recipe revocation failed");
      }
    const rows = ownerId
      ? // Each head write takes the owner's next sequence number.
        await selectHeads(c.env.DB, ownerId).orderBy(desc(recipeHeads.sequence))
      : [];
    const read = rows.map((row) => ({ ...readChange(row), updatedAt: row.updatedAt }));
    const uses = ownerId ? await readLayoutUses(c.env.DB, ownerId) : new Map();
    return c.json({
      version: 1,
      recipes: read
        .filter((entry) => !entry.unreadable)
        .map(({ change, updatedAt }) => ({
          change,
          updatedAt,
          // Each layout's last use (ADR 0060); a tombstone has none.
          layouts:
            change.state === "active"
              ? storedLayouts(change.recipe).map(({ key }) => ({
                  key,
                  lastUsedAt: uses.get(change.recipeId)?.get(key) ?? null,
                }))
              : [],
        })),
      // Devices read these as revoked; the owner sees and revokes them here.
      unreadable: read
        .filter((entry) => entry.unreadable)
        .map(({ change, updatedAt }) => ({
          recipeId: change.recipeId,
          revision: change.revision,
          updatedAt,
        })),
    } satisfies ManageRecipes);
  })
  .post(
    "/recipes/:recipeId/revoke",
    validate("param", recipeParamSchema, { status: 404, error: "not_found" }),
    requireJsonBody,
    jsonBody(manageRecipeRevokeSchema),
    async (c) => {
      const { recipeId } = c.req.valid("param");
      const ownerId = await findOwner(c.env.DB, c.get("identity"));
      if (!ownerId) return apiError(c, 404, { error: "not_found" });
      const { expectedRevision } = c.req.valid("json");
      const result = await writeRecipe(
        c.env.DB,
        ownerId,
        recipeId,
        { version: 1, expectedRevision, state: "revoked" },
        null,
      );
      if (result.ok) return c.json({ version: 1 as const, change: result.change });
      // A revocation never adds an active recipe, so the limit cannot refuse it.
      if (result.limited || !result.current) return apiError(c, 404, { error: "not_found" });
      return c.json({ error: "recipe_conflict" as const, current: result.current }, 409);
    },
  )
  // One layout of a recipe (ADR 0060): the next revision keeps the others, and removing the
  // last one revokes the recipe. Removing a layout is not a use of the recipe.
  .post(
    "/recipes/:recipeId/layouts/:layout/revoke",
    validate("param", layoutParamSchema, { status: 404, error: "not_found" }),
    requireJsonBody,
    jsonBody(manageRecipeRevokeSchema),
    async (c) => {
      const { recipeId, layout } = c.req.valid("param");
      const ownerId = await findOwner(c.env.DB, c.get("identity"));
      if (!ownerId) return apiError(c, 404, { error: "not_found" });
      const { expectedRevision } = c.req.valid("json");
      const head = await readHead(c.env.DB, ownerId, recipeId);
      if (!head) return apiError(c, 404, { error: "not_found" });
      if (head.state !== "active" || head.revision !== expectedRevision)
        return c.json({ error: "recipe_conflict" as const, current: head }, 409);
      const keys = storedLayouts(head.recipe).map((entry) => entry.key);
      if (!keys.includes(layout)) return apiError(c, 404, { error: "not_found" });
      const next = withoutLayout(head.recipe, layout);
      const result = await writeRecipe(
        c.env.DB,
        ownerId,
        recipeId,
        next
          ? { version: 1, expectedRevision, state: "active", recipe: next }
          : { version: 1, expectedRevision, state: "revoked" },
        null,
        { used: false },
      );
      if (result.ok) return c.json({ version: 1 as const, change: result.change });
      // Removing a layout only shrinks the recipe, so the limits cannot refuse it.
      if (result.limited || !result.current) return apiError(c, 404, { error: "not_found" });
      return c.json({ error: "recipe_conflict" as const, current: result.current }, 409);
    },
  )
  // The owner's ADR 0012 request log, the login result codes devices sent (ADR 0019,
  // amended 2026-10-18) and their login records (ADR 0055): how much they hold, and
  // deleting all of it. Only these go: recipes, settings, judged pages and the spend the
  // limits count stay.
  .get("/request-log", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    const db = drizzle(c.env.DB);
    const [[requests], [outcomes], [logins]] = ownerId
      ? await db.batch([
          db
            .select({ entries: count(), oldestAt: min(inferenceLog.createdAt) })
            .from(inferenceLog)
            .where(eq(inferenceLog.ownerId, ownerId)),
          db
            .select({ entries: count(), oldestAt: min(loginOutcomes.createdAt) })
            .from(loginOutcomes)
            .where(eq(loginOutcomes.ownerId, ownerId)),
          db
            .select({ entries: count(), oldestAt: min(loginTimings.createdAt) })
            .from(loginTimings)
            .where(eq(loginTimings.ownerId, ownerId)),
        ])
      : [[], [], []];
    const oldest = [requests?.oldestAt, outcomes?.oldestAt, logins?.oldestAt].filter(
      (at): at is number => typeof at === "number",
    );
    return c.json({
      version: 1,
      entries: requests?.entries ?? 0,
      outcomes: outcomes?.entries ?? 0,
      logins: logins?.entries ?? 0,
      oldestAt: oldest.length ? Math.min(...oldest) : null,
    } satisfies ManageRequestLog);
  })
  .delete("/request-log", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    const db = drizzle(c.env.DB);
    const [requests, outcomes, logins] = ownerId
      ? await db.batch([
          db.delete(inferenceLog).where(eq(inferenceLog.ownerId, ownerId)),
          db.delete(loginOutcomes).where(eq(loginOutcomes.ownerId, ownerId)),
          db.delete(loginTimings).where(eq(loginTimings.ownerId, ownerId)),
        ])
      : [];
    return c.json({
      version: 1,
      deleted: requests?.meta.changes ?? 0,
      outcomes: outcomes?.meta.changes ?? 0,
      logins: logins?.meta.changes ?? 0,
    } satisfies ManageRequestLogDeleted);
  });
