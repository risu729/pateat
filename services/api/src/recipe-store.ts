import {
  syncRecipeChangeSchema,
  type SyncRecipeChange,
  type SyncRecipeWrite,
} from "@pateat/contracts";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { recipeHeads, recipeRevisions } from "./db/schema";

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

/**
 * Writes the next revision of one recipe when `expectedRevision` is still its head.
 * `writer` is the writing device, or null for the owner web UI. A stale writer
 * changes nothing and gets the current head back (null when the recipe never existed).
 */
export async function writeRecipe(
  db: D1Database,
  ownerId: string,
  recipeId: string,
  write: SyncRecipeWrite,
  writer: string | null,
): Promise<
  { ok: true; change: SyncRecipeChange } | { ok: false; current: SyncRecipeChange | null }
> {
  const orm = drizzle(db);
  const now = Date.now();
  const writeId = crypto.randomUUID();
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
  const claim =
    write.expectedRevision === 0
      ? orm
          .insert(recipeHeads)
          .values({ ownerId, recipeId, ...head })
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
              write.state === "revoked" ? eq(recipeHeads.state, "active") : undefined,
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
  const [claimed, recorded] = await orm.batch([claim, history]);
  if (claimed.meta.changes === 1 && recorded.meta.changes !== 1)
    throw new Error("Recipe head was claimed without its history row");
  if (claimed.meta.changes !== 1)
    return { ok: false, current: await readHead(db, ownerId, recipeId) };
  return { ok: true, change: toChange({ recipeId, revision, state: write.state, document }) };
}
