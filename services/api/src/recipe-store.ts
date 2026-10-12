import {
  syncRecipeChangeSchema,
  type SyncRecipeChange,
  type SyncRecipeWrite,
} from "@pateat/contracts";
import { and, eq, or, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { owners, recipeHeads, recipeRevisions } from "./db/schema";
import { KEPT_RECIPE_REVISIONS, MAX_ACTIVE_RECIPES } from "./limits";
import { newId } from "@pateat/contracts/ids";

type HeadRow = {
  recipeId: string;
  revision: number;
  state: "active" | "revoked";
  sequence: number;
  updatedAt: number;
  document: unknown;
};

/** Every head read is owner-scoped here; callers can only narrow it further. */
export function selectHeads(db: D1Database, ownerId: string, ...conditions: SQL[]) {
  return drizzle(db)
    .select({
      recipeId: recipeHeads.recipeId,
      revision: recipeHeads.revision,
      state: recipeHeads.state,
      sequence: recipeHeads.sequence,
      updatedAt: recipeHeads.updatedAt,
      document: recipeRevisions.document,
    })
    .from(recipeHeads)
    .innerJoin(
      recipeRevisions,
      and(
        eq(recipeRevisions.ownerId, recipeHeads.ownerId),
        eq(recipeRevisions.recipeId, recipeHeads.recipeId),
        eq(recipeRevisions.revision, recipeHeads.revision),
      ),
    )
    .where(and(eq(recipeHeads.ownerId, ownerId), ...conditions))
    .$dynamic();
}

/** Stored rows are revalidated; a corrupt row fails closed as an internal error. */
export function toChange(row: Omit<HeadRow, "sequence" | "updatedAt">): SyncRecipeChange {
  return v.parse(
    syncRecipeChangeSchema,
    row.state === "active"
      ? { recipeId: row.recipeId, revision: row.revision, state: row.state, recipe: row.document }
      : { recipeId: row.recipeId, revision: row.revision, state: row.state },
  );
}

export async function readHead(db: D1Database, ownerId: string, recipeId: string) {
  const [row] = await selectHeads(db, ownerId, eq(recipeHeads.recipeId, recipeId));
  return row ? toChange(row) : null;
}

/** The owner's active recipe count, inside a statement so a batch checks it atomically. */
export function activeRecipes(ownerId: string) {
  return sql<number>`(SELECT COUNT(*) FROM ${recipeHeads} WHERE ${recipeHeads.ownerId} = ${ownerId} AND ${recipeHeads.state} = 'active')`;
}

/** Whether the owner may hold one more active recipe. */
export async function hasRecipeRoom(db: D1Database, ownerId: string): Promise<boolean> {
  const [row] = await drizzle(db)
    .select({ count: activeRecipes(ownerId) })
    .from(owners)
    .where(eq(owners.id, ownerId));
  return (row?.count ?? 0) < MAX_ACTIVE_RECIPES;
}

/**
 * Writes the next revision of one recipe when `expectedRevision` is still its head.
 * `writer` is the writing device, or null for the owner web UI. A stale writer
 * changes nothing and gets the current head back (null when the recipe never existed).
 * A write that would make the owner hold more than `MAX_ACTIVE_RECIPES` active recipes
 * changes nothing and is `limited`. A winning write deletes revisions older than the
 * newest `KEPT_RECIPE_REVISIONS`, or every older one when it revokes the recipe.
 */
export async function writeRecipe(
  db: D1Database,
  ownerId: string,
  recipeId: string,
  write: SyncRecipeWrite,
  writer: string | null,
): Promise<
  | { ok: true; change: SyncRecipeChange }
  | { ok: false; limited: false; current: SyncRecipeChange | null }
  | { ok: false; limited: true }
> {
  const orm = drizzle(db);
  const now = Date.now();
  const writeId = newId();
  const revision = write.expectedRevision + 1;
  const document = write.state === "active" ? write.recipe : null;
  // Sequences grow per owner; batches run serially in one transaction.
  const nextSequence = sql<number>`(SELECT COALESCE(MAX(${recipeHeads.sequence}), 0) + 1 FROM ${recipeHeads} WHERE ${recipeHeads.ownerId} = ${ownerId})`;
  const head = {
    revision,
    state: write.state,
    sequence: nextSequence,
    writeId,
    updatedAt: now,
  };
  // Only a write that makes a recipe active can add one; updates and revocations cannot.
  const hasRoom = sql`${activeRecipes(ownerId)} < ${MAX_ACTIVE_RECIPES}`;
  // INSERT ... SELECT is positional: keep these fields in the recipeHeads column order.
  const claim =
    write.expectedRevision === 0
      ? orm
          .insert(recipeHeads)
          .select(
            orm
              .select({
                ownerId: owners.id,
                recipeId: sql`${recipeId}`.as("recipe_id"),
                revision: sql`${revision}`.as("revision"),
                state: sql`${write.state}`.as("state"),
                sequence: nextSequence.as("sequence"),
                writeId: sql`${writeId}`.as("write_id"),
                updatedAt: sql`${now}`.as("updated_at"),
              })
              .from(owners)
              .where(and(eq(owners.id, ownerId), hasRoom)),
          )
          .onConflictDoNothing()
      : orm
          .update(recipeHeads)
          .set(head)
          .where(
            and(
              eq(recipeHeads.ownerId, ownerId),
              eq(recipeHeads.recipeId, recipeId),
              eq(recipeHeads.revision, write.expectedRevision),
              // Re-revoking a tombstone would only add churn to every change feed.
              write.state === "revoked"
                ? eq(recipeHeads.state, "active")
                : or(eq(recipeHeads.state, "active"), hasRoom),
            ),
          );
  // The history row is written only if this request's claim won the head.
  // Drizzle fills INSERT ... SELECT positionally: keep these fields in the
  // recipeRevisions column order (the stored-row test checks every column).
  const history = orm.insert(recipeRevisions).select(
    orm
      .select({
        ownerId: recipeHeads.ownerId,
        recipeId: recipeHeads.recipeId,
        revision: recipeHeads.revision,
        state: recipeHeads.state,
        document: sql`${document === null ? null : JSON.stringify(document)}`.as("document"),
        createdAt: sql`${now}`.as("created_at"),
        createdByDeviceId: sql`${writer}`.as("created_by_device_id"),
      })
      .from(recipeHeads)
      .where(
        and(
          eq(recipeHeads.ownerId, ownerId),
          eq(recipeHeads.recipeId, recipeId),
          eq(recipeHeads.writeId, writeId),
        ),
      ),
  );
  // Runs only after this request's claim won; a tombstone needs no earlier revision.
  const pruned = orm
    .delete(recipeRevisions)
    .where(
      and(
        eq(recipeRevisions.ownerId, ownerId),
        eq(recipeRevisions.recipeId, recipeId),
        sql`${recipeRevisions.revision} <= (SELECT ${recipeHeads.revision} - CASE ${recipeHeads.state} WHEN 'revoked' THEN 1 ELSE ${KEPT_RECIPE_REVISIONS} END FROM ${recipeHeads} WHERE ${recipeHeads.ownerId} = ${ownerId} AND ${recipeHeads.recipeId} = ${recipeId} AND ${recipeHeads.writeId} = ${writeId})`,
      ),
    );
  const [claimed, recorded] = await orm.batch([claim, history, pruned]);
  if (claimed.meta.changes === 1 && recorded.meta.changes !== 1)
    throw new Error("Recipe head was claimed without its history row");
  if (claimed.meta.changes !== 1) {
    const current = await readHead(db, ownerId, recipeId);
    // The head is still the expected one, so only the active recipe limit refused it,
    // unless a concurrent revocation just moved the head there; owners are never deleted.
    const limited =
      write.state === "active" &&
      (current
        ? current.revision === write.expectedRevision && current.state === "revoked"
        : write.expectedRevision === 0) &&
      !(await hasRecipeRoom(db, ownerId));
    return limited ? { ok: false, limited } : { ok: false, limited, current };
  }
  return { ok: true, change: toChange({ recipeId, revision, state: write.state, document }) };
}
