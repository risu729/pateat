import { env, exports } from "cloudflare:workers";
import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import { describe, expect, it } from "vitest";
import {
  resolveClaudeCredential,
  saveWifCredential,
  type WifIdentifiers,
} from "../src/claude/credentials";
import { readIssuerConfig, signOwnerAssertion } from "../src/claude/issuer";

// Synthetic issuer key (generated per run in vitest.config.ts), owners and federation
// identifiers only. No request leaves the test: the token endpoint is a fake fetch.

const ISSUER = "https://pateat.invalid";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";

const ids: WifIdentifiers = {
  federationRuleId: "fdrl_01SyntheticRule",
  organizationId: "00000000-0000-4000-8000-000000000000",
  serviceAccountId: "svac_01SyntheticAccount",
  workspaceId: "wrkspc_01SyntheticWorkspace",
};

async function createOwner() {
  const ownerId = `owner-${crypto.randomUUID()}`;
  await env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)")
    .bind(ownerId, Date.now())
    .run();
  return ownerId;
}

function get(path: string, init?: RequestInit) {
  return exports.default.fetch(`${ISSUER}${path}`, init);
}

async function publishedKeys() {
  const body = (await (await get("/.well-known/jwks.json")).json()) as {
    keys: HonoJsonWebKey[];
  };
  return body.keys;
}

type Exchange = { url: string; init: RequestInit | undefined; body: Record<string, string> };

function fakeTokenEndpoint(respond: () => Response | Promise<Response>) {
  const calls: Exchange[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init, body: JSON.parse(String(init?.body)) });
    return respond();
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const granted = () =>
  Response.json({
    access_token: "sk-ant-oat01-synthetic",
    token_type: "Bearer",
    expires_in: 600,
    scope: "workspace:inference",
  });

describe("OIDC issuer metadata", () => {
  it("publishes discovery and only the public half of the key", async () => {
    const discovery = await get("/.well-known/openid-configuration");
    expect(discovery.status).toBe(200);
    expect(discovery.headers.get("Cache-Control")).toBe("no-store");
    expect(await discovery.json()).toEqual({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["ES256"],
    });

    const keys = await publishedKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      kty: "EC",
      crv: "P-256",
      alg: "ES256",
      kid: "test-2026-10",
      use: "sig",
    });
    expect(keys[0]).not.toHaveProperty("d");
  });

  it("answers other methods with 405", async () => {
    const response = await get("/.well-known/jwks.json", { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });

  it("fails closed on missing or malformed settings", () => {
    const keys = JSON.parse(env.OIDC_SIGNING_KEYS) as {
      signingKeyId: string;
      keys: Record<string, string>[];
    };
    const valid = { OIDC_ISSUER: ISSUER, OIDC_SIGNING_KEYS: env.OIDC_SIGNING_KEYS };
    expect(readIssuerConfig(valid)).not.toBeNull();
    for (const broken of [
      { ...valid, OIDC_ISSUER: undefined },
      { ...valid, OIDC_SIGNING_KEYS: undefined },
      { ...valid, OIDC_ISSUER: "http://pateat.invalid" },
      { ...valid, OIDC_ISSUER: "https://pateat.invalid/" },
      { ...valid, OIDC_ISSUER: "https://pateat.invalid:8443" },
      { ...valid, OIDC_ISSUER: "https://192.0.2.1" },
      { ...valid, OIDC_SIGNING_KEYS: "not json" },
      { ...valid, OIDC_SIGNING_KEYS: JSON.stringify({ ...keys, signingKeyId: "other" }) },
      {
        ...valid,
        OIDC_SIGNING_KEYS: JSON.stringify({ ...keys, keys: [...keys.keys, keys.keys[0]] }),
      },
      {
        ...valid,
        OIDC_SIGNING_KEYS: JSON.stringify({ ...keys, keys: [{ ...keys.keys[0], alg: "HS256" }] }),
      },
    ])
      expect(readIssuerConfig(broken)).toBeNull();
  });

  it("signs single-use owner assertions that verify against the published key set", async () => {
    const config = readIssuerConfig(env)!;
    const now = Date.UTC(2026, 9, 11, 6, 0, 0);
    const first = await signOwnerAssertion(config, "owner-a", now);
    const second = await signOwnerAssertion(config, "owner-a", now);

    expect(Jwt.decode(first).header).toEqual({ alg: "ES256", typ: "JWT", kid: "test-2026-10" });
    const { payload } = Jwt.decode(first);
    expect(payload).toMatchObject({
      iss: ISSUER,
      sub: "owner:owner-a",
      aud: "https://api.anthropic.com",
      iat: now / 1000,
      exp: now / 1000 + 300,
    });
    expect(payload["jti"]).not.toBe(Jwt.decode(second).payload["jti"]);

    const verified = await Jwt.verifyWithJwks(await signOwnerAssertion(config, "owner-a"), {
      keys: await publishedKeys(),
      allowedAlgorithms: ["ES256"],
      verification: { iss: ISSUER, aud: "https://api.anthropic.com" },
    });
    expect(verified["sub"]).toBe("owner:owner-a");
  });
});

describe("Claude credential lookup", () => {
  it("reports owners without credentials and never calls Anthropic", async () => {
    const endpoint = fakeTokenEndpoint(granted);
    expect(
      await resolveClaudeCredential(env, await createOwner(), { fetch: endpoint.fetch }),
    ).toEqual({ status: "not_configured" });
    expect(endpoint.calls).toHaveLength(0);
  });

  it("exchanges a fresh assertion for the requesting owner only", async () => {
    const ownerId = await createOwner();
    const otherOwner = await createOwner();
    await saveWifCredential(env.DB, ownerId, ids);
    await saveWifCredential(env.DB, otherOwner, {
      ...ids,
      federationRuleId: "fdrl_01OtherRule",
    });
    const endpoint = fakeTokenEndpoint(granted);
    const now = Date.now();

    const result = await resolveClaudeCredential(env, ownerId, {
      fetch: endpoint.fetch,
      now: () => now,
    });

    expect(result).toEqual({
      status: "ready",
      credential: { authToken: "sk-ant-oat01-synthetic" },
      expiresAt: now + 600_000,
    });
    expect(endpoint.calls).toHaveLength(1);
    const [call] = endpoint.calls;
    expect(call!.url).toBe(TOKEN_URL);
    expect(call!.init?.method).toBe("POST");
    expect(call!.body).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      federation_rule_id: ids.federationRuleId,
      organization_id: ids.organizationId,
      service_account_id: ids.serviceAccountId,
      workspace_id: ids.workspaceId,
    });
    const assertion = await Jwt.verifyWithJwks(call!.body["assertion"]!, {
      keys: await publishedKeys(),
      allowedAlgorithms: ["ES256"],
      verification: { iss: ISSUER, aud: "https://api.anthropic.com" },
    });
    expect(assertion["sub"]).toBe(`owner:${ownerId}`);

    // A second exchange signs a new assertion; Anthropic rejects a reused jti.
    await resolveClaudeCredential(env, ownerId, { fetch: endpoint.fetch });
    expect(endpoint.calls[1]!.body["assertion"]).not.toBe(call!.body["assertion"]);
  });

  it("replaces an owner's identifiers instead of adding a second row", async () => {
    const ownerId = await createOwner();
    await saveWifCredential(env.DB, ownerId, ids);
    await saveWifCredential(env.DB, ownerId, { ...ids, workspaceId: "wrkspc_01Replaced" });
    const endpoint = fakeTokenEndpoint(granted);
    await resolveClaudeCredential(env, ownerId, { fetch: endpoint.fetch });
    expect(endpoint.calls[0]!.body["workspace_id"]).toBe("wrkspc_01Replaced");
  });

  it("rejects malformed identifiers before storing them", async () => {
    const ownerId = await createOwner();
    const malformed = [
      { ...ids, federationRuleId: "rule_01" },
      { ...ids, organizationId: "not-a-uuid" },
      { ...ids, serviceAccountId: "svac_" },
      { ...ids, workspaceId: "default" },
      { ...ids, apiKey: "sk-ant-api" },
    ];
    await Promise.all(
      malformed.map((bad) =>
        expect(saveWifCredential(env.DB, ownerId, bad as WifIdentifiers)).rejects.toThrow(),
      ),
    );
    expect(await resolveClaudeCredential(env, ownerId)).toEqual({ status: "not_configured" });
  });

  it("maps refusals, failures and malformed responses without a token", async () => {
    const ownerId = await createOwner();
    await saveWifCredential(env.DB, ownerId, ids);
    const resolveWith = (respond: () => Response | Promise<Response>) =>
      resolveClaudeCredential(env, ownerId, { fetch: fakeTokenEndpoint(respond).fetch });

    const denied = () =>
      Response.json(
        {
          type: "error",
          error: { type: "authentication_error", message: "Authentication failed" },
        },
        { status: 401 },
      );
    expect(await resolveWith(denied)).toEqual({ status: "rejected", httpStatus: 401 });
    expect(await resolveWith(() => new Response("busy", { status: 529 }))).toEqual({
      status: "failed",
      httpStatus: 529,
    });
    expect(await resolveWith(() => new Response("not json"))).toEqual({
      status: "failed",
      httpStatus: 200,
    });
    expect(
      await resolveWith(() =>
        Response.json({ access_token: "", token_type: "Bearer", expires_in: 600 }),
      ),
    ).toEqual({ status: "failed", httpStatus: 200 });
    expect(
      await resolveWith(() => {
        throw new TypeError("network down");
      }),
    ).toEqual({ status: "failed" });
  });

  it("signs nothing when the issuer is not configured", async () => {
    const ownerId = await createOwner();
    await saveWifCredential(env.DB, ownerId, ids);
    const endpoint = fakeTokenEndpoint(granted);
    expect(
      await resolveClaudeCredential({ DB: env.DB }, ownerId, { fetch: endpoint.fetch }),
    ).toEqual({ status: "issuer_unavailable" });
    expect(endpoint.calls).toHaveLength(0);
  });
});
