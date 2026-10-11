import { Hono } from "hono";
import type { ApiEnv } from "../auth";
import { discoveryDocument, publicKeySet, readIssuerConfig } from "../claude/issuer";

/**
 * Public OIDC issuer metadata that Anthropic fetches to verify Pateat's assertions
 * (ADR 0015). Neither route reads a body or reveals anything private; without the
 * issuer settings both answer 503 so a misconfigured deployment cannot half-work.
 */
export const oidcRoutes = new Hono<ApiEnv>()
  .get("/openid-configuration", (c) => {
    const config = readIssuerConfig(c.env);
    return config
      ? c.json(discoveryDocument(config))
      : c.json({ error: "issuer_unavailable" }, 503);
  })
  .get("/jwks.json", (c) => {
    const config = readIssuerConfig(c.env);
    return config ? c.json(publicKeySet(config)) : c.json({ error: "issuer_unavailable" }, 503);
  });
