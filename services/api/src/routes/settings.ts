import { syncSettingsWriteSchema } from "@pateat/contracts";
import { Hono } from "hono";
import type { ApiEnv } from "../auth";
import { readSettings, writeSettings } from "../settings-store";
import { jsonBody, requireJsonBody } from "../validation";

export const settingsRoutes = new Hono<ApiEnv>()
  .get("/", async (c) => c.json(await readSettings(c.env.DB, c.get("scope").ownerId)))
  .put("/", requireJsonBody, jsonBody(syncSettingsWriteSchema), async (c) => {
    const scope = c.get("scope");
    const result = await writeSettings(
      c.env.DB,
      scope.ownerId,
      c.req.valid("json"),
      scope.deviceId,
    );
    if (!result.ok)
      return c.json({ error: "settings_conflict" as const, current: result.current }, 409);
    return c.json(result.state);
  });
