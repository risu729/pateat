import {
  createEnrollmentChallenge,
  createEnrollmentVerifier,
  enrollmentCode,
  enrollmentRedeemResultSchema,
  manageDevicesSchema,
  manageRecipesSchema,
  type EnrollmentRedeemResult,
  type LoginRecipe,
} from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import type { JWTPayload } from "hono/utils/jwt/types";
import * as v from "valibot";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { createDeviceToken, hashDeviceToken } from "../src/auth";

// Synthetic Access keys and identities only. Every test uses fresh subjects and
// verifiers so results never depend on rows written by another test.

const ORIGIN = "https://pateat.invalid";
const TEAM = "pateat-test.cloudflareaccess.com";
const ISSUER = `https://${TEAM}`;
const AUDIENCE = "pateat-test-audience";
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
let jwksAvailable = true;
const originalFetch = globalThis.fetch;

beforeAll(async () => {
  accessKey = await createSigningKey("access-test-key");
  // Same key ID, different key: a forged token must fail the signature check.
  impostorKey = await createSigningKey("access-test-key");
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === JWKS_URL)
      return jwksAvailable
        ? Response.json({ keys: [accessKey.publicJwk] })
        : new Response("unavailable", { status: 503 });
    return originalFetch(input, init);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

function claims(subject: string, overrides: JWTPayload = {}): JWTPayload {
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

function signAccess(payload: JWTPayload, key = accessKey) {
  return Jwt.sign(payload, key.privateJwk, "RS256");
}

function newSubject() {
  return `subject-${crypto.randomUUID()}`;
}

async function owner(subject = newSubject()) {
  return { subject, token: await signAccess(claims(subject)) };
}

type Owner = Awaited<ReturnType<typeof owner>>;

function request(path: string, init: RequestInit & { access?: string | undefined } = {}) {
  const headers = new Headers(init.headers);
  if (init.access) headers.set("Cf-Access-Jwt-Assertion", init.access);
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

/**
 * The local limiter counts in wall-clock minutes, so a loop that crosses a minute
 * boundary would start a fresh count; start the loop at least 10 s before one.
 */
async function awaitRoomInMinute() {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < 10_000) await new Promise((resolve) => setTimeout(resolve, left + 100));
}

function postForm(path: string, access: string | undefined, fields: Record<string, string>) {
  return request(path, {
    method: "POST",
    access,
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams(fields),
  });
}

/** A web UI API call as its own page makes it: same origin unless `origin` says otherwise. */
function manageApi(
  path: string,
  access: string | undefined,
  method: string,
  origin: string | null = ORIGIN,
) {
  return request(path, { method, access, headers: origin ? { Origin: origin } : {} });
}

async function pairing(label = "Test laptop") {
  const verifier = createEnrollmentVerifier();
  const challenge = await createEnrollmentChallenge(verifier);
  return { verifier, challenge, label, code: await enrollmentCode(verifier) };
}

type Pairing = Awaited<ReturnType<typeof pairing>>;

function approve(by: Owner, pending: Pairing, code = pending.code) {
  return postForm("/enroll", by.token, {
    challenge: pending.challenge,
    label: pending.label,
    code,
  });
}

function redeem(verifier: string, client = crypto.randomUUID()) {
  return request("/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": client },
    body: JSON.stringify({ version: 1, verifier }),
  });
}

async function enroll(by: Owner, label = "Test laptop"): Promise<EnrollmentRedeemResult> {
  const pending = await pairing(label);
  expect((await approve(by, pending)).status).toBe(200);
  const response = await redeem(pending.verifier);
  expect(response.status).toBe(200);
  return v.parse(enrollmentRedeemResultSchema, await response.json());
}

function deviceApi(credential: string, path = "/v1/settings", init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${credential}`);
  return exports.default.fetch(`${ORIGIN}${path}`, { ...init, headers });
}

async function ownerIdFor(subject: string) {
  const row = await env.DB.prepare(
    "SELECT owner_id FROM owner_identities WHERE issuer = ? AND subject = ?",
  )
    .bind(ISSUER, subject)
    .first<{ owner_id: string }>();
  return row?.owner_id ?? null;
}

describe("Access verification", () => {
  it("requires the signed assertion and ignores plain identity headers", async () => {
    const response = await request("/manage", {
      headers: { "Cf-Access-Authenticated-User-Email": "owner@example.com" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
  });

  it("guards every owner route", async () => {
    const pending = await pairing();
    const query = new URLSearchParams({ challenge: pending.challenge, label: pending.label });
    const responses = await Promise.all([
      request(`/enroll?${query}`),
      postForm("/enroll", undefined, { ...Object.fromEntries(query), code: pending.code }),
      request("/manage"),
      request("/manage/assets/app.js"),
      request("/manage/api/devices"),
      manageApi(`/manage/api/devices/${crypto.randomUUID()}/revoke`, undefined, "POST"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(await responses[4]!.json()).toEqual({ error: "unauthorized" });
  });

  it("accepts a valid token", async () => {
    const response = await request("/manage", { access: (await owner()).token });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Pateat test app");
  });

  it.each([
    ["a forged signature", async () => signAccess(claims(newSubject()), impostorKey)],
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
  ])("rejects %s", async (_, token) => {
    const response = await request("/manage", { access: await token() });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Pateat test app");
  });

  it("fails closed when the signing keys cannot be fetched", async () => {
    jwksAvailable = false;
    try {
      const response = await request("/manage", { access: (await owner()).token });
      expect(response.status).toBe(403);
    } finally {
      jwksAvailable = true;
    }
  });

  it("fails closed without Access configuration", async () => {
    const { token } = await owner();
    const overrides = [
      { ACCESS_AUD: "" },
      { ACCESS_TEAM_DOMAIN: "" },
      { ACCESS_TEAM_DOMAIN: "attacker.example" },
    ];
    const responses = await Promise.all(
      overrides.map((override) =>
        app.request(
          `${ORIGIN}/manage`,
          { headers: { "Cf-Access-Jwt-Assertion": token } },
          { ...env, ...override },
        ),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([503, 503, 503]);
  });

  it("does not gate device routes or health behind Access", async () => {
    expect((await request("/health")).status).toBe(200);
    const response = await request("/v1/settings", { access: (await owner()).token });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });
});

describe("enrollment approval", () => {
  it("renders an escaped, unframeable page without the code", async () => {
    const by = await owner();
    const pending = await pairing('<script>alert("x")</script>');
    const response = await request(
      `/enroll?${new URLSearchParams({ challenge: pending.challenge, label: pending.label })}`,
      { access: by.token },
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&lt;script&gt;");
    expect(body).not.toContain(pending.code);
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("rejects malformed pairing requests", async () => {
    const by = await owner();
    const pending = await pairing();
    const queries = [
      { challenge: "short", label: "Laptop" },
      { challenge: pending.challenge, label: " " },
      { challenge: pending.challenge, label: "Laptop", extra: "1" },
    ];
    const responses = await Promise.all(
      queries.map((query) =>
        request(`/enroll?${new URLSearchParams(query)}`, { access: by.token }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
  });

  it("rejects malformed codes before changing state", async () => {
    const by = await owner();
    const pending = await pairing();
    const responses = await Promise.all(
      ["", "0000", "ABCD-EFGU"].map((code) => approve(by, pending, code)),
    );
    expect(responses.map((response) => response.status)).toEqual([400, 400, 400]);
    expect(await ownerIdFor(by.subject)).toBeNull();
    expect((await redeem(pending.verifier)).status).toBe(404);
  });

  it("redeems only with the code derived from the verifier, which the owner may retype", async () => {
    const by = await owner();
    const pending = await pairing();
    const other = await pairing();
    expect((await approve(by, pending, other.code)).status).toBe(200);
    const mistyped = await redeem(pending.verifier);
    expect(mistyped.status).toBe(409);
    expect(await mistyped.json()).toEqual({ error: "enrollment_code_mismatch" });
    // Retyping on the same page replaces the stored code until redemption.
    const typed = ` ${pending.code.replace("-", " ").toLowerCase()} `;
    const before = await env.DB.prepare("SELECT expires_at FROM enrollments WHERE challenge = ?")
      .bind(pending.challenge)
      .first<{ expires_at: number }>();
    expect((await approve(by, pending, typed)).status).toBe(200);
    // Retyping keeps the original expiry.
    const after = await env.DB.prepare("SELECT expires_at FROM enrollments WHERE challenge = ?")
      .bind(pending.challenge)
      .first<{ expires_at: number }>();
    expect(after?.expires_at).toBe(before?.expires_at);
    expect((await redeem(pending.verifier)).status).toBe(200);
  });

  it("does not let another account that saw the link capture the device", async () => {
    const victim = await owner();
    const observer = await owner();
    const pending = await pairing();
    // The observer knows the challenge but not the verifier-derived code.
    const guess = await enrollmentCode(createEnrollmentVerifier());
    expect((await approve(observer, pending, guess)).status).toBe(200);
    const blocked = await approve(victim, pending);
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("Approved by another account");
    expect((await redeem(pending.verifier)).status).toBe(409);
    const devices = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE owner_id = ?")
      .bind(await ownerIdFor(observer.subject))
      .first<{ count: number }>();
    expect(devices?.count).toBe(0);
  });

  it("rejects cross-site and non-form approvals before changing state", async () => {
    const by = await owner();
    const pending = await pairing();
    const { challenge, label, code } = pending;
    const fields = new URLSearchParams({ challenge, label, code });
    const crossSite = [
      { "Content-Type": "application/x-www-form-urlencoded" },
      { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://attacker.example" },
      {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
    ];
    const responses = await Promise.all(
      crossSite.map((headers) =>
        request("/enroll", { method: "POST", access: by.token, headers, body: fields }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([403, 403, 403]);
    const json = await request("/enroll", {
      method: "POST",
      access: by.token,
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(pending),
    });
    expect(json.status).toBe(415);
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("maps one identity to one owner", async () => {
    const by = await owner();
    await Promise.all([approve(by, await pairing()), approve(by, await pairing())]);
    await approve(by, await pairing());
    const { results } = await env.DB.prepare(
      "SELECT owner_id FROM owner_identities WHERE issuer = ? AND subject = ?",
    )
      .bind(ISSUER, by.subject)
      .all();
    expect(results).toHaveLength(1);
    const orphans = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM owners WHERE id NOT IN (SELECT owner_id FROM owner_identities) AND id NOT LIKE 'owner-%'",
    ).first<{ count: number }>();
    expect(orphans?.count).toBe(0);
  });

  it("treats a repeated approval by the same owner as the same approval", async () => {
    const by = await owner();
    const pending = await pairing();
    expect((await approve(by, pending)).status).toBe(200);
    expect((await approve(by, { ...pending, label: "Renamed" })).status).toBe(200);
    const row = await env.DB.prepare("SELECT label FROM enrollments WHERE challenge = ?")
      .bind(pending.challenge)
      .first<{ label: string }>();
    expect(row?.label).toBe(pending.label);
  });

  it("refuses a challenge approved by another owner or already redeemed", async () => {
    const first = await owner();
    const second = await owner();
    const pending = await pairing();
    expect((await approve(first, pending)).status).toBe(200);
    expect((await approve(second, pending)).status).toBe(409);
    expect((await redeem(pending.verifier)).status).toBe(200);
    expect((await approve(first, pending)).status).toBe(409);
  });

  it("removes expired unredeemed approvals and allows a fresh approval", async () => {
    const by = await owner();
    const stale = await pairing();
    const pending = await pairing();
    expect((await approve(by, stale)).status).toBe(200);
    expect((await approve(by, pending)).status).toBe(200);
    await env.DB.prepare("UPDATE enrollments SET expires_at = ? WHERE challenge IN (?, ?)")
      .bind(Date.now() - 1, stale.challenge, pending.challenge)
      .run();
    expect((await approve(by, pending)).status).toBe(200);
    const remaining = await env.DB.prepare(
      "SELECT challenge FROM enrollments WHERE challenge IN (?, ?)",
    )
      .bind(stale.challenge, pending.challenge)
      .all<{ challenge: string }>();
    expect(remaining.results.map((row) => row.challenge)).toEqual([pending.challenge]);
    expect((await redeem(pending.verifier)).status).toBe(200);
  });
});

describe("credential redemption", () => {
  it("is not available before approval", async () => {
    const pending = await pairing();
    const response = await redeem(pending.verifier);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "enrollment_not_found" });
  });

  it("issues one working credential and stores only its hash", async () => {
    const by = await owner();
    const pending = await pairing("Work laptop");
    await approve(by, pending);
    const response = await redeem(pending.verifier);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const result = v.parse(enrollmentRedeemResultSchema, await response.json());

    const device = await env.DB.prepare(
      "SELECT id, owner_id, token_hash, label, created_at, revoked_at FROM devices WHERE id = ?",
    )
      .bind(result.deviceId)
      .first();
    expect(device).toEqual({
      id: result.deviceId,
      owner_id: await ownerIdFor(by.subject),
      token_hash: await hashDeviceToken(result.credential),
      label: "Work laptop",
      created_at: expect.any(Number),
      revoked_at: null,
    });
    const enrollment = await env.DB.prepare(
      "SELECT redeemed_at, device_id FROM enrollments WHERE challenge = ?",
    )
      .bind(pending.challenge)
      .first();
    expect(enrollment).toEqual({ redeemed_at: expect.any(Number), device_id: result.deviceId });

    expect((await deviceApi(result.credential)).status).toBe(200);
    expect((await redeem(pending.verifier)).status).toBe(404);
  });

  it("issues at most one credential under concurrent redemption", async () => {
    const by = await owner();
    const pending = await pairing();
    await approve(by, pending);
    const responses = await Promise.all([
      redeem(pending.verifier),
      redeem(pending.verifier),
      redeem(pending.verifier),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 404, 404]);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM devices WHERE owner_id = ?")
      .bind(await ownerIdFor(by.subject))
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("refuses expired approvals", async () => {
    const by = await owner();
    const pending = await pairing();
    await approve(by, pending);
    await env.DB.prepare("UPDATE enrollments SET expires_at = ? WHERE challenge = ?")
      .bind(Date.now() - 1, pending.challenge)
      .run();
    expect((await redeem(pending.verifier)).status).toBe(404);
  });

  it("rejects the challenge in place of the verifier", async () => {
    const by = await owner();
    const pending = await pairing();
    await approve(by, pending);
    expect((await redeem(pending.challenge)).status).toBe(404);
  });

  it("validates bodies strictly", async () => {
    const client = crypto.randomUUID();
    const send = (body: string, type = "application/json") =>
      request("/redeem", {
        method: "POST",
        headers: { "Content-Type": type, "CF-Connecting-IP": client },
        body,
      });
    const verifier = createEnrollmentVerifier();
    expect((await send(JSON.stringify({ version: 1, verifier }), "text/plain")).status).toBe(415);
    expect((await send("{")).status).toBe(400);
    expect((await send(JSON.stringify({ version: 1, verifier, ownerId: "x" }))).status).toBe(400);
    expect((await send(JSON.stringify({ version: 1, verifier: "short" }))).status).toBe(400);
    expect((await send(JSON.stringify({ version: 1, verifier: "x".repeat(8000) }))).status).toBe(
      413,
    );
    expect((await request("/redeem")).status).toBe(405);
  });

  it("rate limits each client address", async () => {
    const client = crypto.randomUUID();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1)
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts sequential calls
      statuses.push((await redeem(createEnrollmentVerifier(), client)).status);
    expect(statuses.slice(0, 10).every((status) => status === 404)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    expect((await redeem(createEnrollmentVerifier())).status).toBe(404);
  });
});

describe("owner web UI", () => {
  it("serves the app and its assets only at known paths, unframeable and script-limited", async () => {
    const { token } = await owner();
    const page = await request("/manage", { access: token });
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toMatch(/^text\/html/);
    const policy = page.headers.get("Content-Security-Policy");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe");
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    const asset = await request("/manage/assets/app.js", { access: token });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("Pateat test app");
    expect(asset.headers.get("Content-Security-Policy")).toBe(policy);
    // The built document is reached only through its page path.
    expect((await request("/manage/index.html", { access: token })).status).toBe(404);
    expect((await request("/manage/unknown", { access: token })).status).toBe(404);
    expect((await request("/manage/assets/missing.js", { access: token })).status).toBe(404);
    expect((await request("/manage", { access: token, method: "POST" })).status).toBe(405);
  });

  it("never resolves an asset path outside the asset directory", async () => {
    const { token } = await owner();
    const paths = [
      "/manage/assets/..%5cindex.html",
      "/manage/assets/%2e%2e%5cindex.html",
      "/manage/assets/..%2findex.html",
      "/manage/assets/%2e%2e/index.html",
      "/manage/assets/sub/app.js",
      "/manage/assets/.hidden",
    ];
    const responses = await Promise.all(
      paths.map(async (path) => {
        const response = await request(path, { access: token });
        return [path, response.status, await response.text()] as const;
      }),
    );
    for (const [path, status, body] of responses) {
      expect(status, path).toBe(404);
      expect(body, path).not.toContain("Pateat test app");
    }
  });

  it("serves no page or asset without a verified token", async () => {
    const forged = await signAccess(claims(newSubject()), impostorKey);
    const anonymous = await Promise.all(
      ["GET", "HEAD"].flatMap((method) =>
        ["/manage", "/manage/assets/app.js"].map((path) => request(path, { method })),
      ),
    );
    expect(anonymous.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    expect((await request("/manage/assets/app.js", { access: forged })).status).toBe(403);
  });

  it("answers API Access failures with error codes", async () => {
    const forged = await signAccess(claims(newSubject()), impostorKey);
    const rejected = await request("/manage/api/devices", { access: forged });
    expect(rejected.status).toBe(403);
    expect(await rejected.json()).toEqual({ error: "forbidden" });
    const { token } = await owner();
    const unconfigured = await app.request(
      `${ORIGIN}/manage/api/devices`,
      { headers: { "Cf-Access-Jwt-Assertion": token } },
      { ...env, ACCESS_AUD: "" },
    );
    expect(unconfigured.status).toBe(503);
    expect(await unconfigured.json()).toEqual({ error: "access_unavailable" });
  });

  it("shows an identity that never paired a device no devices", async () => {
    const { subject, token } = await owner();
    const response = await request("/manage/api/devices", { access: token });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ version: 1, devices: [] });
    // Reading creates no owner.
    expect(await ownerIdFor(subject)).toBeNull();
  });

  it("rate limits the API per Access identity before the origin check", async () => {
    const { token } = await owner();
    await awaitRoomInMinute();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 120; attempt += 1)
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts sequential calls
      statuses.push((await request("/manage/api/devices", { access: token })).status);
    expect(statuses.every((status) => status === 200)).toBe(true);
    const limited = await manageApi(
      `/manage/api/devices/${crypto.randomUUID()}/revoke`,
      token,
      "POST",
      "https://attacker.example",
    );
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await request("/manage/api/devices", { access: (await owner()).token })).status).toBe(
      200,
    );
  }, 20_000);

  it("lists only the signed-in owner's devices, newest first", async () => {
    const first = await owner();
    const second = await owner();
    const older = await enroll(first, "First owner laptop");
    await enroll(second, "Second owner phone");
    const newer = await enroll(first, "First owner phone");
    const response = await request("/manage/api/devices", { access: first.token });
    const body = v.parse(manageDevicesSchema, await response.json());
    expect(body.devices.map((device) => [device.id, device.label, device.revokedAt])).toEqual([
      [newer.deviceId, "First owner phone", null],
      [older.deviceId, "First owner laptop", null],
    ]);
  });

  it("revokes an owned device", async () => {
    const by = await owner();
    const kept = await enroll(by, "Kept");
    const revoked = await enroll(by, "Revoked");
    const path = `/manage/api/devices/${revoked.deviceId}/revoke`;
    const response = await manageApi(path, by.token, "POST");
    expect(response.status).toBe(204);
    expect(await (await deviceApi(revoked.credential)).json()).toEqual({
      error: "device_revoked",
    });
    expect((await deviceApi(kept.credential)).status).toBe(200);
    const list = v.parse(
      manageDevicesSchema,
      await (await request("/manage/api/devices", { access: by.token })).json(),
    );
    expect(list.devices.find((device) => device.id === revoked.deviceId)?.revokedAt).toEqual(
      expect.any(Number),
    );
    // Revoking again is harmless.
    expect((await manageApi(path, by.token, "POST")).status).toBe(204);
    expect((await manageApi(path, by.token, "GET")).status).toBe(405);
  });

  it("cannot revoke another owner's device or an unknown one", async () => {
    const first = await owner();
    const second = await owner();
    const target = await enroll(first);
    await enroll(second);
    const responses = await Promise.all([
      ...[second, await owner()].map((by) =>
        manageApi(`/manage/api/devices/${target.deviceId}/revoke`, by.token, "POST"),
      ),
      manageApi(`/manage/api/devices/${crypto.randomUUID()}/revoke`, first.token, "POST"),
      manageApi("/manage/api/devices/not-a-device/revoke", first.token, "POST"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(await responses[0]!.json()).toEqual({ error: "not_found" });
    expect((await deviceApi(target.credential)).status).toBe(200);
  });

  it("rejects cross-site and origin-less revocation", async () => {
    const by = await owner();
    const target = await enroll(by);
    const path = `/manage/api/devices/${target.deviceId}/revoke`;
    const responses = await Promise.all([
      manageApi(path, by.token, "POST", "https://attacker.example"),
      manageApi(path, by.token, "POST", null),
    ]);
    expect(responses.map((response) => response.status)).toEqual([403, 403]);
    expect(await responses[0]!.json()).toEqual({ error: "forbidden" });
    expect((await deviceApi(target.credential)).status).toBe(200);
  });
});

describe("owner web UI settings", () => {
  const settings = {
    connections: [],
    excludedSites: [{ hostname: "intranet.example", includeSubdomains: true }],
    siteDefaults: [],
    bindings: [],
  };
  const putSettings = (by: Owner, body: unknown, origin: string | null = ORIGIN) =>
    request("/manage/api/settings", {
      method: "PUT",
      access: by.token,
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify(body),
    });

  it("tells an identity without a paired device to pair one, creating no owner", async () => {
    const by = await owner();
    const [read, write] = await Promise.all([
      request("/manage/api/settings", { access: by.token }),
      putSettings(by, { version: 1, expectedRevision: 0, settings }),
    ]);
    expect([read.status, write.status]).toEqual([404, 404]);
    expect(await read.json()).toEqual({ error: "not_paired" });
    expect(await write.json()).toEqual({ error: "not_paired" });
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("keeps each owner's settings apart", async () => {
    const first = await owner();
    const second = await owner();
    await Promise.all([enroll(first), enroll(second)]);
    expect((await putSettings(first, { version: 1, expectedRevision: 0, settings })).status).toBe(
      200,
    );
    // The second owner's revision 1 does not exist; the first owner's is untouched.
    const other = { ...settings, excludedSites: [] };
    const [read, write] = await Promise.all([
      request("/manage/api/settings", { access: second.token }),
      putSettings(second, { version: 1, expectedRevision: 1, settings: other }),
    ]);
    expect(await read.json()).toEqual({ version: 1, revision: 0, settings: null });
    expect(write.status).toBe(409);
    const firstRead = await request("/manage/api/settings", { access: first.token });
    expect(await firstRead.json()).toEqual({ version: 1, revision: 1, settings });
  });

  it("updates a device-written revision and makes a stale device write conflict", async () => {
    const by = await owner();
    const device = await enroll(by);
    const deviceWrite = (expectedRevision: number, body: unknown) =>
      deviceApi(device.credential, "/v1/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, expectedRevision, settings: body }),
      });
    expect((await deviceWrite(0, settings)).status).toBe(200);
    const web = { ...settings, excludedSites: [] };
    expect((await putSettings(by, { version: 1, expectedRevision: 1, settings: web })).status).toBe(
      200,
    );
    const row = await env.DB.prepare(
      "SELECT revision, updated_by_device_id FROM settings WHERE owner_id = ?",
    )
      .bind(await ownerIdFor(by.subject))
      .first<{ revision: number; updated_by_device_id: string | null }>();
    expect(row).toEqual({ revision: 2, updated_by_device_id: null });
    const stale = await deviceWrite(1, settings);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "settings_conflict",
      current: { version: 1, revision: 2, settings: web },
    });
  });

  it("refuses a document larger than devices sync", async () => {
    const by = await owner();
    await enroll(by);
    const long = ["a", "b", "c"].map((letter) => letter.repeat(60)).join(".");
    const large = {
      ...settings,
      excludedSites: Array.from({ length: 530 }, (_, index) => ({
        hostname: `${long}.x${index}.example`,
        includeSubdomains: false,
      })),
    };
    const over = {
      ...settings,
      excludedSites: Array.from({ length: 600 }, (_, index) => ({
        hostname: `${long}.x${index}.example`,
        includeSubdomains: false,
      })),
    };
    const [tooLarge, overLimit] = await Promise.all([
      putSettings(by, { version: 1, expectedRevision: 0, settings: large }),
      putSettings(by, { version: 1, expectedRevision: 0, settings: over }),
    ]);
    // Over 120 KiB of document but under the body limit, then over the body limit.
    expect([tooLarge.status, overLimit.status]).toEqual([400, 413]);
    expect(await tooLarge.json()).toEqual({ error: "bad_request" });
    expect(await overLimit.json()).toEqual({ error: "payload_too_large" });
    const read = await request("/manage/api/settings", { access: by.token });
    expect(await read.json()).toEqual({ version: 1, revision: 0, settings: null });
  });

  it("writes the document devices sync, recorded as written by the web UI", async () => {
    const by = await owner();
    const device = await enroll(by);
    const write = await putSettings(by, { version: 1, expectedRevision: 0, settings });
    expect(write.status).toBe(200);
    expect(await write.json()).toEqual({ version: 1, revision: 1, settings });
    expect(await (await deviceApi(device.credential)).json()).toEqual({
      version: 1,
      revision: 1,
      settings,
    });
    const row = await env.DB.prepare("SELECT updated_by_device_id FROM settings WHERE owner_id = ?")
      .bind(await ownerIdFor(by.subject))
      .first<{ updated_by_device_id: string | null }>();
    expect(row).toEqual({ updated_by_device_id: null });

    // A device write after it is still attributed to that device.
    const next = { ...settings, excludedSites: [] };
    const deviceWrite = await deviceApi(device.credential, "/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, expectedRevision: 1, settings: next }),
    });
    expect(deviceWrite.status).toBe(200);
    const read = await request("/manage/api/settings", { access: by.token });
    expect(await read.json()).toEqual({ version: 1, revision: 2, settings: next });
  });

  it("changes nothing on a stale revision and returns the current state", async () => {
    const by = await owner();
    await enroll(by);
    expect((await putSettings(by, { version: 1, expectedRevision: 0, settings })).status).toBe(200);
    const stale = await putSettings(by, {
      version: 1,
      expectedRevision: 0,
      settings: { ...settings, excludedSites: [] },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "settings_conflict",
      current: { version: 1, revision: 1, settings },
    });
  });

  it("refuses vault connections, invalid documents, other media types and other origins", async () => {
    const by = await owner();
    await enroll(by);
    const connection = {
      connectionId: "connection-1",
      enabled: true,
      selection: { mode: "all", groupIds: [], itemIds: [] },
      excludedItemIds: [],
      excludedFields: [],
    };
    const responses = await Promise.all([
      putSettings(by, {
        version: 1,
        expectedRevision: 0,
        settings: { ...settings, connections: [connection] },
      }),
      putSettings(by, { version: 1, expectedRevision: 0, settings: { ...settings, extra: 1 } }),
      request("/manage/api/settings", {
        method: "PUT",
        access: by.token,
        headers: { "Content-Type": "text/plain", Origin: ORIGIN },
        body: JSON.stringify({ version: 1, expectedRevision: 0, settings }),
      }),
      putSettings(by, { version: 1, expectedRevision: 0, settings }, "https://attacker.example"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([400, 400, 415, 403]);
    const read = await request("/manage/api/settings", { access: by.token });
    expect(await read.json()).toEqual({ version: 1, revision: 0, settings: null });
  });

  it("serves the settings pages", async () => {
    const { token } = await owner();
    const paths = ["/manage/sites", "/manage/bindings"];
    const [signedIn, anonymous] = await Promise.all([
      Promise.all(paths.map((path) => request(path, { access: token }))),
      Promise.all(paths.map((path) => request(path))),
    ]);
    expect(signedIn.map((response) => response.status)).toEqual([200, 200]);
    expect(await signedIn[0]!.text()).toContain("Pateat test app");
    expect(anonymous.map((response) => response.status)).toEqual([401, 401]);
  });
});

describe("owner web UI recipes", () => {
  function recipe(id: string, revision: number, origin = "https://bank.example"): LoginRecipe {
    return {
      version: 1,
      id,
      revision,
      origin,
      slots: ["username", "password"],
      steps: [
        {
          kind: "fill",
          effect: "prepare",
          path: "/login",
          fields: [
            { slot: "username", target: { by: "id", value: "username" } },
            { slot: "password", target: { by: "id", value: "password" } },
          ],
        },
        { kind: "click", path: "/login", target: { by: "id", value: "submit" }, purpose: "submit" },
      ],
      completion: { path: "/home", target: { by: "id", value: "welcome" } },
      maxSubmissions: 1,
    };
  }
  const publish = (credential: string, id: string, expectedRevision: number) =>
    deviceApi(credential, `/v1/recipes/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        expectedRevision,
        state: "active",
        recipe: recipe(id, expectedRevision + 1),
      }),
    });
  const revoke = (
    by: Owner,
    id: string,
    expectedRevision: number,
    origin: string | null = ORIGIN,
  ) =>
    request(`/manage/api/recipes/${id}/revoke`, {
      method: "POST",
      access: by.token,
      headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}) },
      body: JSON.stringify({ version: 1, expectedRevision }),
    });
  const list = async (by: Owner) =>
    v.parse(
      manageRecipesSchema,
      await (await request("/manage/api/recipes", { access: by.token })).json(),
    );

  it("lists only the owner's recipes, most recently changed first, with their documents", async () => {
    const first = await owner();
    const second = await owner();
    const [device, other] = await Promise.all([enroll(first), enroll(second)]);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    expect((await publish(device.credential, "shop-signin", 0)).status).toBe(200);
    expect((await publish(other.credential, "other-signin", 0)).status).toBe(200);
    // Writes in the same millisecond are common; the order comes from the write sequence.
    const sameTime = () => env.DB.prepare("UPDATE recipe_heads SET updated_at = 0").run();
    await sameTime();
    const { recipes } = await list(first);
    expect(recipes.map((entry) => entry.change.recipeId)).toEqual(["shop-signin", "bank-signin"]);
    // A revocation is the latest change, so that recipe moves to the top.
    expect((await revoke(first, "bank-signin", 1)).status).toBe(200);
    await sameTime();
    expect((await list(first)).recipes.map((entry) => entry.change.recipeId)).toEqual([
      "bank-signin",
      "shop-signin",
    ]);
    expect(recipes.find((entry) => entry.change.recipeId === "bank-signin")!.change).toEqual({
      recipeId: "bank-signin",
      revision: 1,
      state: "active",
      recipe: recipe("bank-signin", 1),
    });
  });

  it("shows an identity without a paired device no recipes and creates no owner", async () => {
    const by = await owner();
    expect(await list(by)).toEqual({ version: 1, recipes: [] });
    expect((await revoke(by, "bank-signin", 1)).status).toBe(404);
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("revokes a recipe as a tombstone devices receive, recorded as written by the web UI", async () => {
    const by = await owner();
    const device = await enroll(by);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    const response = await revoke(by, "bank-signin", 1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      change: { recipeId: "bank-signin", revision: 2, state: "revoked" },
    });
    const feed = await (await deviceApi(device.credential, "/v1/recipes")).json();
    expect(feed).toMatchObject({
      changes: [{ recipeId: "bank-signin", revision: 2, state: "revoked" }],
    });
    const rows = await env.DB.prepare(
      "SELECT revision, state, created_by_device_id FROM recipe_revisions WHERE owner_id = ? ORDER BY revision",
    )
      .bind(await ownerIdFor(by.subject))
      .all();
    // A revoked recipe keeps only its tombstone.
    expect(rows.results).toEqual([{ revision: 2, state: "revoked", created_by_device_id: null }]);
    // A device may still publish an explicit replacement after the tombstone.
    expect((await publish(device.credential, "bank-signin", 2)).status).toBe(200);
  });

  it("refuses a stale or repeated revocation and returns the current head", async () => {
    const by = await owner();
    const device = await enroll(by);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    expect((await publish(device.credential, "bank-signin", 1)).status).toBe(200);
    const stale = await revoke(by, "bank-signin", 1);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({
      error: "recipe_conflict",
      current: {
        recipeId: "bank-signin",
        revision: 2,
        state: "active",
        recipe: recipe("bank-signin", 2),
      },
    });
    expect((await revoke(by, "bank-signin", 2)).status).toBe(200);
    const again = await revoke(by, "bank-signin", 3);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "recipe_conflict",
      current: { recipeId: "bank-signin", revision: 3, state: "revoked" },
    });
  });

  it("never revokes another owner's recipe, an unknown one or from another origin", async () => {
    const first = await owner();
    const second = await owner();
    const [device] = await Promise.all([enroll(first), enroll(second)]);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    const responses = await Promise.all([
      revoke(second, "bank-signin", 1),
      revoke(first, "missing-signin", 1),
      revoke(first, "not a recipe id", 1),
      revoke(first, "bank-signin", 1, "https://attacker.example"),
      revoke(first, "bank-signin", 1, null),
      revoke(first, "bank-signin", 0),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 403, 403, 400]);
    expect((await list(first)).recipes[0]!.change.state).toBe("active");
  });

  it("serves the recipes page", async () => {
    const { token } = await owner();
    expect((await request("/manage/recipes", { access: token })).status).toBe(200);
    expect((await request("/manage/recipes")).status).toBe(401);
    expect((await manageApi("/manage/api/recipes", token, "PUT")).status).toBe(405);
  });
});

describe("device self-revocation", () => {
  it("revokes only the calling device", async () => {
    const by = await owner();
    const leaving = await enroll(by);
    const staying = await enroll(by);
    const response = await deviceApi(leaving.credential, "/v1/device", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(await (await deviceApi(leaving.credential)).json()).toEqual({
      error: "device_revoked",
    });
    expect((await deviceApi(staying.credential)).status).toBe(200);
    expect((await deviceApi(leaving.credential, "/v1/device", { method: "DELETE" })).status).toBe(
      401,
    );
  });

  it("requires a device credential", async () => {
    expect((await request("/v1/device", { method: "DELETE" })).status).toBe(401);
    const unknown = createDeviceToken();
    expect((await deviceApi(unknown, "/v1/device", { method: "DELETE" })).status).toBe(401);
    const by = await owner();
    const device = await enroll(by);
    expect((await deviceApi(device.credential, "/v1/device")).status).toBe(405);
  });
});
