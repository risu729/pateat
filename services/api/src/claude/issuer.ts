import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import * as v from "valibot";

// Pateat as the OIDC issuer that owners trust in their own Anthropic organization
// (ADR 0015). Anthropic fetches the discovery document and JWKS, then verifies the
// short-lived assertions the Worker signs for one owner at a time.

/** The audience every assertion names; owners may match it in their federation rule. */
export const ASSERTION_AUDIENCE = "https://api.anthropic.com";
/** Assertion lifetime; Anthropic rejects more than one hour by default. */
export const ASSERTION_LIFETIME_SECONDS = 300;
/**
 * The JWT `sub` for an owner. Each owner's rule must match it exactly (no trailing
 * `*`): owner IDs are UUIDs, so no owner's subject is a prefix of another's.
 */
export const ownerSubject = (ownerId: string) => `owner:${ownerId}`;

/** One P-256 coordinate or scalar: 32 bytes as unpadded base64url. */
const p256Value = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/));
const keyId = v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]{1,64}$/));

const privateKeySchema = v.object({
  kty: v.literal("EC"),
  crv: v.literal("P-256"),
  alg: v.literal("ES256"),
  kid: keyId,
  x: p256Value,
  y: p256Value,
  d: p256Value,
});

/**
 * `OIDC_SIGNING_KEYS`: every key in `keys` is published; only `signingKeyId` signs.
 * Rotation publishes a new key before it signs and keeps the old one published until
 * the assertions it signed have expired.
 */
const signingKeysSchema = v.pipe(
  v.object({
    signingKeyId: keyId,
    keys: v.pipe(v.array(privateKeySchema), v.minLength(1), v.maxLength(4)),
  }),
  v.check(
    ({ keys }) => new Set(keys.map((key) => key.kid)).size === keys.length,
    "Key IDs must be unique.",
  ),
  v.check(
    ({ keys, signingKeyId }) => keys.some((key) => key.kid === signingKeyId),
    "The signing key must be one of the keys.",
  ),
);

/** A public HTTPS origin with no port, path or IP literal, as Anthropic requires. */
const issuerSchema = v.pipe(
  v.string(),
  v.regex(
    /^https:\/\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/,
  ),
);

type PrivateKey = v.InferOutput<typeof privateKeySchema>;
export type IssuerConfig = { issuer: string; signingKey: PrivateKey; keys: PrivateKey[] };

/** Unset or malformed settings fail closed: no discovery document, no assertions. */
export function readIssuerConfig(env: {
  OIDC_ISSUER?: string | undefined;
  OIDC_SIGNING_KEYS?: string | undefined;
}): IssuerConfig | null {
  const issuer = v.safeParse(issuerSchema, env.OIDC_ISSUER);
  if (!issuer.success || !env.OIDC_SIGNING_KEYS) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(env.OIDC_SIGNING_KEYS);
  } catch {
    return null;
  }
  const parsed = v.safeParse(signingKeysSchema, raw);
  if (!parsed.success) return null;
  const { keys, signingKeyId } = parsed.output;
  return {
    issuer: issuer.output,
    signingKey: keys.find((key) => key.kid === signingKeyId)!,
    keys,
  };
}

export function discoveryDocument(config: IssuerConfig) {
  return {
    issuer: config.issuer,
    jwks_uri: `${config.issuer}/.well-known/jwks.json`,
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["ES256"],
  };
}

/** Public halves only: the private `d` never leaves the Worker. */
export function publicKeySet(config: IssuerConfig) {
  return {
    keys: config.keys.map(({ kty, crv, alg, kid, x, y }) => ({
      kty,
      crv,
      alg,
      kid,
      x,
      y,
      use: "sig",
    })),
  };
}

/**
 * Signs a fresh single-use assertion for one owner. Call it only with the owner of
 * the authenticated request; the subject is what the owner's federation rule trusts.
 */
export function signOwnerAssertion(config: IssuerConfig, ownerId: string, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  return Jwt.sign(
    {
      iss: config.issuer,
      sub: ownerSubject(ownerId),
      aud: ASSERTION_AUDIENCE,
      iat,
      nbf: iat,
      exp: iat + ASSERTION_LIFETIME_SECONDS,
      jti: crypto.randomUUID(),
    },
    config.signingKey as HonoJsonWebKey,
  );
}
