import { and, eq, sql } from "drizzle-orm";
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { AccessIdentity } from "./auth";
import { ownerIdentities, owners } from "./db/schema";
import { newId } from "@pateat/contracts/ids";

/** Selects the identity's mapping row; its `ownerId` is the identity's owner. */
export function identityIs(identity: AccessIdentity) {
  return and(
    eq(ownerIdentities.issuer, identity.issuer),
    eq(ownerIdentities.subject, identity.subject),
  );
}

export async function findOwner(db: D1Database, identity: AccessIdentity) {
  const [row] = await drizzle(db)
    .select({ ownerId: ownerIdentities.ownerId })
    .from(ownerIdentities)
    .where(identityIs(identity))
    .limit(1);
  return row?.ownerId ?? null;
}

/**
 * The two statements that create the identity's owner on first use, for a batch whose
 * later statements write the owner's rows, so a failed write leaves no owner behind.
 * Each insert is guarded, so they change nothing for an identity that already has an
 * owner, and a concurrent first sign-in cannot leave an orphan owner or map one
 * identity twice.
 */
export function createOwnerOnFirstUse(orm: DrizzleD1Database, identity: AccessIdentity) {
  const ownerId = newId();
  const now = Date.now();
  // INSERT ... SELECT is positional: keep each SELECT in its table's column order.
  return [
    orm
      .insert(owners)
      .select(
        sql`SELECT ${ownerId}, ${now} WHERE NOT EXISTS (SELECT 1 FROM ${ownerIdentities} WHERE ${ownerIdentities.issuer} = ${identity.issuer} AND ${ownerIdentities.subject} = ${identity.subject})`,
      ),
    orm
      .insert(ownerIdentities)
      .select(
        sql`SELECT ${identity.issuer}, ${identity.subject}, ${ownerId}, ${now} WHERE EXISTS (SELECT 1 FROM ${owners} WHERE ${owners.id} = ${ownerId})`,
      ),
  ] as const;
}
