import { env, exports } from "cloudflare:workers";
import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import type { JWTPayload } from "hono/utils/jwt/types";
import { afterAll, beforeAll, vi } from "vitest";

// Synthetic Access keys and identities only, generated per run. Call
// `installAccessKeys()` once at the top of a test file; tests use fresh subjects so
// results never depend on rows written by another test.

export const ORIGIN = "https://pateat.invalid";
const TEAM = "pateat-test.cloudflareaccess.com";
export const ISSUER = `https://${TEAM}`;
const AUDIENCE = "pateat-test-audience";
/** The synthetic "pateat pair" application's audience, which pairing routes also accept. */
export const PAIR_AUDIENCE = "pateat-test-pair-audience";
const JWKS_URL = `${ISSUER}/cdn-cgi/access/certs`;

type SigningKey = { privateJwk: HonoJsonWebKey; publicJwk: HonoJsonWebKey };

async function createSigningKey(kid: string): Promise<SigningKey> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return {
    privateJwk: { ...privateJwk, kid, alg: "RS256" },
    publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" },
  };
}

let accessKey: SigningKey;
let impostorKey: SigningKey;
/** Set `available` to false to make the mocked key set fail. */
export const jwks = { available: true };

/** Serves the synthetic Access key set from a mocked fetch for this test file. */
export function installAccessKeys() {
  const originalFetch = globalThis.fetch;
  beforeAll(async () => {
    accessKey = await createSigningKey("access-test-key");
    // Same key ID, different key: a forged token must fail the signature check.
    impostorKey = await createSigningKey("access-test-key");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === JWKS_URL)
        return jwks.available
          ? Response.json({ keys: [accessKey.publicJwk] })
          : new Response("unavailable", { status: 503 });
      return originalFetch(input, init);
    });
  });
  afterAll(() => {
    vi.restoreAllMocks();
  });
}

export function claims(subject: string, overrides: JWTPayload = {}): JWTPayload {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: ISSUER,
    aud: [AUDIENCE],
    sub: subject,
    iat: now,
    nbf: now,
    exp: now + 600,
    type: "app",
    ...overrides,
  };
}

function withoutExpiry(payload: JWTPayload): JWTPayload {
  const copy = { ...payload };
  delete copy.exp;
  return copy;
}

function unsigned(payload: JWTPayload) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", kid: "access-test-key", typ: "JWT" })}.${encode(payload)}.`;
}

export function signAccess(payload: JWTPayload) {
  return Jwt.sign(payload, accessKey.privateJwk, "RS256");
}

/** A correctly shaped token signed by a key Access never published. */
export function forgedAccess(payload: JWTPayload) {
  return Jwt.sign(payload, impostorKey.privateJwk, "RS256");
}

export function newSubject() {
  return `subject-${crypto.randomUUID()}`;
}

export async function owner(subject = newSubject()) {
  return { subject, token: await signAccess(claims(subject)) };
}

/** The owner signed in through the "pateat pair" application (ADR 0030). */
export async function pairOwner(subject = newSubject()) {
  return { subject, token: await signAccess(claims(subject, { aud: [PAIR_AUDIENCE] })) };
}

export type Owner = Awaited<ReturnType<typeof owner>>;

/** Tokens every Access-guarded route must refuse with 403. */
export const rejectedTokens: [string, () => Promise<string>][] = [
  ["a forged signature", async () => forgedAccess(claims(newSubject()))],
  [
    "another issuer",
    async () => signAccess(claims(newSubject(), { iss: "https://other.cloudflareaccess.com" })),
  ],
  ["another audience", async () => signAccess(claims(newSubject(), { aud: ["other-audience"] }))],
  [
    "an expired token",
    async () => signAccess(claims(newSubject(), { exp: Math.floor(Date.now() / 1000) - 1 })),
  ],
  ["a token without expiry", async () => signAccess(withoutExpiry(claims(newSubject())))],
  [
    "a token issued in the future",
    async () => signAccess(claims(newSubject(), { iat: Math.floor(Date.now() / 1000) + 600 })),
  ],
  [
    "a service token without a subject",
    async () => signAccess(claims("", { common_name: "service" })),
  ],
  ["a symmetric token", async () => Jwt.sign(claims(newSubject()), "shared-secret", "HS256")],
  [
    "a token not yet valid",
    async () => signAccess(claims(newSubject(), { nbf: Math.floor(Date.now() / 1000) + 600 })),
  ],
  ["an unsigned token", async () => unsigned(claims(newSubject()))],
  ["a malformed token", async () => "not.a.jwt"],
];

export function request(path: string, init: RequestInit & { access?: string | undefined } = {}) {
  const headers = new Headers(init.headers);
  if (init.access) headers.set("Cf-Access-Jwt-Assertion", init.access);
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

export function deviceApi(credential: string, path = "/v1/settings", init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${credential}`);
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

export async function ownerIdFor(subject: string) {
  const row = await env.DB.prepare(
    "SELECT owner_id FROM owner_identities WHERE issuer = ? AND subject = ?",
  )
    .bind(ISSUER, subject)
    .first<{ owner_id: string }>();
  return row?.owner_id ?? null;
}
