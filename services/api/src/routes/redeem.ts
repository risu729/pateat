import {
  createEnrollmentChallenge,
  enrollmentCode,
  enrollmentRedeemSchema,
} from "@pateat/contracts";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import { createDeviceToken, hashDeviceToken, type ApiEnv } from "../auth";
import { devices, enrollments } from "../db/schema";
import { apiError } from "../http";
import { jsonBody, requireJsonBody } from "../validation";

/**
 * Anonymous exchange of an approved verifier for a device credential. The 256-bit
 * verifier is the only proof; the rate limit bounds polling and abuse per address.
 */
export const redeemRoutes = new Hono<ApiEnv>().post(
  "/",
  async (c, next) => {
    const client = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await c.env.REDEEM_LIMITER.limit({ key: client });
    if (!success) return apiError(c, 429, { error: "rate_limited" }, { "Retry-After": "60" });
    return next();
  },
  requireJsonBody,
  jsonBody(enrollmentRedeemSchema),
  async (c) => {
    const { verifier } = c.req.valid("json");
    const challenge = await createEnrollmentChallenge(verifier);
    const code = await enrollmentCode(verifier);
    const deviceId = crypto.randomUUID();
    const credential = createDeviceToken();
    const tokenHash = await hashDeviceToken(credential);
    const now = Date.now();
    const db = drizzle(c.env.DB);
    const pending = and(
      eq(enrollments.challenge, challenge),
      isNull(enrollments.redeemedAt),
      gt(enrollments.expiresAt, now),
    );
    // The owner must have typed the code this verifier derives.
    const redeemable = and(pending, eq(enrollments.code, code));
    // Both statements run in one transaction: the device is created only from a
    // redeemable approval, and the approval is consumed only if that device exists.
    // INSERT ... SELECT is positional: keep these fields in the devices column order.
    const [created, consumed] = await db.batch([
      db.insert(devices).select(
        db
          .select({
            id: sql`${deviceId}`.as("id"),
            ownerId: enrollments.ownerId,
            tokenHash: sql`${tokenHash}`.as("token_hash"),
            label: enrollments.label,
            createdAt: sql`${now}`.as("created_at"),
            revokedAt: sql`NULL`.as("revoked_at"),
          })
          .from(enrollments)
          .where(redeemable),
      ),
      db
        .update(enrollments)
        .set({ redeemedAt: now, deviceId })
        .where(
          and(redeemable, sql`EXISTS (SELECT 1 FROM ${devices} WHERE ${devices.id} = ${deviceId})`),
        ),
    ]);
    // Unreachable within one transaction; kept as an invariant check, not a rollback.
    if (created.meta.changes !== consumed.meta.changes)
      throw new Error("Enrollment redemption was only partly applied");
    if (created.meta.changes !== 1) {
      // Only the verifier holder can learn that the typed code was wrong; the owner
      // may retype it on the same page. Otherwise unapproved, expired, redeemed and
      // unknown verifiers look the same.
      const [mistyped] = await db
        .select({ challenge: enrollments.challenge })
        .from(enrollments)
        .where(pending)
        .limit(1);
      return mistyped
        ? apiError(c, 409, { error: "enrollment_code_mismatch" })
        : apiError(c, 404, { error: "enrollment_not_found" });
    }
    return c.json({ version: 1 as const, deviceId, credential });
  },
);
