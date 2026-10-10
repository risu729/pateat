import {
  syncSettingsStateSchema,
  syncSettingsWriteSchema,
  type SyncSettingsState,
} from "@pateat/contracts";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import * as v from "valibot";
import type { ApiEnv, DeviceScope } from "../auth";
import { settings } from "../db/schema";
import { jsonBody } from "../validation";

async function readSettings(db: D1Database, scope: DeviceScope): Promise<SyncSettingsState> {
  const [row] = await drizzle(db)
    .select({ revision: settings.revision, document: settings.document })
    .from(settings)
    .where(eq(settings.ownerId, scope.ownerId))
    .limit(1);
  // Stored documents are revalidated; a corrupt row fails closed as an internal error.
  return v.parse(syncSettingsStateSchema, {
    version: 1,
    revision: row?.revision ?? 0,
    settings: row?.document ?? null,
  });
}

export const settingsRoutes = new Hono<ApiEnv>()
  .get("/", async (c) => c.json(await readSettings(c.env.DB, c.get("scope"))))
  .put("/", jsonBody(syncSettingsWriteSchema), async (c) => {
    const scope = c.get("scope");
    const write = c.req.valid("json");
    const db = drizzle(c.env.DB);
    const values = {
      revision: write.expectedRevision + 1,
      document: write.settings,
      updatedAt: Date.now(),
      updatedByDeviceId: scope.deviceId,
    };
    // One conditional statement: a stale writer changes no row and gets the current state.
    const result =
      write.expectedRevision === 0
        ? await db
            .insert(settings)
            .values({ ownerId: scope.ownerId, ...values })
            .onConflictDoNothing()
            .run()
        : await db
            .update(settings)
            .set(values)
            .where(
              and(
                eq(settings.ownerId, scope.ownerId),
                eq(settings.revision, write.expectedRevision),
              ),
            )
            .run();
    if (result.meta.changes !== 1)
      return c.json(
        { error: "settings_conflict" as const, current: await readSettings(c.env.DB, scope) },
        409,
      );
    return c.json({ version: 1, revision: values.revision, settings: write.settings });
  });
