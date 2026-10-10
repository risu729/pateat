import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { createMiddleware } from "hono/factory";
import { devices } from "./db/schema";
import { apiError } from "./http";

export type DeviceScope = { ownerId: string; deviceId: string };
export type ApiEnv = { Bindings: Env; Variables: { scope: DeviceScope } };

const TOKEN_PREFIX = "pateat_device_";
const TOKEN_PATTERN = /^pateat_device_[A-Za-z0-9_-]{43}$/;

/** A 256-bit bearer credential. Callers show it once and persist only its hash. */
export function createDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const base64 = btoa(String.fromCharCode(...bytes));
  return TOKEN_PREFIX + base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** High-entropy tokens need a collision-resistant digest, not a password KDF. */
export async function hashDeviceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const challenge = { "WWW-Authenticate": 'Bearer realm="pateat"' };

/**
 * Resolves the device credential to its owner. Every later query must use this
 * scope; request bodies and paths never select an owner or device.
 */
export const requireDevice = createMiddleware<ApiEnv>(async (c, next) => {
  const match = /^Bearer (\S+)$/.exec(c.req.header("Authorization") ?? "");
  const token = match?.[1];
  if (!token || !TOKEN_PATTERN.test(token))
    return apiError(c, 401, { error: "unauthorized" }, challenge);
  const [device] = await drizzle(c.env.DB)
    .select({ id: devices.id, ownerId: devices.ownerId, revokedAt: devices.revokedAt })
    .from(devices)
    .where(eq(devices.tokenHash, await hashDeviceToken(token)))
    .limit(1);
  if (!device) return apiError(c, 401, { error: "unauthorized" }, challenge);
  if (device.revokedAt !== null) return apiError(c, 401, { error: "device_revoked" }, challenge);
  c.set("scope", { ownerId: device.ownerId, deviceId: device.id });
  return next();
});
