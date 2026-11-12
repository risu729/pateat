import {
  INFERENCE_LOG_RETENTION_MS,
  MANAGE_LOGIN_HISTORY_LIMIT,
  manageLoginHistoryEntrySchema,
  type ManageLoginHistory,
  type ManageLoginHistoryQuery,
} from "@pateat/contracts";
import { and, desc, eq, gte, lt, lte, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as v from "valibot";
import { loginTimings } from "./db/schema";

/**
 * One page of an owner's login records, newest first, with one extra row that says
 * whether an older page exists. Request bodies and vault values are never selected.
 */
export function loginHistoryQuery(
  binding: D1Database,
  ownerId: string,
  query: ManageLoginHistoryQuery,
  now: number,
) {
  return drizzle(binding)
    .select({
      id: loginTimings.id,
      at: loginTimings.createdAt,
      origin: loginTimings.origin,
      recipeId: loginTimings.recipeId,
      revision: loginTimings.revision,
      outcome: loginTimings.outcome,
      cause: loginTimings.cause,
      extensionBuild: loginTimings.extensionBuild,
      totalMs: loginTimings.totalMs,
      personMs: loginTimings.personMs,
      serviceMs: loginTimings.serviceMs,
      networkMs: loginTimings.networkMs,
      pageMs: loginTimings.pageMs,
    })
    .from(loginTimings)
    .where(
      and(
        eq(loginTimings.ownerId, ownerId),
        gte(loginTimings.createdAt, now - INFERENCE_LOG_RETENTION_MS),
        query.origin === undefined ? undefined : eq(loginTimings.origin, query.origin),
        query.outcome === undefined ? undefined : eq(loginTimings.outcome, query.outcome),
        query.beforeAt === undefined || query.beforeId === undefined
          ? undefined
          : and(
              // Bounds the (owner_id, created_at) index from above, so an older page
              // seeks to the cursor instead of scanning every newer row.
              lte(loginTimings.createdAt, query.beforeAt),
              or(
                lt(loginTimings.createdAt, query.beforeAt),
                and(
                  eq(loginTimings.createdAt, query.beforeAt),
                  lt(loginTimings.id, query.beforeId),
                ),
              ),
            ),
      ),
    )
    .orderBy(desc(loginTimings.createdAt), desc(loginTimings.id))
    .limit(MANAGE_LOGIN_HISTORY_LIMIT + 1);
}

/** A bounded owner-only projection of the retained login records. */
export async function readLoginHistory(
  binding: D1Database,
  ownerId: string | null,
  query: ManageLoginHistoryQuery,
  now: number,
): Promise<ManageLoginHistory> {
  if (!ownerId) return { version: 1, entries: [], next: null };
  const rows = await loginHistoryQuery(binding, ownerId, query, now);
  const page = rows.slice(0, MANAGE_LOGIN_HISTORY_LIMIT);
  const last = page.at(-1);
  return {
    version: 1,
    // A row whose codes the current contract no longer accepts, such as a renamed
    // result, is left out rather than failing the whole page in the strict client.
    entries: page.filter((row) => v.is(manageLoginHistoryEntrySchema, row)),
    // From the last row read, not the last one kept, so left-out rows are passed over.
    next: rows.length > MANAGE_LOGIN_HISTORY_LIMIT && last ? { at: last.at, id: last.id } : null,
  };
}
