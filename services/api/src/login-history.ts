import {
  INFERENCE_LOG_RETENTION_MS,
  MANAGE_LOGIN_HISTORY_LIMIT,
  type ManageLoginHistory,
  type ManageLoginHistoryQuery,
} from "@pateat/contracts";
import { and, desc, eq, gte, lt, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { loginTimings } from "./db/schema";

/** A bounded owner-only projection; request bodies and vault values are never selected. */
export async function readLoginHistory(
  binding: D1Database,
  ownerId: string | null,
  query: ManageLoginHistoryQuery,
  now: number,
): Promise<ManageLoginHistory> {
  if (!ownerId) return { version: 1, entries: [], next: null };
  const rows = await drizzle(binding)
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
          : or(
              lt(loginTimings.createdAt, query.beforeAt),
              and(eq(loginTimings.createdAt, query.beforeAt), lt(loginTimings.id, query.beforeId)),
            ),
      ),
    )
    .orderBy(desc(loginTimings.createdAt), desc(loginTimings.id))
    .limit(MANAGE_LOGIN_HISTORY_LIMIT + 1);
  const entries = rows.slice(0, MANAGE_LOGIN_HISTORY_LIMIT);
  const last = entries.at(-1);
  return {
    version: 1,
    // Database codes were validated on receipt; only this fixed projection leaves the service.
    entries: entries as ManageLoginHistory["entries"],
    next: rows.length > MANAGE_LOGIN_HISTORY_LIMIT && last ? { at: last.at, id: last.id } : null,
  };
}
