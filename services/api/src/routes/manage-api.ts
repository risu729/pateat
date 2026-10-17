import {
  deviceIdSchema,
  profileIdSchema,
  profileCreateSchema,
  deviceProfileSchema,
  manageRecipeRevokeSchema,
  manageSettingsWriteSchema,
  syncRecipeIdSchema,
  type ManageDevices,
  type ManageRecipes,
} from "@pateat/contracts";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import { devices, recipeHeads } from "../db/schema";
import { apiError } from "../http";
import { findOwner } from "../owners";
import { selectHeads, toChange, writeRecipe } from "../recipe-store";
import { listProfiles, copyProfile, assignProfile } from "../profile-store";
import { readSettings, writeSettings } from "../settings-store";
import { jsonBody, requireJsonBody, validate } from "../validation";

const deviceParamSchema = v.strictObject({ deviceId: deviceIdSchema });
const profileParamSchema = v.strictObject({ profileId: profileIdSchema });
const recipeParamSchema = v.strictObject({ recipeId: syncRecipeIdSchema });

/**
 * The web UI's JSON API. Every route acts for the owner the verified Access token
 * names; an identity that never paired a device has no owner and sees no data.
 */
export const manageApiRoutes = new Hono<ApiEnv>()
  .get("/profiles", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    return c.json({
      version: 1 as const,
      profiles: ownerId ? await listProfiles(c.env.DB, ownerId) : [],
    });
  })
  .post("/profiles", requireJsonBody, jsonBody(profileCreateSchema), async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    if (!ownerId) return apiError(c, 404, { error: "not_paired" });
    const { name, copyFrom } = c.req.valid("json");
    const profile = await copyProfile(c.env.DB, ownerId, copyFrom, name);
    return profile ? c.json(profile, 201) : apiError(c, 404, { error: "not_found" });
  })
  .post(
    "/devices/:deviceId/profile",
    validate("param", deviceParamSchema, { status: 404, error: "not_found" }),
    requireJsonBody,
    jsonBody(deviceProfileSchema),
    async (c) => {
      const ownerId = await findOwner(c.env.DB, c.get("identity"));
      if (
        !ownerId ||
        !(await assignProfile(
          c.env.DB,
          ownerId,
          c.req.valid("param").deviceId,
          c.req.valid("json").profileId,
        ))
      )
        return apiError(c, 404, { error: "not_found" });
      return c.body(null, 204);
    },
  )
  .get("/devices", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    const rows = ownerId
      ? await drizzle(c.env.DB)
          .select({
            id: devices.id,
            profileId: devices.profileId,
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
  // The same revision-checked document devices sync through /v1/settings.
  .get(
    "/profiles/:profileId/settings",
    validate("param", profileParamSchema, { status: 404, error: "not_found" }),
    async (c) => {
      const ownerId = await findOwner(c.env.DB, c.get("identity"));
      if (!ownerId) return apiError(c, 404, { error: "not_paired" });
      const profileId = c.req.valid("param").profileId;
      if (!(await listProfiles(c.env.DB, ownerId)).some((profile) => profile.id === profileId))
        return apiError(c, 404, { error: "not_found" });
      return c.json(await readSettings(c.env.DB, ownerId, profileId));
    },
  )
  .put(
    "/profiles/:profileId/settings",
    validate("param", profileParamSchema, { status: 404, error: "not_found" }),
    requireJsonBody,
    jsonBody(manageSettingsWriteSchema),
    async (c) => {
      // Settings belong to an owner, who exists once a device was paired.
      const ownerId = await findOwner(c.env.DB, c.get("identity"));
      if (!ownerId) return apiError(c, 404, { error: "not_paired" });
      const profileId = c.req.valid("param").profileId;
      if (!(await listProfiles(c.env.DB, ownerId)).some((profile) => profile.id === profileId))
        return apiError(c, 404, { error: "not_found" });
      const result = await writeSettings(c.env.DB, ownerId, profileId, c.req.valid("json"), null);
      if (!result.ok)
        return c.json({ error: "settings_conflict" as const, current: result.current }, 409);
      return c.json(result.state);
    },
  )
  // The recipes devices sync through /v1/recipes; the web UI only reads and revokes them.
  .get("/recipes", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    const rows = ownerId
      ? // Each head write takes the owner's next sequence number.
        await selectHeads(c.env.DB, ownerId).orderBy(desc(recipeHeads.sequence))
      : [];
    return c.json({
      version: 1,
      recipes: rows.map((row) => ({ change: toChange(row), updatedAt: row.updatedAt })),
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
  );
