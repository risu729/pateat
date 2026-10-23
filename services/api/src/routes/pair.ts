import type { DevicePairRequest } from "@pateat/contracts";
import { and, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { createDeviceToken, hashDeviceToken, type ApiEnv } from "../auth";
import { devices, ownerIdentities, profiles } from "../db/schema";
import { limitBy } from "../limits";
import { findOwner, ownerCreationStatements, identityIs } from "../owners";
import { ensureProfile, listProfiles, profileNameTaken } from "../profile-store";
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
  const { label, profileId: requestedProfile, newProfile } = c.req.valid("json");
  const identity = c.get("identity");
  // An existing owner's device takes the profile the request chose, existing or new, and
  // a request that chose none is answered with the profiles to choose from (ADR 0075). A
  // first pairing has no profile to choose: its owner, first profile and device are
  // created in one batch below.
  const existing = await findOwner(c.env.DB, identity);
  let profileId: string | undefined;
  const orm = drizzle(c.env.DB);
  const createProfile = [];
  if (existing) {
    await ensureProfile(c.env.DB, existing);
    const owned = await listProfiles(c.env.DB, existing);
    if (newProfile !== undefined) {
      if (await profileNameTaken(c.env.DB, existing, newProfile))
        return c.json({ error: "profile_name_taken" as const, profiles: owned }, 409);
      profileId = newId();
      // No document: the device's first sync keeps its own entries in it.
      createProfile.push(
        orm.insert(profiles).values({ ownerId: existing, id: profileId, name: newProfile }),
      );
    } else if (requestedProfile === undefined)
      return c.json({ error: "profile_required" as const, profiles: owned }, 409);
    else if (owned.some((profile) => profile.id === requestedProfile)) profileId = requestedProfile;
    else return c.json({ error: "profile_not_found" as const, profiles: owned }, 404);
  } else if (requestedProfile) return c.json({ error: "profile_not_found" as const }, 404);
  const deviceId = newId();
  const credential = createDeviceToken();
  const tokenHash = await hashDeviceToken(credential);
  const now = Date.now();
  const [createOwner, mapIdentity] = ownerCreationStatements(orm, identity);
  // The rows below take the owner the identity maps to after the first two statements.
  // An owner's first profile has the owner's ID, as in ensureProfile, so simultaneous
  // first pairings agree on it. Its columns follow the schema's order.
  const firstName = existing ? "Default" : (newProfile ?? "Default");
  const firstProfile = orm
    .insert(profiles)
    .select(
      sql`SELECT ${ownerIdentities.ownerId}, ${ownerIdentities.ownerId}, ${firstName}, NULL, NULL FROM ${ownerIdentities} WHERE ${ownerIdentities.issuer} = ${identity.issuer} AND ${ownerIdentities.subject} = ${identity.subject}`,
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
      .where(
        // A profile deleted since the check above takes no device (ADR 0075).
        and(
          identityIs(identity),
          sql`EXISTS (SELECT 1 FROM ${profiles} WHERE ${profiles.ownerId} = ${ownerIdentities.ownerId} AND ${profiles.id} = ${profileId === undefined ? sql`${ownerIdentities.ownerId}` : profileId} AND ${profiles.deletedAt} IS NULL)`,
        ),
      ),
  );
  const results = await orm.batch([
    createOwner,
    mapIdentity,
    firstProfile,
    ...createProfile,
    device,
  ]);
  if (results.at(-1)?.meta.changes !== 1) {
    if (existing && requestedProfile !== undefined && newProfile === undefined)
      return c.json(
        {
          error: "profile_not_found" as const,
          profiles: await listProfiles(c.env.DB, existing),
        },
        404,
      );
    throw new Error("Paired device was not recorded");
  }
  return c.json({ version: 1 as const, deviceId, credential }, 201);
}
