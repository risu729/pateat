import { DEVICE_IDLE_LIMIT_MS } from "@pateat/contracts";
import { and, eq, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createMiddleware } from "hono/factory";
import type { RequestTrace } from "./claude/calls";
import { devices } from "./db/schema";
import { apiError } from "./http";

export type DeviceScope = { ownerId: string; deviceId: string };
/** A verified external identity; the owner is looked up from it, never from input. */
export type AccessIdentity = { issuer: string; subject: string };
export type ApiEnv = {
  Bindings: Env;
  /** `trace` is set on device requests only (`traceRequest`). */
  Variables: { scope: DeviceScope; identity: AccessIdentity; trace: RequestTrace };
};

const TOKEN_PREFIX = "pateat_device_";
/** Must equal the shape of `deviceCredentialSchema` in the contracts. */
export const TOKEN_PATTERN = /^pateat_device_[A-Za-z0-9_-]{43}$/;

/** A 256-bit bearer credential. Callers show it once and persist only its hash. */
export function createDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return TOKEN_PREFIX + bytes.toBase64({ alphabet: "base64url", omitPadding: true });
}

/** High-entropy tokens need a collision-resistant digest, not a password KDF. */
export async function hashDeviceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return new Uint8Array(digest).toHex();
}

const challenge = { "WWW-Authenticate": 'Bearer realm="pateat"' };

/** Renewing a device's last use at most this often keeps D1 writes low. */
const LAST_USED_GRANULARITY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves the device credential to its owner. Every later query must use this
 * scope; request bodies and paths never select an owner or device. A device unused
 * for `DEVICE_IDLE_LIMIT_MS` is expired; each use renews it.
 */
export const requireDevice = createMiddleware<ApiEnv>(async (c, next) => {
  const match = /^Bearer (\S+)$/i.exec(c.req.header("Authorization") ?? "");
  const token = match?.[1];
  if (!token || !TOKEN_PATTERN.test(token))
    return apiError(c, 401, { error: "unauthorized" }, challenge);
  const db = drizzle(c.env.DB);
  const [device] = await db
    .select({
      id: devices.id,
      ownerId: devices.ownerId,
      lastUsedAt: devices.lastUsedAt,
      revokedAt: devices.revokedAt,
    })
    .from(devices)
    .where(eq(devices.tokenHash, await hashDeviceToken(token)))
    .limit(1);
  if (!device) return apiError(c, 401, { error: "unauthorized" }, challenge);
  if (device.revokedAt !== null) return apiError(c, 401, { error: "device_revoked" }, challenge);
  const now = Date.now();
  if (now - device.lastUsedAt > DEVICE_IDLE_LIMIT_MS)
    return apiError(c, 401, { error: "device_expired" }, challenge);
  if (now - device.lastUsedAt > LAST_USED_GRANULARITY_MS) {
    // Conditional, so concurrent requests write at most once and never move it back. A
    // failed write does not fail the request; a later request renews the device.
    const stale = now - LAST_USED_GRANULARITY_MS;
    await db
      .update(devices)
      .set({ lastUsedAt: now })
      .where(and(eq(devices.id, device.id), lte(devices.lastUsedAt, stale)))
      .catch(() => undefined);
  }
  c.set("scope", { ownerId: device.ownerId, deviceId: device.id });
  return next();
});
