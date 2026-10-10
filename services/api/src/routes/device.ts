import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { ApiEnv } from "../auth";
import { devices } from "../db/schema";

/** A device revokes its own credential, for example when the owner signs out. */
export const deviceRoutes = new Hono<ApiEnv>().delete("/", async (c) => {
  const { ownerId, deviceId } = c.get("scope");
  await drizzle(c.env.DB)
    .update(devices)
    .set({ revokedAt: Date.now() })
    .where(and(eq(devices.id, deviceId), eq(devices.ownerId, ownerId), isNull(devices.revokedAt)));
  return c.body(null, 204);
});
