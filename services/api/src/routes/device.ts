import type { SyncDeviceState } from "@pateat/contracts";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { Hono } from "hono";
import type { ApiEnv } from "../auth";
import { limitReached } from "../claude/calls";
import { readWifCredential } from "../claude/credentials";
import { readIssuerConfig, signingKeyImports } from "../claude/issuer";
import { devices, owners, settings } from "../db/schema";
import { apiError } from "../http";
import { activeRecipes } from "../recipe-store";

/** The checks a generation call makes after its spend stop, in the same order. */
async function generationReady(env: ApiEnv["Bindings"], configured: boolean) {
  if (!configured) return "credentials-not-configured" as const;
  const issuer = readIssuerConfig(env);
  return issuer && (await signingKeyImports(issuer))
    ? ("ok" as const)
    : ("issuer-unavailable" as const);
}

export const deviceRoutes = new Hono<ApiEnv>()
  /**
   * The calling device's server-side state for its diagnostics page (ADR 0019): no other
   * device, no IDs, labels or amounts, and no Claude token exchange.
   */
  .get("/", async (c) => {
    const { ownerId, deviceId } = c.get("scope");
    const db = drizzle(c.env.DB);
    const now = Date.now();
    const [[device], [recipes], [stored], credential, limit] = await Promise.all([
      db
        .select({ createdAt: devices.createdAt })
        .from(devices)
        .where(and(eq(devices.id, deviceId), eq(devices.ownerId, ownerId))),
      // The count the recipe limit uses.
      db
        .select({ total: activeRecipes(ownerId) })
        .from(owners)
        .where(eq(owners.id, ownerId)),
      db
        .select({ revision: settings.revision })
        .from(settings)
        .where(eq(settings.ownerId, ownerId)),
      readWifCredential(c.env.DB, ownerId),
      limitReached(db, ownerId, now),
    ]);
    // The device passed authentication in this request, so its row exists.
    if (!device) return apiError(c, 401, { error: "unauthorized" });
    const state: SyncDeviceState = {
      version: 1,
      pairedAt: device.createdAt,
      recipes: recipes?.total ?? 0,
      settingsRevision: stored?.revision ?? 0,
      generation: limit ?? (await generationReady(c.env, credential !== null)),
    };
    return c.json(state);
  })
  /** A device revokes its own credential, for example when the owner signs out. */
  .delete("/", async (c) => {
    const { ownerId, deviceId } = c.get("scope");
    await drizzle(c.env.DB)
      .update(devices)
      .set({ revokedAt: Date.now() })
      .where(
        and(eq(devices.id, deviceId), eq(devices.ownerId, ownerId), isNull(devices.revokedAt)),
      );
    return c.body(null, 204);
  });
