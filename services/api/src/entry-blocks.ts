import type { EntryBlockReason } from "@pateat/contracts";
import { and, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { newId } from "@pateat/contracts/ids";
import { recipeEntryBlocks, recipeHeads, recipeRevisions } from "./db/schema";

/**
 * Keeps a device's report that an entry recipe revision leads nowhere (ADR 0031, amended
 * 2026-11-16), for the owner's active head of that recipe. The first report of a revision
 * is kept and later ones change nothing; a newly kept block moves the head to the owner's
 * next sequence, so every device's next recipe sync brings it. `stale` for a revision
 * older than the head, which the newer one superseded, `not-entry` for a head that is no
 * entry recipe, and `missing` for an unknown or revoked recipe or a revision it never had.
 */
export async function recordEntryBlock(
  db: D1Database,
  ownerId: string,
  recipeId: string,
  deviceId: string,
  report: { revision: number; reason: EntryBlockReason },
): Promise<"kept" | "stale" | "not-entry" | "missing"> {
  const orm = drizzle(db);
  const now = Date.now();
  const writeId = newId();
  const head = and(
    eq(recipeHeads.ownerId, ownerId),
    eq(recipeHeads.recipeId, recipeId),
    eq(recipeHeads.revision, report.revision),
    eq(recipeHeads.state, "active"),
  );
  const isEntry = sql`json_type(${recipeRevisions.document}, '$.entry') = 'object'`;
  // Drizzle fills INSERT ... SELECT positionally: keep these fields in the
  // recipeEntryBlocks column order.
  const insert = orm
    .insert(recipeEntryBlocks)
    .select(
      orm
        .select({
          ownerId: recipeHeads.ownerId,
          recipeId: recipeHeads.recipeId,
          revision: recipeHeads.revision,
          reason: sql`${report.reason}`.as("reason"),
          deviceId: sql`${deviceId}`.as("device_id"),
          blockedAt: sql`${now}`.as("blocked_at"),
          writeId: sql`${writeId}`.as("write_id"),
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
        .where(and(head, isEntry)),
    )
    // Only a row a write left behind for an older revision gives way; the first report of
    // the head revision stays.
    .onConflictDoUpdate({
      target: [recipeEntryBlocks.ownerId, recipeEntryBlocks.recipeId],
      set: {
        revision: sql`excluded.revision`,
        reason: sql`excluded.reason`,
        deviceId: sql`excluded.device_id`,
        blockedAt: sql`excluded.blocked_at`,
        writeId: sql`excluded.write_id`,
      },
      setWhere: sql`excluded.revision > ${recipeEntryBlocks.revision}`,
    });
  // The block this request kept, and nothing else, moves the head: the row names this
  // request's own write, so a repeat in the same millisecond moves nothing.
  const nextSequence = sql<number>`(SELECT COALESCE(MAX(${recipeHeads.sequence}), 0) + 1 FROM ${recipeHeads} WHERE ${recipeHeads.ownerId} = ${ownerId})`;
  const moved = orm
    .update(recipeHeads)
    .set({ sequence: nextSequence })
    .where(
      and(
        head,
        sql`EXISTS (SELECT 1 FROM ${recipeEntryBlocks} WHERE ${recipeEntryBlocks.ownerId} = ${ownerId} AND ${recipeEntryBlocks.recipeId} = ${recipeId} AND ${recipeEntryBlocks.writeId} = ${writeId})`,
      ),
    );
  const current = orm
    .select({ revision: recipeHeads.revision, state: recipeHeads.state, entry: isEntry })
    .from(recipeHeads)
    .innerJoin(
      recipeRevisions,
      and(
        eq(recipeRevisions.ownerId, recipeHeads.ownerId),
        eq(recipeRevisions.recipeId, recipeHeads.recipeId),
        eq(recipeRevisions.revision, recipeHeads.revision),
      ),
    )
    .where(and(eq(recipeHeads.ownerId, ownerId), eq(recipeHeads.recipeId, recipeId)));
  const [, , [found]] = await orm.batch([insert, moved, current]);
  // Revisions count up from 1, so any below the head was the owner's.
  if (!found || found.state !== "active" || report.revision > found.revision) return "missing";
  if (report.revision < found.revision) return "stale";
  return found.entry ? "kept" : "not-entry";
}
