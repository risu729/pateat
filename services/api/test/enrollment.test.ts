import {
  createEnrollmentChallenge,
  createEnrollmentVerifier,
  enrollmentCode,
  enrollmentRedeemResultSchema,
  type EnrollmentRedeemResult,
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

function postForm(path: string, access: string | undefined, fields: Record<string, string>) {
  return request(path, {
    method: "POST",
    access,
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams(fields),
  });
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
      postForm(`/manage/devices/${crypto.randomUUID()}/revoke`, undefined, {}),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
  });

  it("accepts a valid token", async () => {
    const response = await request("/manage", { access: (await owner()).token });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("No devices are paired");
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
    expect(await response.text()).not.toContain("<table");
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

describe("device management", () => {
  it("lists only the signed-in owner's devices", async () => {
    const first = await owner();
    const second = await owner();
    await enroll(first, "First owner laptop");
    await enroll(second, "Second owner phone");
    const body = await (await request("/manage", { access: first.token })).text();
    expect(body).toContain("First owner laptop");
    expect(body).not.toContain("Second owner phone");
  });

  it("revokes an owned device", async () => {
    const by = await owner();
    const kept = await enroll(by, "Kept");
    const revoked = await enroll(by, "Revoked");
    const response = await postForm(`/manage/devices/${revoked.deviceId}/revoke`, by.token, {});
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/manage");
    expect(await (await deviceApi(revoked.credential)).json()).toEqual({
      error: "device_revoked",
    });
    expect((await deviceApi(kept.credential)).status).toBe(200);
    const page = await (await request("/manage", { access: by.token })).text();
    expect(page).toContain("Revoked 20");
    // Revoking again is harmless.
    expect(
      (await postForm(`/manage/devices/${revoked.deviceId}/revoke`, by.token, {})).status,
    ).toBe(303);
  });

  it("cannot revoke another owner's device", async () => {
    const first = await owner();
    const second = await owner();
    const target = await enroll(first);
    await enroll(second);
    const responses = await Promise.all(
      [second, await owner()].map((by) =>
        postForm(`/manage/devices/${target.deviceId}/revoke`, by.token, {}),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([404, 404]);
    expect((await deviceApi(target.credential)).status).toBe(200);
  });

  it("rejects cross-site revocation", async () => {
    const by = await owner();
    const target = await enroll(by);
    const response = await request(`/manage/devices/${target.deviceId}/revoke`, {
      method: "POST",
      access: by.token,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://attacker.example",
      },
    });
    expect(response.status).toBe(403);
    expect((await deviceApi(target.credential)).status).toBe(200);
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
