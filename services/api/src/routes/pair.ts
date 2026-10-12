import type { DevicePairRequest } from "@pateat/contracts";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createDeviceToken, hashDeviceToken, type ApiEnv } from "../auth";
import { devices } from "../db/schema";
import { limitBy } from "../limits";
import { resolveOwner } from "../owners";
import { newId } from "@pateat/contracts/ids";

/** Bounds pairing per verified identity; runs after Access and the Origin check. */
export const pairLimit = limitBy(
  (env) => env.PAIR_LIMITER,
  (c) => {
    const { issuer, subject } = c.get("identity");
    return `${issuer} ${subject}`;
  },
);

/**
 * Creates a device for the signed-in identity, creating its owner on first use. The
 * credential is answered once; only its SHA-256 is stored.
 */
export async function createPairedDevice(
  c: Context<ApiEnv, "/pair", { out: { json: DevicePairRequest } }>,
) {
  const { label } = c.req.valid("json");
  const ownerId = await resolveOwner(c.env.DB, c.get("identity"));
  const deviceId = newId();
  const credential = createDeviceToken();
  const tokenHash = await hashDeviceToken(credential);
  const now = Date.now();
  await drizzle(c.env.DB).insert(devices).values({
    id: deviceId,
    ownerId,
    tokenHash,
    label,
    createdAt: now,
    lastUsedAt: now,
    revokedAt: null,
  });
  return c.json({ version: 1 as const, deviceId, credential }, 201);
}
