import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiEnv } from "../src/auth";
import { manageClaudeRoutes } from "../src/routes/manage-claude";

// Synthetic Access key, identities and federation identifiers only. Anthropic's token
// endpoint is answered locally; no request leaves the test.

const ORIGIN = "https://pateat.invalid";
const ACCESS_ISSUER = "https://pateat-test.cloudflareaccess.com";
const JWKS_URL = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";

const ids = {
  federationRuleId: "fdrl_01SyntheticRule",
  organizationId: "00000000-0000-4000-8000-000000000000",
  serviceAccountId: "svac_01SyntheticAccount",
  workspaceId: "wrkspc_01SyntheticWorkspace",
};

let privateJwk: HonoJsonWebKey;
let tokenResponse = () => new Response("unexpected", { status: 500 });
const tokenRequests: Record<string, string>[] = [];
const originalFetch = globalThis.fetch;

beforeAll(async () => {
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
  const kid = "manage-claude-test-key";
  privateJwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey),
    kid,
    alg: "RS256",
  };
  const publicJwk = {
    ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey),
    kid,
    alg: "RS256",
    use: "sig",
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const outbound = new Request(input, init);
    if (outbound.url === JWKS_URL) return Response.json({ keys: [publicJwk] });
    if (outbound.url === TOKEN_URL) {
      tokenRequests.push(await outbound.json());
      return tokenResponse();
    }
    return originalFetch(input, init);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

async function signedInOwner() {
  const subject = `subject-${crypto.randomUUID()}`;
  const ownerId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, Date.now()),
    env.DB.prepare(
      "INSERT INTO owner_identities (issuer, subject, owner_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(ACCESS_ISSUER, subject, ownerId, Date.now()),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const access = await Jwt.sign(
    {
      iss: ACCESS_ISSUER,
      aud: ["pateat-test-audience"],
      sub: subject,
      iat: now,
      nbf: now,
      exp: now + 600,
      type: "app",
    },
    privateJwk,
    "RS256",
  );
  return { ownerId, access };
}

function request(path: string, access: string | undefined, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (access) headers.set("Cf-Access-Jwt-Assertion", access);
  return exports.default.fetch(`${ORIGIN}${path}`, { redirect: "manual", ...init, headers });
}

function postForm(path: string, access: string | undefined, fields: Record<string, string>) {
  return request(path, access, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
    body: new URLSearchParams(fields),
  });
}

async function storedRow(ownerId: string) {
  return env.DB.prepare("SELECT * FROM inference_credentials WHERE owner_id = ?")
    .bind(ownerId)
    .first<Record<string, string>>();
}

describe("Claude settings page", () => {
  it("requires Access for every route and method", async () => {
    for (const response of await Promise.all([
      request("/manage/claude", undefined),
      postForm("/manage/claude", undefined, ids),
      postForm("/manage/claude/test", undefined, {}),
    ]))
      expect(response.status).toBe(401);
    expect((await request("/manage/claude", "not-a-token")).status).toBe(403);
    expect(tokenRequests).toHaveLength(0);
  });

  it("guards itself without the app-wide /manage middleware", async () => {
    const exchangesBefore = tokenRequests.length;
    const { ownerId, access } = await signedInOwner();
    const alone = new Hono<ApiEnv>().route("/manage/claude", manageClaudeRoutes);
    const send = (path: string, init: RequestInit) => alone.request(`${ORIGIN}${path}`, init, env);
    const form = { "Content-Type": "application/x-www-form-urlencoded" };
    expect((await send("/manage/claude", {})).status).toBe(401);
    expect(
      (
        await send("/manage/claude/test", {
          method: "POST",
          headers: { ...form, Origin: ORIGIN },
          body: "",
        })
      ).status,
    ).toBe(401);
    const crossOrigin = await send("/manage/claude", {
      method: "POST",
      headers: { ...form, Origin: "https://attacker.example", "Cf-Access-Jwt-Assertion": access },
      body: new URLSearchParams(ids),
    });
    expect(crossOrigin.status).toBe(403);
    const oversized = await send("/manage/claude", {
      method: "POST",
      headers: { ...form, Origin: ORIGIN, "Cf-Access-Jwt-Assertion": access },
      body: new URLSearchParams({ ...ids, padding: "x".repeat(5_000) }),
    });
    expect(oversized.status).toBe(413);
    expect(await storedRow(ownerId)).toBeNull();
    expect(tokenRequests).toHaveLength(exchangesBefore);
  });

  it("answers other methods with 405", async () => {
    const { access } = await signedInOwner();
    const test = await request("/manage/claude/test", access);
    expect(test.status).toBe(405);
    expect(test.headers.get("Allow")).toBe("POST");
    const put = await request("/manage/claude", access, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(ids),
    });
    expect(put.status).toBe(405);
    expect(put.headers.get("Allow")).toBe("GET, POST");
    expect((await request("/manage/claude", access, { method: "HEAD" })).status).toBe(200);
  });

  it("shows the Console values for the signed-in owner without scripts", async () => {
    const { ownerId, access } = await signedInOwner();
    const response = await request("/manage/claude", access);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    const body = await response.text();
    expect(body).toContain(`<code>owner:${ownerId}</code>`);
    expect(body).toContain("<code>https://pateat.invalid</code>");
    expect(body).not.toContain("<script");
  });

  it("saves valid identifiers and redisplays them", async () => {
    const { ownerId, access } = await signedInOwner();
    const saved = await postForm("/manage/claude", access, {
      ...ids,
      workspaceId: `  ${ids.workspaceId} `,
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get("Location")).toBe("/manage/claude");
    expect(await storedRow(ownerId)).toMatchObject({
      kind: "wif",
      federation_rule_id: ids.federationRuleId,
      workspace_id: ids.workspaceId,
    });
    expect(await (await request("/manage/claude", access)).text()).toContain(
      `value="${ids.serviceAccountId}"`,
    );
  });

  it("keeps the form reachable when the stored row is no longer valid", async () => {
    const { ownerId, access } = await signedInOwner();
    await env.DB.prepare(
      "INSERT INTO inference_credentials (owner_id, kind, federation_rule_id, organization_id, service_account_id, workspace_id, updated_at) VALUES (?, 'wif', 'bad', ?, ?, ?, ?)",
    )
      .bind(ownerId, ids.organizationId, ids.serviceAccountId, ids.workspaceId, Date.now())
      .run();
    const response = await request("/manage/claude", access);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("The stored identifiers are no longer valid.");
    expect(body).not.toContain('value="bad"');
  });

  it("rejects malformed identifiers, escapes them and stores nothing", async () => {
    const { ownerId, access } = await signedInOwner();
    const response = await postForm("/manage/claude", access, {
      ...ids,
      federationRuleId: '"><script>alert(1)</script>',
    });
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).not.toContain("<script>");
    expect(body).toContain("&quot;&gt;&lt;script&gt;");
    expect(await storedRow(ownerId)).toBeNull();
  });

  it("refuses cross-origin and non-form posts", async () => {
    const { ownerId, access } = await signedInOwner();
    const crossOrigin = await request("/manage/claude", access, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: "https://attacker.example",
      },
      body: new URLSearchParams(ids),
    });
    expect(crossOrigin.status).toBe(403);
    const json = await request("/manage/claude", access, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify(ids),
    });
    expect(json.status).toBe(415);
    expect(await storedRow(ownerId)).toBeNull();
  });

  it("tests the exchange for this owner and never shows the token", async () => {
    const { ownerId, access } = await signedInOwner();
    expect((await postForm("/manage/claude", access, ids)).status).toBe(303);

    tokenResponse = () =>
      Response.json({
        access_token: "sk-ant-oat01-never-shown",
        token_type: "Bearer",
        expires_in: 600,
      });
    const granted = await postForm("/manage/claude/test", access, {});
    expect(granted.status).toBe(200);
    const body = await granted.text();
    expect(body).toContain("Anthropic issued a token valid for 10 minutes.");
    expect(body).not.toContain("sk-ant-oat01");
    const assertion = tokenRequests.at(-1)!["assertion"]!;
    expect(Jwt.decode(assertion).payload["sub"]).toBe(`owner:${ownerId}`);

    tokenResponse = () =>
      Response.json({ access_token: "sk-ant-oat01-short", token_type: "Bearer", expires_in: 20 });
    expect(await (await postForm("/manage/claude/test", access, {})).text()).toMatch(
      /valid for (19|20) seconds\./,
    );

    tokenResponse = () => new Response("{}", { status: 401 });
    expect(await (await postForm("/manage/claude/test", access, {})).text()).toContain(
      "Anthropic refused the assertion",
    );
  });
});
