import type { DevicePairRequest } from "@pateat/contracts";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createDeviceToken, hashDeviceToken, type ApiEnv } from "../auth";
import { devices, ownerIdentities } from "../db/schema";
import { limitBy } from "../limits";
import { createOwnerOnFirstUse, identityIs } from "../owners";
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
 * Creates a device for the signed-in identity, creating its owner on first use in the
 * same transaction, so a failed pairing creates no owner. The credential is answered
 * once; only its SHA-256 is stored.
 */
export async function createPairedDevice(
  c: Context<ApiEnv, "/pair", { out: { json: DevicePairRequest } }>,
) {
  const { label } = c.req.valid("json");
  const identity = c.get("identity");
  const deviceId = newId();
  const credential = createDeviceToken();
  const tokenHash = await hashDeviceToken(credential);
  const now = Date.now();
  const orm = drizzle(c.env.DB);
  const [createOwner, mapIdentity] = createOwnerOnFirstUse(orm, identity);
  // The device takes the owner the identity maps to after the first two statements.
  // INSERT ... SELECT is positional: keep these fields in the devices column order.
  const device = orm.insert(devices).select(
    orm
      .select({
        id: sql`${deviceId}`.as("id"),
        ownerId: ownerIdentities.ownerId,
        tokenHash: sql`${tokenHash}`.as("token_hash"),
        label: sql`${label}`.as("label"),
        createdAt: sql`${now}`.as("created_at"),
        lastUsedAt: sql`${now}`.as("last_used_at"),
        revokedAt: sql`NULL`.as("revoked_at"),
      })
      .from(ownerIdentities)
      .where(identityIs(identity)),
  );
  const [, , created] = await orm.batch([createOwner, mapIdentity, device]);
  if (created.meta.changes !== 1) throw new Error("Paired device was not recorded");
  return c.json({ version: 1 as const, deviceId, credential }, 201);
}
