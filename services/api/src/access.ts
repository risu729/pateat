import { extensionIdSchema } from "@pateat/contracts";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { Jwt } from "hono/utils/jwt";
import * as v from "valibot";
import type { ApiEnv } from "./auth";
import { apiError } from "./http";
import { message } from "./pages";

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

type AccessFailure = "unconfigured" | "missing" | "rejected";

/**
 * Verifies the Cloudflare Access application token on browser-facing owner routes.
 * Only the signed `Cf-Access-Jwt-Assertion` is trusted, never the plain identity
 * headers; issuer, audience, signature and expiry must all match the configuration.
 * Pairing routes also accept the "pateat pair" application's audience, which lets a
 * browser without WARP pair but not open the owner pages (ADR 0029).
 */
function accessGuard(
  refuse: (c: Context<ApiEnv>, failure: AccessFailure) => Response | Promise<Response>,
  { pairing = false }: { pairing?: boolean } = {},
) {
  return createMiddleware<ApiEnv>(async (c, next) => {
    const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
    const ownerAudience = c.env.ACCESS_AUD;
    if (!teamDomain || !TEAM_DOMAIN.test(teamDomain) || !ownerAudience)
      return refuse(c, "unconfigured");
    // An empty pairing audience leaves pairing to the host-wide application alone.
    const pairAudience = pairing ? c.env.ACCESS_PAIR_AUD : "";
    const audience = pairAudience ? [ownerAudience, pairAudience] : ownerAudience;

    const token = c.req.header("Cf-Access-Jwt-Assertion");
    if (!token) return refuse(c, "missing");

    const issuer = `https://${teamDomain}`;
    let subject: unknown;
    try {
      const payload = await Jwt.verifyWithJwks(
        token,
        {
          jwks_uri: `${issuer}/cdn-cgi/access/certs`,
          allowedAlgorithms: ["RS256"],
          verification: { iss: issuer, aud: audience },
        },
        // Edge-cache the public keys briefly instead of fetching them on every page.
        // A rotated key may be refused for up to this long after first use.
        { cf: { cacheTtl: 300, cacheEverything: true } },
      );
      // Hono checks `exp` only when present; Access tokens always carry it.
      subject = typeof payload.exp === "number" ? payload["sub"] : undefined;
    } catch (error) {
      console.warn("Access token rejected", error instanceof Error ? error.name : "unknown");
    }
    // Service tokens have no user subject and cannot act as an owner.
    if (typeof subject !== "string" || subject.length === 0 || subject.length > 200)
      return refuse(c, "rejected");

    c.set("identity", { issuer, subject });
    return next();
  });
}

function refusePage(c: Context<ApiEnv>, failure: AccessFailure) {
  return failure === "unconfigured"
    ? message(c, 503, "Unavailable", "Owner sign-in is not configured for this service.")
    : failure === "missing"
      ? message(c, 401, "Sign in required", "Open this page through Cloudflare Access.")
      : message(c, 403, "Access denied", "Your sign-in could not be verified.");
}

function refuseApi(c: Context<ApiEnv>, failure: AccessFailure) {
  return failure === "unconfigured"
    ? apiError(c, 503, { error: "access_unavailable" })
    : failure === "missing"
      ? apiError(c, 401, { error: "unauthorized" })
      : apiError(c, 403, { error: "forbidden" });
}

/** For server-rendered owner pages: failures are explained as pages. */
export const requireAccess = accessGuard(refusePage);

/** For the web UI's JSON API: failures are stable error codes. */
export const requireAccessApi = accessGuard(refuseApi);

/** For the sign-in page the extension opens before pairing. */
export const requirePairingAccess = accessGuard(refusePage, { pairing: true });

/** For `POST /pair`. */
export const requirePairingAccessApi = accessGuard(refuseApi, { pairing: true });

/**
 * The web UI's API answers only its own pages. A state-changing request must carry
 * this origin; browsers always send `Origin` on such `fetch` requests.
 */
export const requireSameOrigin = createMiddleware<ApiEnv>(async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  if (c.req.header("Origin") !== new URL(c.req.url).origin)
    return apiError(c, 403, { error: "forbidden" });
  return next();
});

const pairingExtensionIdsSchema = v.pipe(v.array(extensionIdSchema), v.minLength(1));

/**
 * Pairing answers only listed extensions (ADR 0020). Pages cannot set `Origin` to a
 * `chrome-extension://` value, so this also refuses script on the service's own pages.
 * An empty or malformed list refuses every pairing.
 */
export const requirePairingOrigin = createMiddleware<ApiEnv>(async (c, next) => {
  // Parsed at runtime: a deployment may leave the binding out or mistype it.
  const configured = v.safeParse(pairingExtensionIdsSchema, c.env.PAIRING_EXTENSION_IDS);
  if (!configured.success) {
    console.error("Pairing extension IDs misconfigured");
    return apiError(c, 503, { error: "pairing_unavailable" });
  }
  const origin = c.req.header("Origin");
  if (!configured.output.some((id) => origin === `chrome-extension://${id}`))
    return apiError(c, 403, { error: "extension_not_allowed" });
  return next();
});
