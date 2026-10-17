import type { DevicePairRequest } from "@pateat/contracts";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createDeviceToken, hashDeviceToken, type ApiEnv } from "../auth";
import { devices, ownerIdentities, profiles } from "../db/schema";
import { limitBy } from "../limits";
import { findOwner, ownerCreationStatements, identityIs } from "../owners";
import { ensureProfile, listProfiles } from "../profile-store";
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
  const { label, profileId: requestedProfile } = c.req.valid("json");
  const identity = c.get("identity");
  // An existing owner's device takes the chosen profile. A first pairing has no profile
  // to choose: its owner, first profile and device are created in one batch below.
  const existing = await findOwner(c.env.DB, identity);
  let profileId: string | undefined;
  if (existing) {
    await ensureProfile(c.env.DB, existing);
    const owned = await listProfiles(c.env.DB, existing);
    if (!requestedProfile && owned.length > 1)
      return c.json({ error: "profile_required" as const, profiles: owned }, 409);
    profileId = requestedProfile ?? owned[0]!.id;
    if (!owned.some((profile) => profile.id === profileId))
      return c.json({ error: "profile_not_found" as const }, 404);
  } else if (requestedProfile) return c.json({ error: "profile_not_found" as const }, 404);
  const deviceId = newId();
  const credential = createDeviceToken();
  const tokenHash = await hashDeviceToken(credential);
  const now = Date.now();
  const orm = drizzle(c.env.DB);
  const [createOwner, mapIdentity] = ownerCreationStatements(orm, identity);
  // The rows below take the owner the identity maps to after the first two statements.
  // An owner's first profile has the owner's ID, as in ensureProfile, so simultaneous
  // first pairings agree on it.
  const firstProfile = orm
    .insert(profiles)
    .select(
      sql`SELECT ${ownerIdentities.ownerId}, ${ownerIdentities.ownerId}, 'Default', NULL FROM ${ownerIdentities} WHERE ${ownerIdentities.issuer} = ${identity.issuer} AND ${ownerIdentities.subject} = ${identity.subject}`,
    )
    .onConflictDoNothing();
  // Drizzle requires these fields in the schema's column order and names the columns.
  const device = orm.insert(devices).select(
    orm
      .select({
        id: sql`${deviceId}`.as("id"),
        ownerId: ownerIdentities.ownerId,
        profileId:
          profileId === undefined
            ? sql`${ownerIdentities.ownerId}`.as("profile_id")
            : sql`${profileId}`.as("profile_id"),
        tokenHash: sql`${tokenHash}`.as("token_hash"),
        label: sql`${label}`.as("label"),
        createdAt: sql`${now}`.as("created_at"),
        lastUsedAt: sql`${now}`.as("last_used_at"),
        revokedAt: sql`NULL`.as("revoked_at"),
      })
      .from(ownerIdentities)
      .where(identityIs(identity)),
  );
  const [, , , created] = await orm.batch([createOwner, mapIdentity, firstProfile, device]);
  if (created.meta.changes !== 1) throw new Error("Paired device was not recorded");
  return c.json({ version: 1 as const, deviceId, credential }, 201);
}
