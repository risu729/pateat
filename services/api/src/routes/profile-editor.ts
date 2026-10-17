import { manageSettingsWriteSchema, profileIdSchema } from "@pateat/contracts";
import { Hono } from "hono";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import { apiError } from "../http";
import { findOwner } from "../owners";
import { listProfiles } from "../profile-store";
import { readSettings, writeSettings } from "../settings-store";
import { jsonBody, requireJsonBody, validate } from "../validation";

const profileParam = v.strictObject({ profileId: profileIdSchema });

/** Owner-authorized editing from an allowed extension; never changes its device profile. */
export const profileEditorRoutes = new Hono<ApiEnv>()
  .get("/", async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    return c.json({ version: 1 as const, profiles: ownerId ? await listProfiles(c.env.DB, ownerId) : [] });
  })
  .get("/:profileId/settings", validate("param", profileParam, {status: 404, error: "not_found"}), async (c) => {
    const ownerId = await findOwner(c.env.DB, c.get("identity"));
    const profileId = c.req.valid("param").profileId;
    if (!ownerId || !(await listProfiles(c.env.DB, ownerId)).some((profile) => profile.id === profileId))
      return apiError(c, 404, {error: "not_found"});
    return c.json(await readSettings(c.env.DB, ownerId, profileId));
  })
  .put("/:profileId/settings", validate("param", profileParam, {status: 404, error: "not_found"}),
    requireJsonBody, jsonBody(manageSettingsWriteSchema), async (c) => {
      const ownerId = await findOwner(c.env.DB, c.get("identity"));
      const profileId = c.req.valid("param").profileId;
      if (!ownerId || !(await listProfiles(c.env.DB, ownerId)).some((profile) => profile.id === profileId))
        return apiError(c, 404, {error: "not_found"});
      const result = await writeSettings(c.env.DB, ownerId, profileId, c.req.valid("json"), null);
      return result.ok ? c.json(result.state) : c.json({error: "settings_conflict" as const, current: result.current}, 409);
    });
