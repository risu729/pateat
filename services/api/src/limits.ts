import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import type { ApiEnv } from "./auth";
import { apiError } from "./http";

// Per-owner limits sized for a few people's own use (docs/architecture.md#service-limits).

/** Active recipes per owner; revoking one frees its place. */
export const MAX_ACTIVE_RECIPES = 1_000;
/** Revisions kept per recipe; older ones are deleted, and a revoked recipe keeps only its tombstone. */
export const KEPT_RECIPE_REVISIONS = 10;
/** An active recipe neither written nor reported in a login for this long is revoked (ADR 0058). */
export const RECIPE_IDLE_LIMIT_MS = 90 * 24 * 60 * 60 * 1000;
/** Unused recipes one check revokes at most; the next check revokes the rest (ADR 0058). */
export const MAX_IDLE_REVOCATIONS = 50;

/**
 * Refuses a request once `binding` has seen too many for the key this request maps to,
 * before any body is read. `PAIR_LIMITER` keys by verified Access identity and
 * `OWNER_LIMITER` by owner or identity; each window is one minute.
 */
export function limitBy(binding: (env: Env) => RateLimit, keyOf: (c: Context<ApiEnv>) => string) {
  return createMiddleware<ApiEnv>(async (c, next) => {
    const { success } = await binding(c.env).limit({ key: keyOf(c) });
    if (!success) return apiError(c, 429, { error: "rate_limited" }, { "Retry-After": "60" });
    return next();
  });
}

/** Device requests count against the owner, whichever of its devices sends them. */
export const limitOwner = limitBy(
  (env) => env.OWNER_LIMITER,
  (c) => `owner:${c.get("scope").ownerId}`,
);

/** Web UI requests count against the verified Access identity, which maps to one owner. */
export const limitIdentity = limitBy(
  (env) => env.OWNER_LIMITER,
  (c) => {
    const { issuer, subject } = c.get("identity");
    return `access:${issuer} ${subject}`;
  },
);
