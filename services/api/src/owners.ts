import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import type { AccessIdentity } from "./auth";
import { ownerIdentities, owners } from "./db/schema";

export async function findOwner(db: D1Database, identity: AccessIdentity) {
  const [row] = await drizzle(db)
    .select({ ownerId: ownerIdentities.ownerId })
    .from(ownerIdentities)
    .where(
      and(
        eq(ownerIdentities.issuer, identity.issuer),
        eq(ownerIdentities.subject, identity.subject),
      ),
    )
    .limit(1);
  return row?.ownerId ?? null;
}

/**
 * Returns the identity's owner, creating both rows on first use. The batch runs as
 * one transaction, and each insert is guarded so a concurrent first sign-in cannot
 * leave an orphan owner or map one identity twice.
 */
export async function resolveOwner(db: D1Database, identity: AccessIdentity) {
  const existing = await findOwner(db, identity);
  if (existing) return existing;
  const orm = drizzle(db);
  const ownerId = crypto.randomUUID();
  const now = Date.now();
  // INSERT ... SELECT is positional: keep each SELECT in its table's column order.
  await orm.batch([
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
  ]);
  const resolved = await findOwner(db, identity);
  if (!resolved) throw new Error("Owner identity was not recorded");
  return resolved;
}
