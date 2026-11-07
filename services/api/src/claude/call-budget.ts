import { INFERENCE_LOG_RETENTION_MS } from "@pateat/contracts";

import { and, eq, inArray, lte, sql } from "drizzle-orm";

import { inferenceLocks, inferenceSpend } from "../db/schema";

import { newId } from "@pateat/contracts/ids";

import type { Db } from "./call-types";

export const CLAUDE_CALL_LIMITS = {
  /** $100 a month (ADR 0014), estimated from returned usage. */
  monthlyMicroUsd: 100_000_000,
  /** $5 a day (UTC), counting generation and judgement alike (owner decision, 2026-10-11). */
  dailyMicroUsd: 5_000_000,
  /**
   * Requests of one owner whose calls run at once, against abuse; more answer `busy`. Five
   * stays acceptable once Pateat is public (owner decision, 2026-10-23 22:05-22:06 UTC).
   */
  concurrentCalls: 5,
  /**
   * How long a request holds its slot: longer than the token exchange, Clef's calls (ADR
   * 0083) and the most calls one request makes in turn, up to three choices, each fast then
   * standard, at the 10 s model timeout.
   */
  lockMs: 90_000,
  /** Every request log row and login result code, for evaluation (owner decision, 2026-10-18). */
  logRetentionMs: INFERENCE_LOG_RETENTION_MS,
  /** The same request answered the same way without a call is logged once in this long. */
  unsentRepeatMs: 10 * 60 * 1000,
  /**
   * Rows of requests answered without a call per owner and UTC day, since spend no longer
   * bounds them (agent's choice, not confirmed by the owner).
   */
  unsentRowsPerDay: 500,
};

export const periods = (now: number) => {
  const day = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO("UTC").toPlainDate();
  return [day.toPlainYearMonth().toString(), day.toString()] as const;
};

export function addSpend(db: Db, ownerId: string, period: string, calls: number, micro: number) {
  return db
    .insert(inferenceSpend)
    .values({ ownerId, period, calls, costMicroUsd: micro })
    .onConflictDoUpdate({
      target: [inferenceSpend.ownerId, inferenceSpend.period],
      set: {
        calls: sql`${inferenceSpend.calls} + ${calls}`,
        costMicroUsd: sql`${inferenceSpend.costMicroUsd} + ${micro}`,
      },
    });
}

/**
 * Takes the first of the owner's call slots that is free or abandoned (its request ended
 * without releasing it), each with one conditional statement, so two requests never hold
 * the same slot. Returns undefined while every slot is held.
 */
export async function acquireSlot(db: Db, ownerId: string, now: number) {
  const lockId = newId();
  const expiresAt = now + CLAUDE_CALL_LIMITS.lockMs;
  for (let slot = 0; slot < CLAUDE_CALL_LIMITS.concurrentCalls; slot++) {
    // oxlint-disable-next-line no-await-in-loop
    const result = await db
      .insert(inferenceLocks)
      .values({ ownerId, slot, lockId, expiresAt })
      .onConflictDoUpdate({
        target: [inferenceLocks.ownerId, inferenceLocks.slot],
        set: { lockId, expiresAt },
        setWhere: lte(inferenceLocks.expiresAt, now),
      })
      .run();
    if (result.meta.changes === 1) return { slot, lockId };
  }
  return undefined;
}

/** Whether the owner reached the monthly or daily spend stop. */
export async function limitReached(db: Db, ownerId: string, now: number) {
  const [month, day] = periods(now);
  const rows = await db
    .select()
    .from(inferenceSpend)
    .where(and(eq(inferenceSpend.ownerId, ownerId), inArray(inferenceSpend.period, [month, day])));
  const spent = (period: string) => rows.find((row) => row.period === period)?.costMicroUsd ?? 0;
  if (spent(month) >= CLAUDE_CALL_LIMITS.monthlyMicroUsd) return "monthly-limit" as const;
  if (spent(day) >= CLAUDE_CALL_LIMITS.dailyMicroUsd) return "daily-limit" as const;
  return undefined;
}
