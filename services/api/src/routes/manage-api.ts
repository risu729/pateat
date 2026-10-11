import { deviceIdSchema, type ManageDevices } from "@pateat/contracts";
import { and, desc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { validator } from "hono/validator";
import * as v from "valibot";
import type { ApiEnv } from "../auth";
import { devices } from "../db/schema";
import { apiError } from "../http";
import { findOwner } from "../owners";

const deviceParamSchema = v.strictObject({ deviceId: deviceIdSchema });

/**
 * The web UI's JSON API. Every route acts for the owner the verified Access token
 * names; an identity that never approved a pairing has no owner and sees no data.
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
    validator("param", (value, c) => {
      const result = v.safeParse(deviceParamSchema, value);
      return result.success ? result.output : apiError(c, 404, { error: "not_found" });
    }),
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
  );
