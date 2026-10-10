import { createMiddleware } from "hono/factory";
import { Jwt } from "hono/utils/jwt";
import type { ApiEnv } from "./auth";
import { message } from "./pages";

const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;

/**
 * Verifies the Cloudflare Access application token on browser-facing owner routes.
 * Only the signed `Cf-Access-Jwt-Assertion` is trusted, never the plain identity
 * headers; issuer, audience, signature and expiry must all match the configuration.
 */
export const requireAccess = createMiddleware<ApiEnv>(async (c, next) => {
  const teamDomain = c.env.ACCESS_TEAM_DOMAIN;
  const audience = c.env.ACCESS_AUD;
  if (!teamDomain || !TEAM_DOMAIN.test(teamDomain) || !audience)
    return message(c, 503, "Unavailable", "Owner sign-in is not configured for this service.");

  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token)
    return message(c, 401, "Sign in required", "Open this page through Cloudflare Access.");

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
    return message(c, 403, "Access denied", "Your sign-in could not be verified.");

  c.set("identity", { issuer, subject });
  return next();
});
