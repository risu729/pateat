import { manageClaudeSchema, manageClaudeTestSchema } from "@pateat/contracts";
import { env, exports } from "cloudflare:workers";
import { Jwt } from "hono/utils/jwt";
import type { HonoJsonWebKey } from "hono/utils/jwt/jws";
import * as v from "valibot";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";

// Synthetic Access key, identities and federation identifiers only. Anthropic's token
// endpoint is answered locally; no request leaves the test.

const ORIGIN = "https://pateat.invalid";
const ACCESS_ISSUER = "https://pateat-test.cloudflareaccess.com";
const JWKS_URL = `${ACCESS_ISSUER}/cdn-cgi/access/certs`;
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const API = "/manage/api/claude";
const TEST = "/manage/api/claude/test";
const TOKEN = "sk-ant-oat01-synthetic-never-shown";

const ids = {
  federationRuleId: "fdrl_01SyntheticRule",
  organizationId: "00000000-0000-4000-8000-000000000000",
  serviceAccountId: "svac_01SyntheticAccount",
  workspaceId: "wrkspc_01SyntheticWorkspace",
};

let privateJwk: HonoJsonWebKey;
let tokenResponse: () => Response | Promise<Response>;
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

beforeEach(() => {
  // A test that reaches the token endpoint without setting an answer sees a failure.
  tokenResponse = () => new Response("unexpected", { status: 500 });
});

afterAll(() => {
  vi.restoreAllMocks();
});

async function accessFor(subject: string) {
  const now = Math.floor(Date.now() / 1000);
  return Jwt.sign(
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
}

/** An Access identity whose owner exists, as after pairing a device. */
async function signedInOwner() {
  const subject = `subject-${crypto.randomUUID()}`;
  const ownerId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (id, created_at) VALUES (?, ?)").bind(ownerId, Date.now()),
    env.DB.prepare(
      "INSERT INTO owner_identities (issuer, subject, owner_id, created_at) VALUES (?, ?, ?, ?)",
    ).bind(ACCESS_ISSUER, subject, ownerId, Date.now()),
  ]);
  return { ownerId, subject, access: await accessFor(subject) };
}

function request(path: string, access: string | undefined, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (access) headers.set("Cf-Access-Jwt-Assertion", access);
  return exports.default.fetch(`${ORIGIN}${path}`, { redirect: "manual", ...init, headers });
}

/** A write as the web UI makes it: same origin, JSON unless `headers` says otherwise. */
function write(
  method: "PUT" | "POST",
  path: string,
  access: string | undefined,
  body?: string,
  headers: Record<string, string> = {},
) {
  return request(path, access, {
    method,
    headers: { "Content-Type": "application/json", Origin: ORIGIN, ...headers },
    ...(body === undefined ? {} : { body }),
  });
}

const put = (access: string | undefined, body: unknown, headers?: Record<string, string>) =>
  write("PUT", API, access, JSON.stringify(body), headers);
const runTest = (access: string | undefined, headers?: Record<string, string>) =>
  write("POST", TEST, access, undefined, headers);

async function stateOf(response: Response) {
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toMatch(/^application\/json/);
  return v.parse(manageClaudeSchema, await response.json());
}

async function testResult(response: Response) {
  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).not.toContain(TOKEN);
  return v.parse(manageClaudeTestSchema, JSON.parse(body)).result;
}

/** Status and JSON body, for comparing many answers at once. */
async function answer(response: Response) {
  return { status: response.status, body: (await response.json()) as unknown };
}

async function storedRow(ownerId: string) {
  return env.DB.prepare("SELECT * FROM inference_credentials WHERE owner_id = ?")
    .bind(ownerId)
    .first<Record<string, string>>();
}

async function storedRowCount(ownerId: string) {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM inference_credentials WHERE owner_id = ?",
  )
    .bind(ownerId)
    .first<{ count: number }>();
  return row?.count ?? 0;
}

describe("Claude credentials API", () => {
  it("requires Access on every route before reading anything", async () => {
    const { ownerId, access } = await signedInOwner();
    expect((await put(access, { version: 1, identifiers: ids })).status).toBe(200);
    const exchangesBefore = tokenRequests.length;
    const forged = `${access.slice(0, -4)}AAAA`;
    const tokens = [undefined, "not-a-token", forged];
    const answers = await Promise.all(
      tokens.flatMap((token) =>
        [
          request(API, token),
          put(token, { version: 1, identifiers: { ...ids, workspaceId: "wrkspc_02Other" } }),
          runTest(token),
        ].map(async (response) => answer(await response)),
      ),
    );
    const unauthorized = { status: 401, body: { error: "unauthorized" } };
    const forbidden = { status: 403, body: { error: "forbidden" } };
    expect(answers).toEqual([
      ...[unauthorized, unauthorized, unauthorized],
      ...[forbidden, forbidden, forbidden],
      ...[forbidden, forbidden, forbidden],
    ]);
    expect(tokenRequests).toHaveLength(exchangesBefore);
    expect(await storedRow(ownerId)).toMatchObject({ workspace_id: ids.workspaceId });
  });

  it("refuses cross-origin writes and changes nothing", async () => {
    const { ownerId, access } = await signedInOwner();
    const crossOrigin = await Promise.all(
      ["https://attacker.example", "null"].map(async (origin) =>
        answer(await put(access, { version: 1, identifiers: ids }, { Origin: origin })),
      ),
    );
    expect(crossOrigin).toEqual([
      { status: 403, body: { error: "forbidden" } },
      { status: 403, body: { error: "forbidden" } },
    ]);
    const withoutOrigin = await request(API, access, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, identifiers: ids }),
    });
    expect(withoutOrigin.status).toBe(403);
    expect(await storedRow(ownerId)).toBeNull();

    expect((await put(access, { version: 1, identifiers: ids })).status).toBe(200);
    const exchangesBefore = tokenRequests.length;
    const crossOriginTest = await runTest(access, { Origin: "https://attacker.example" });
    expect(crossOriginTest.status).toBe(403);
    expect(await crossOriginTest.json()).toEqual({ error: "forbidden" });
    expect(tokenRequests).toHaveLength(exchangesBefore);
  });

  it("answers other methods with 405 and the allowed ones", async () => {
    const { access } = await signedInOwner();
    const cases = [
      [API, "POST", "GET, PUT"],
      [API, "DELETE", "GET, PUT"],
      [API, "PATCH", "GET, PUT"],
      [TEST, "GET", "POST"],
      [TEST, "PUT", "POST"],
    ] as const;
    const answers = await Promise.all(
      cases.map(async ([path, method]) => {
        const response = await request(path, access, { method, headers: { Origin: ORIGIN } });
        return { ...(await answer(response)), allow: response.headers.get("Allow") };
      }),
    );
    expect(answers).toEqual(
      cases.map(([, , allow]) => ({
        status: 405,
        body: { error: "method_not_allowed" },
        allow,
      })),
    );
    const page = await request("/manage/claude", access, { method: "POST" });
    expect(page.status).toBe(405);
    expect(page.headers.get("Allow")).toBe("GET");
  });

  it("answers not_paired for an identity without an owner and creates none", async () => {
    const subject = `subject-${crypto.randomUUID()}`;
    const access = await accessFor(subject);
    const exchangesBefore = tokenRequests.length;
    const responses = await Promise.all([
      request(API, access),
      put(access, { version: 1, identifiers: ids }),
      runTest(access),
    ]);
    expect(await Promise.all(responses.map(answer))).toEqual(
      responses.map(() => ({ status: 404, body: { error: "not_paired" } })),
    );
    expect(tokenRequests).toHaveLength(exchangesBefore);
    const identity = await env.DB.prepare(
      "SELECT owner_id FROM owner_identities WHERE issuer = ? AND subject = ?",
    )
      .bind(ACCESS_ISSUER, subject)
      .first();
    expect(identity).toBeNull();
  });

  it("shows the Console values for the signed-in owner", async () => {
    const { ownerId, access } = await signedInOwner();
    const response = await request(API, access);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await stateOf(response)).toEqual({
      version: 1,
      console: {
        issuer: "https://pateat.invalid",
        subject: `owner:${ownerId}`,
        audience: "https://api.anthropic.com",
      },
      identifiers: null,
      storedInvalid: false,
    });
  });

  it("shows no issuer when the service has none configured, and the test says so", async () => {
    const { ownerId, access } = await signedInOwner();
    expect((await put(access, { version: 1, identifiers: ids })).status).toBe(200);
    const unconfigured = { ...env, OIDC_ISSUER: "" };
    const headers = { "Cf-Access-Jwt-Assertion": access, Origin: ORIGIN };
    const state = await stateOf(await app.request(`${ORIGIN}${API}`, { headers }, unconfigured));
    expect(state.console).toEqual({
      issuer: null,
      subject: `owner:${ownerId}`,
      audience: "https://api.anthropic.com",
    });
    expect(state.identifiers).toEqual(ids);
    const exchangesBefore = tokenRequests.length;
    const tested = await app.request(`${ORIGIN}${TEST}`, { method: "POST", headers }, unconfigured);
    expect(await testResult(tested)).toEqual({ status: "issuer_unavailable" });
    expect(tokenRequests).toHaveLength(exchangesBefore);
  });

  it("saves identifiers, replaces them and shows them only to their owner", async () => {
    const { ownerId, access } = await signedInOwner();
    const saved = await stateOf(await put(access, { version: 1, identifiers: ids }));
    expect(saved).toMatchObject({ identifiers: ids, storedInvalid: false });
    expect(saved.console.subject).toBe(`owner:${ownerId}`);
    expect(await storedRow(ownerId)).toMatchObject({
      kind: "wif",
      federation_rule_id: ids.federationRuleId,
      organization_id: ids.organizationId,
      service_account_id: ids.serviceAccountId,
      workspace_id: ids.workspaceId,
    });
    expect((await stateOf(await request(API, access))).identifiers).toEqual(ids);

    const replacement = { ...ids, workspaceId: "wrkspc_02Replacement" };
    expect(
      (await stateOf(await put(access, { version: 1, identifiers: replacement }))).identifiers,
    ).toEqual(replacement);
    expect(await storedRowCount(ownerId)).toBe(1);
    expect(await storedRow(ownerId)).toMatchObject({ workspace_id: "wrkspc_02Replacement" });

    const other = await signedInOwner();
    expect((await stateOf(await request(API, other.access))).identifiers).toBeNull();
  });

  it("rejects malformed identifiers without echoing them and keeps what is saved", async () => {
    const { ownerId, access } = await signedInOwner();
    const marker = "<script>never-echoed</script>";
    const bodies: unknown[] = [
      { version: 1, identifiers: { ...ids, federationRuleId: `fdrl_${marker}` } },
      { version: 1, identifiers: { ...ids, organizationId: marker } },
      { version: 1, identifiers: { ...ids, serviceAccountId: "svac_bad!" } },
      { version: 1, identifiers: { ...ids, workspaceId: "workspace_01" } },
      // The service does not trim; the page does before it saves.
      { version: 1, identifiers: { ...ids, workspaceId: ` ${ids.workspaceId}` } },
      { version: 1, identifiers: { ...ids, federationRuleId: `fdrl_${"a".repeat(65)}` } },
      { version: 1, identifiers: { ...ids, extra: marker } },
      { version: 1, identifiers: { ...ids, workspaceId: undefined } },
      { version: 1, identifiers: ids, extra: marker },
      { version: 2, identifiers: ids },
      { identifiers: ids },
      { version: 1, identifiers: null },
      ids,
      [marker],
    ];
    const rejected = await Promise.all([
      ...bodies.map((body) => put(access, body)),
      write("PUT", API, access, `{"version":1,"identifiers":${marker}`),
    ]);
    const texts = await Promise.all(rejected.map((response) => response.text()));
    expect(rejected.map((response) => response.status)).toEqual(rejected.map(() => 400));
    for (const text of texts) {
      expect(JSON.parse(text)).toEqual({ error: "bad_request" });
      expect(text).not.toContain("never-echoed");
    }
    expect(await storedRow(ownerId)).toBeNull();

    // A rejected write leaves the saved identifiers as they were.
    expect((await put(access, { version: 1, identifiers: ids })).status).toBe(200);
    expect(
      (await put(access, { version: 1, identifiers: { ...ids, workspaceId: "bad" } })).status,
    ).toBe(400);
    expect((await stateOf(await request(API, access))).identifiers).toEqual(ids);
  });

  it("accepts only JSON bodies of a bounded size", async () => {
    const { ownerId, access } = await signedInOwner();
    const json = JSON.stringify({ version: 1, identifiers: ids });
    const unsupported = await Promise.all([
      ...["application/x-www-form-urlencoded", "text/plain", "application/merge-patch+json"].map(
        (type) => write("PUT", API, access, json, { "Content-Type": type }),
      ),
      write("PUT", API, access, new URLSearchParams(ids).toString(), {
        "Content-Type": "application/x-www-form-urlencoded",
      }),
    ]);
    expect(await Promise.all(unsupported.map(answer))).toEqual(
      unsupported.map(() => ({ status: 415, body: { error: "unsupported_media_type" } })),
    );
    const oversized = await put(access, {
      version: 1,
      identifiers: ids,
      padding: "x".repeat(130 * 1024),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "payload_too_large" });
    expect(await storedRow(ownerId)).toBeNull();
    expect(
      (
        await write("PUT", API, access, json, {
          "Content-Type": "application/json; charset=utf-8",
        })
      ).status,
    ).toBe(200);
  });

  it("reports a stored row that no longer validates and never exchanges it", async () => {
    const { ownerId, access } = await signedInOwner();
    await env.DB.prepare(
      "INSERT INTO inference_credentials (owner_id, kind, federation_rule_id, organization_id, service_account_id, workspace_id, updated_at) VALUES (?, 'wif', 'bad', ?, ?, ?, ?)",
    )
      .bind(ownerId, ids.organizationId, ids.serviceAccountId, ids.workspaceId, Date.now())
      .run();
    const response = await request(API, access);
    const text = await response.clone().text();
    expect(text).not.toContain(ids.serviceAccountId);
    expect(await stateOf(response)).toMatchObject({ identifiers: null, storedInvalid: true });

    const exchangesBefore = tokenRequests.length;
    expect(await testResult(await runTest(access))).toEqual({ status: "stored_invalid" });
    expect(tokenRequests).toHaveLength(exchangesBefore);

    // Saving again replaces the row.
    expect(await stateOf(await put(access, { version: 1, identifiers: ids }))).toMatchObject({
      identifiers: ids,
      storedInvalid: false,
    });
  });

  it("asks for identifiers before testing", async () => {
    const { access } = await signedInOwner();
    const exchangesBefore = tokenRequests.length;
    expect(await testResult(await runTest(access))).toEqual({ status: "not_configured" });
    expect(tokenRequests).toHaveLength(exchangesBefore);
  });

  it("tests the exchange for the caller's owner and never returns the token", async () => {
    const { ownerId, access } = await signedInOwner();
    const other = await signedInOwner();
    expect((await put(access, { version: 1, identifiers: ids })).status).toBe(200);
    expect(
      (
        await put(other.access, {
          version: 1,
          identifiers: { ...ids, workspaceId: "wrkspc_02OtherOwner" },
        })
      ).status,
    ).toBe(200);

    tokenResponse = () =>
      Response.json({ access_token: TOKEN, token_type: "Bearer", expires_in: 600 });
    const result = await testResult(await runTest(access));
    expect(result.status).toBe("ready");
    expect(result.status === "ready" && result.expiresInSeconds).toBeGreaterThanOrEqual(599);
    expect(result.status === "ready" && result.expiresInSeconds).toBeLessThanOrEqual(600);
    const sent = tokenRequests.at(-1)!;
    expect(sent).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      federation_rule_id: ids.federationRuleId,
      organization_id: ids.organizationId,
      service_account_id: ids.serviceAccountId,
      workspace_id: ids.workspaceId,
    });
    const claims = Jwt.decode(sent["assertion"]!).payload;
    expect(claims["sub"]).toBe(`owner:${ownerId}`);
    expect(claims["aud"]).toBe("https://api.anthropic.com");
    expect(claims["iss"]).toBe("https://pateat.invalid");

    // The other owner's test signs for that owner with that owner's identifiers.
    await testResult(await runTest(other.access));
    const otherSent = tokenRequests.at(-1)!;
    expect(otherSent["workspace_id"]).toBe("wrkspc_02OtherOwner");
    expect(Jwt.decode(otherSent["assertion"]!).payload["sub"]).toBe(`owner:${other.ownerId}`);
  });

  it("reports refused and failed exchanges", async () => {
    const { access } = await signedInOwner();
    expect((await put(access, { version: 1, identifiers: ids })).status).toBe(200);
    const cases: [() => Response | Promise<Response>, unknown][] = [
      [() => new Response("{}", { status: 401 }), { status: "rejected", httpStatus: 401 }],
      [() => new Response("{}", { status: 403 }), { status: "rejected", httpStatus: 403 }],
      [() => new Response("{}", { status: 400 }), { status: "rejected", httpStatus: 400 }],
      [() => new Response("oops", { status: 500 }), { status: "failed", httpStatus: 500 }],
      [() => new Response("oops", { status: 503 }), { status: "failed", httpStatus: 503 }],
      [
        () => Response.json({ access_token: TOKEN, token_type: "Bearer" }),
        { status: "failed", httpStatus: 200 },
      ],
      [
        () => {
          throw new TypeError("Network connection lost");
        },
        { status: "failed" },
      ],
    ];
    for (const [tokenAnswer, expected] of cases) {
      tokenResponse = tokenAnswer;
      const exchangesBefore = tokenRequests.length;
      // oxlint-disable-next-line no-await-in-loop -- each case sets the one token answer
      expect(await testResult(await runTest(access))).toEqual(expected);
      expect(tokenRequests).toHaveLength(exchangesBefore + 1);
    }
  });
});

describe("Claude page", () => {
  it("serves the web UI only through Access", async () => {
    const { access } = await signedInOwner();
    const page = await request("/manage/claude", access);
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(page.headers.get("Content-Security-Policy")).toContain("script-src 'self'");
    expect(await page.text()).toContain("Pateat test app");

    const refused = await Promise.all([
      request("/manage/claude", undefined),
      request("/manage/claude", "not-a-token"),
    ]);
    expect(refused.map((response) => response.status)).toEqual([401, 403]);
    for (const body of await Promise.all(refused.map((response) => response.text())))
      expect(body).not.toContain("Pateat test app");
    expect((await request("/manage/claude/test", access)).status).toBe(404);
  });
});
