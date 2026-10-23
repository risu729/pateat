import {
  devicePairResultSchema,
  manageDevicesSchema,
  manageProblemsSchema,
  manageRecipesSchema,
  manageRequestLogDeletedSchema,
  manageRequestLogSchema,
  type DevicePairResult,
  type LoginRecipeDocument,
  type PageKind,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import {
  claims,
  deviceApi,
  forgedAccess,
  installAccessKeys,
  jwks,
  type JwksMode,
  newSubject,
  ORIGIN,
  owner,
  ownerIdFor,
  pairOwner,
  rejectedTokens,
  request,
  type Owner,
} from "./access-helpers";
import { writeRecipe } from "../src/recipe-store";
import { OWNER_LIMIT, withLimiter } from "./limiter";

// Synthetic Access keys, identities and extension IDs only. Every test uses fresh
// subjects so results never depend on rows written by another test.

installAccessKeys();

/** The synthetic extension ID listed in vitest.config.ts. */
const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

/** A web UI API call as its own page makes it: same origin unless `origin` says otherwise. */
function manageApi(
  path: string,
  access: string | undefined,
  method: string,
  origin: string | null = ORIGIN,
) {
  return request(path, { method, access, headers: origin ? { Origin: origin } : {} });
}

function postPair(access: string | undefined, label = "Test laptop") {
  return request("/pair", {
    method: "POST",
    access,
    headers: { "Content-Type": "application/json", Origin: EXTENSION_ORIGIN },
    body: JSON.stringify({ version: 1, label }),
  });
}

/** Pairs a device for `by` as the extension does (ADR 0020). */
async function pairDevice(by: Owner, label = "Test laptop"): Promise<DevicePairResult> {
  const response = await postPair(by.token, label);
  expect(response.status).toBe(201);
  return v.parse(devicePairResultSchema, await response.json());
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
    const responses = await Promise.all([
      postPair(undefined),
      request("/manage"),
      request("/manage/assets/app.js"),
      request("/manage/api/devices"),
      manageApi(`/manage/api/devices/${crypto.randomUUID()}/revoke`, undefined, "POST"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401]);
    expect(await responses[0]!.json()).toEqual({ error: "unauthorized" });
    expect(await responses[3]!.json()).toEqual({ error: "unauthorized" });
    const head = await Promise.all(
      ["/manage", "/manage/assets/app.js"].map((path) => request(path, { method: "HEAD" })),
    );
    expect(head.map((response) => response.status)).toEqual([401, 401]);
    const forged = await forgedAccess(claims(newSubject()));
    expect((await request("/manage/assets/app.js", { access: forged })).status).toBe(403);
  });

  it.each(rejectedTokens)("rejects %s", async (_, token) => {
    const response = await request("/manage", { access: await token() });
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("Pateat test app");
  });

  it("refuses the pairing-only application's audience on every owner route", async () => {
    // The owner exists and has a device, paired through the pairing-only application.
    const viaPair = await pairOwner();
    const device = await pairDevice(viaPair);
    const pages = [
      "/manage",
      "/manage/dashboard",
      "/manage/sites",
      "/manage/sites/https/bank.example",
      "/manage/assets/app.js",
      "/manage/claude",
    ];
    const pageResponses = await Promise.all(
      pages.map((path) => request(path, { access: viaPair.token })),
    );
    expect(pageResponses.map((response) => response.status)).toEqual(pages.map(() => 403));
    for (const response of pageResponses)
      expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
    const pageBodies = await Promise.all(pageResponses.map((response) => response.text()));
    for (const body of pageBodies) expect(body).not.toContain("Pateat test app");
    // A well-formed same-origin write is refused by Access, not by origin or body checks.
    const claudeWrite = await request("/manage/api/claude", {
      method: "PUT",
      access: viaPair.token,
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        version: 1,
        identifiers: {
          federationRuleId: "fdrl_01SyntheticRule",
          organizationId: "00000000-0000-4000-8000-000000000000",
          serviceAccountId: "svac_01SyntheticAccount",
          workspaceId: "wrkspc_01SyntheticWorkspace",
        },
      }),
    });

    const apiResponses = await Promise.all([
      manageApi("/manage/api/devices", viaPair.token, "GET"),
      manageApi("/manage/api/settings", viaPair.token, "GET"),
      manageApi("/manage/api/recipes", viaPair.token, "GET"),
      manageApi("/manage/api/dashboard", viaPair.token, "GET"),
      manageApi(`/manage/api/devices/${device.deviceId}/revoke`, viaPair.token, "POST"),
      manageApi("/manage/api/models", viaPair.token, "GET"),
      manageApi("/manage/api/claude", viaPair.token, "GET"),
      manageApi("/manage/api/claude/test", viaPair.token, "POST"),
      claudeWrite,
    ]);
    expect(apiResponses.map((response) => response.status)).toEqual(apiResponses.map(() => 403));
    expect(await Promise.all(apiResponses.map((response) => response.json()))).toEqual(
      apiResponses.map(() => ({ error: "forbidden" })),
    );

    // The device was not revoked, no identifiers were saved, and the host-wide
    // application still reaches the owner.
    expect((await deviceApi(device.credential)).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT 1 FROM inference_credentials WHERE owner_id = ?")
        .bind(await ownerIdFor(viaPair.subject))
        .first(),
    ).toBeNull();
    const viaHost = await owner(viaPair.subject);
    expect((await request("/manage", { access: viaHost.token })).status).toBe(200);
    const listed = v.parse(
      manageDevicesSchema,
      await (await manageApi("/manage/api/devices", viaHost.token, "GET")).json(),
    );
    expect(listed.devices.map((entry) => entry.id)).toEqual([device.deviceId]);
  });

  /** Runs `body` while the mocked key set answers as `mode`, then restores it. */
  async function duringOutage<T>(mode: JwksMode, body: () => Promise<T>): Promise<T> {
    jwks.mode = mode;
    try {
      return await body();
    } finally {
      jwks.mode = "ok";
    }
  }

  const outages: [string, JwksMode][] = [
    ["a non-OK response", "status"],
    ["a JSON body that is not a key set", "malformed"],
    ["a body that is not JSON", "not-json"],
    ["a fetch that rejects", "reject"],
  ];

  it.each(outages)(
    "treats %s for the signing keys as an outage, not a refused sign-in",
    async (_, mode) => {
      const viaHost = await owner();
      const viaPair = await pairOwner();
      const pages: [string, string][] = [
        ["/manage", viaHost.token],
        ["/manage/sites", viaHost.token],
        ["/manage/sites/https/bank.example", viaHost.token],
        ["/manage/assets/app.js", viaHost.token],
        ["/manage/claude", viaHost.token],
        ["/pair/signed-in", viaPair.token],
      ];
      const { pageResponses, apiResponses, missing } = await duringOutage(mode, async () => ({
        pageResponses: await Promise.all(pages.map(([path, access]) => request(path, { access }))),
        apiResponses: await Promise.all([
          postPair(viaPair.token),
          postPair(viaHost.token),
          manageApi("/manage/api/devices", viaHost.token, "GET"),
          manageApi("/manage/api/settings", viaHost.token, "GET"),
          manageApi(`/manage/api/devices/${crypto.randomUUID()}/revoke`, viaHost.token, "POST"),
        ]),
        // A missing token is refused before any key is fetched.
        missing: await Promise.all([request("/manage"), postPair(undefined)]),
      }));

      expect(pageResponses.map((response) => response.status)).toEqual(pages.map(() => 503));
      for (const response of pageResponses)
        expect(response.headers.get("Content-Type")).toMatch(/^text\/html/);
      for (const body of await Promise.all(pageResponses.map((response) => response.text()))) {
        expect(body).toContain("Your sign-in could not be checked. Try again later.");
        expect(body).not.toContain("Access denied");
        expect(body).not.toContain("Pateat test app");
      }
      expect(apiResponses.map((response) => response.status)).toEqual(apiResponses.map(() => 503));
      expect(await Promise.all(apiResponses.map((response) => response.json()))).toEqual(
        apiResponses.map(() => ({ error: "access_keys_unavailable" })),
      );
      expect(missing.map((response) => response.status)).toEqual([401, 401]);
      // No owner was created by the pairing attempts.
      expect(await ownerIdFor(viaPair.subject)).toBeNull();
      expect(await ownerIdFor(viaHost.subject)).toBeNull();

      // Once the keys answer again, the same tokens work.
      expect((await request("/manage", { access: viaHost.token })).status).toBe(200);
      expect((await postPair(viaPair.token)).status).toBe(201);
    },
  );

  it("gives up on signing keys that never arrive after its timeout", async () => {
    // The real timeout is 5 s; shorten the requested signal so the abort really fires.
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const requested: number[] = [];
    const spy = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      requested.push(ms);
      return timeout(20);
    });
    try {
      const responses = await duringOutage("hang", async () =>
        Promise.all([
          request("/manage", { access: (await owner()).token }),
          postPair((await pairOwner()).token),
        ]),
      );
      expect(responses.map((response) => response.status)).toEqual([503, 503]);
      expect(requested).toEqual([5_000, 5_000]);
    } finally {
      spy.mockRestore();
    }
  }, 2_000);

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
});

describe("owner web UI", () => {
  it("serves the app and its assets only at known paths, unframeable and script-limited", async () => {
    const { token } = await owner();
    const page = await request("/manage", { access: token });
    expect(page.status).toBe(200);
    expect(page.headers.get("Content-Type")).toMatch(/^text\/html/);
    expect(await page.text()).toContain("Pateat test app");
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

  it("answers API Access failures with error codes", async () => {
    const forged = await forgedAccess(claims(newSubject()));
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
    const limitedEnv = withLimiter("OWNER_LIMITER", OWNER_LIMIT);
    const send = (path: string, access: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("Cf-Access-Jwt-Assertion", access);
      return app.request(`${ORIGIN}${path}`, { ...init, headers }, limitedEnv);
    };
    const { token } = await owner();
    const statuses: number[] = [];
    for (let attempt = 0; attempt < OWNER_LIMIT; attempt += 1)
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts sequential calls
      statuses.push((await send("/manage/api/devices", token)).status);
    expect(statuses.every((status) => status === 200)).toBe(true);
    const limited = await send(`/manage/api/devices/${crypto.randomUUID()}/revoke`, token, {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await limited.json()).toEqual({ error: "rate_limited" });
    expect((await send("/manage/api/devices", (await owner()).token)).status).toBe(200);
  });

  it("lists only the signed-in owner's devices, newest first", async () => {
    const first = await owner();
    const second = await owner();
    const older = await pairDevice(first, "First owner laptop");
    await pairDevice(second, "Second owner phone");
    const newer = await pairDevice(first, "First owner phone");
    const response = await request("/manage/api/devices", { access: first.token });
    const body = v.parse(manageDevicesSchema, await response.json());
    expect(body.devices.map((device) => [device.id, device.label, device.revokedAt])).toEqual([
      [newer.deviceId, "First owner phone", null],
      [older.deviceId, "First owner laptop", null],
    ]);
    // A new device counts as used when it is paired.
    for (const device of body.devices) expect(device.lastUsedAt).toBe(device.createdAt);
  });

  it("revokes an owned device", async () => {
    const by = await owner();
    const kept = await pairDevice(by, "Kept");
    const revoked = await pairDevice(by, "Revoked");
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
    const target = await pairDevice(first);
    await pairDevice(second);
    const responses = await Promise.all([
      ...[second, await owner()].map((by) =>
        manageApi(`/manage/api/devices/${target.deviceId}/revoke`, by.token, "POST"),
      ),
      manageApi(`/manage/api/devices/${crypto.randomUUID()}/revoke`, first.token, "POST"),
      manageApi("/manage/api/devices/not-a-device/revoke", first.token, "POST"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual(
      Array.from({ length: 4 }, () => ({ error: "not_found" })),
    );
    expect((await deviceApi(target.credential)).status).toBe(200);
  });

  it("rejects cross-site and origin-less revocation", async () => {
    const by = await owner();
    const target = await pairDevice(by);
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
    await Promise.all([pairDevice(first), pairDevice(second)]);
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
    const device = await pairDevice(by);
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
    await pairDevice(by);
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
    const device = await pairDevice(by);
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
    await pairDevice(by);
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
    await pairDevice(by);
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

  it("serves the sites list and each site's page", async () => {
    const { token } = await owner();
    const paths = [
      "/manage/sites",
      "/manage/sites/https/bank.example",
      "/manage/sites/http/localhost:8443",
    ];
    const [signedIn, anonymous] = await Promise.all([
      Promise.all(paths.map((path) => request(path, { access: token }))),
      Promise.all(paths.map((path) => request(path))),
    ]);
    expect(signedIn.map((response) => response.status)).toEqual([200, 200, 200]);
    expect(await signedIn[1]!.text()).toContain("Pateat test app");
    expect(anonymous.map((response) => response.status)).toEqual([401, 401, 401]);
    // Only an HTTP(S) origin has a page; the former bindings and recipes pages are gone.
    const missing = [
      "/manage/sites/ftp/bank.example",
      "/manage/sites/https/bank.example/login",
      "/manage/bindings",
      "/manage/recipes",
    ];
    const refused = await Promise.all(missing.map((path) => request(path, { access: token })));
    expect(refused.map((response) => response.status)).toEqual([404, 404, 404, 404]);
    const post = await request("/manage/sites/https/bank.example", {
      access: token,
      method: "POST",
    });
    expect(post.status).toBe(405);
  });
});

describe("owner web UI recipes", () => {
  /** A recipe with a layout (ADR 0060) for each key, created when `created` says. */
  function recipe(
    id: string,
    revision: number,
    origin = "https://bank.example",
    layouts: { key: string; createdAt: number; pageKind?: PageKind }[] = [
      { key: "1000", createdAt: 1000 },
    ],
  ): LoginRecipeDocument {
    return {
      version: 1,
      id,
      revision,
      origin,
      layouts: layouts.map(({ key, createdAt, pageKind = "sign-in" }) => ({
        key,
        createdAt,
        pageKind,
        slots: ["username", "password"],
        steps: [
          {
            kind: "fill",
            effect: "prepare",
            path: "/login",
            fields: [
              { slot: "username", target: { by: "id", value: "username" } },
              { slot: "password", target: { by: "id", value: `password-${key}` } },
            ],
          },
          {
            kind: "click",
            path: "/login",
            target: { by: "id", value: "submit" },
            purpose: "submit",
          },
        ],
        completion: [{ target: { by: "id", value: "welcome" } }],
        maxSubmissions: 1,
      })),
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
  const revokeLayout = (by: Owner, id: string, layout: string, expectedRevision: number) =>
    request(`/manage/api/recipes/${id}/layouts/${layout}/revoke`, {
      method: "POST",
      access: by.token,
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ version: 1, expectedRevision }),
    });
  const list = async (by: Owner) =>
    v.parse(
      manageRecipesSchema,
      await (await request("/manage/api/recipes", { access: by.token })).json(),
    );
  /** Which units of the owner's recipes the service has a record of (ADR 0060). */
  const unitSources = async (ownerId: string) =>
    (
      await env.DB.prepare(
        "SELECT recipe_id, layout, unit FROM recipe_unit_sources WHERE owner_id = ? ORDER BY recipe_id, layout, unit",
      )
        .bind(ownerId)
        .all()
    ).results;

  it("lists only the owner's recipes, most recently changed first, with their documents", async () => {
    const first = await owner();
    const second = await owner();
    const [device, other] = await Promise.all([pairDevice(first), pairDevice(second)]);
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
    expect(await list(by)).toEqual({ version: 1, recipes: [], unreadable: [] });
    expect((await revoke(by, "bank-signin", 1)).status).toBe(404);
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("revokes a recipe as a tombstone devices receive, recorded as written by the web UI", async () => {
    const by = await owner();
    const device = await pairDevice(by);
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
    // A revoked recipe keeps only its tombstone, and no record of its units (ADR 0060).
    expect(rows.results).toEqual([{ revision: 2, state: "revoked", created_by_device_id: null }]);
    expect(await unitSources((await ownerIdFor(by.subject))!)).toEqual([]);
    // A device may still publish an explicit replacement after the tombstone.
    expect((await publish(device.credential, "bank-signin", 2)).status).toBe(200);
  });

  it("lists a recipe whose stored document no longer validates apart, and revokes it", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    expect((await publish(device.credential, "shop-signin", 0)).status).toBe(200);
    const ownerId = await ownerIdFor(by.subject);
    // Stands in for a stored document that a later, stricter contract refuses.
    await env.DB.prepare(
      "UPDATE recipe_revisions SET document = ? WHERE owner_id = ? AND recipe_id = 'bank-signin'",
    )
      .bind(JSON.stringify({ synthetic: "unreadable" }), ownerId)
      .run();
    await env.DB.prepare("UPDATE recipe_heads SET updated_at = 5 WHERE owner_id = ?")
      .bind(ownerId)
      .run();
    const listed = await list(by);
    expect(listed.recipes.map((entry) => entry.change.recipeId)).toEqual(["shop-signin"]);
    expect(listed.unreadable).toEqual([{ recipeId: "bank-signin", revision: 1, updatedAt: 5 }]);
    const response = await revoke(by, "bank-signin", 1);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 1,
      change: { recipeId: "bank-signin", revision: 2, state: "revoked" },
    });
    const after = await list(by);
    expect(after.unreadable).toEqual([]);
    expect(after.recipes.map((entry) => entry.change)).toContainEqual({
      recipeId: "bank-signin",
      revision: 2,
      state: "revoked",
    });
  });

  it("refuses a stale or repeated revocation and returns the current head", async () => {
    const by = await owner();
    const device = await pairDevice(by);
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
    const [device] = await Promise.all([pairDevice(first), pairDevice(second)]);
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

  it("revokes recipes unused for 90 days before listing them (ADR 0058)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    expect((await publish(device.credential, "shop-signin", 0)).status).toBe(200);
    const ownerId = await ownerIdFor(by.subject);
    await env.DB.prepare(
      "UPDATE recipe_heads SET last_used_at = ? WHERE owner_id = ? AND recipe_id = 'bank-signin'",
    )
      .bind(Date.now() - 91 * 24 * 60 * 60 * 1000, ownerId)
      .run();
    const { recipes } = await list(by);
    // The list no longer offers it as active; it shows as the service's tombstone.
    expect(recipes.map((entry) => entry.change)).toEqual([
      { recipeId: "bank-signin", revision: 2, state: "revoked" },
      { recipeId: "shop-signin", revision: 1, state: "active", recipe: recipe("shop-signin", 1) },
    ]);
    const rows = await env.DB.prepare(
      "SELECT revision, state, created_by_device_id FROM recipe_revisions WHERE owner_id = ? AND recipe_id = 'bank-signin'",
    )
      .bind(ownerId)
      .all();
    expect(rows.results).toEqual([{ revision: 2, state: "revoked", created_by_device_id: null }]);
    // Only the recipe still active keeps the record of its units (ADR 0060).
    expect((await unitSources(ownerId!)).map((row) => row["recipe_id"])).toEqual([
      "shop-signin",
      "shop-signin",
    ]);
    expect(await (await deviceApi(device.credential, "/v1/recipes?after=2")).json()).toMatchObject({
      changes: [{ recipeId: "bank-signin", revision: 2, state: "revoked" }],
    });
  });

  it("lists each layout's last use and removes one layout at a time (ADR 0060)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const created = Date.now();
    const two = recipe("bank-signin", 1, "https://bank.example", [
      { key: "1000", createdAt: created },
      { key: "2000", createdAt: created },
    ]);
    const written = await deviceApi(device.credential, "/v1/recipes/bank-signin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, expectedRevision: 0, state: "active", recipe: two }),
    });
    expect(written.status).toBe(200);
    const before = Date.now();
    const used = await deviceApi(device.credential, "/v1/recipes/bank-signin/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, revision: 1, layout: "2000" }),
    });
    expect(used.status).toBe(204);
    // A layout the recipe does not have is no use of one.
    await deviceApi(device.credential, "/v1/recipes/bank-signin/use", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, revision: 1, layout: "3000" }),
    });
    const [listed] = (await list(by)).recipes;
    // A device wrote both layouts, so no model made their first pages (ADR 0060).
    const byDevice = { origin: "device", model: null, createdAt: expect.any(Number) };
    expect(listed!.layouts).toEqual([
      { key: "1000", lastUsedAt: null, firstPage: byDevice },
      { key: "2000", lastUsedAt: expect.any(Number), firstPage: byDevice },
    ]);
    expect(listed!.layouts[1]!.lastUsedAt).toBeGreaterThanOrEqual(before);
    const ownerId = await ownerIdFor(by.subject);
    const lastUsed = async () =>
      (
        await env.DB.prepare(
          "SELECT last_used_at FROM recipe_heads WHERE owner_id = ? AND recipe_id = 'bank-signin'",
        )
          .bind(ownerId)
          .first<{ last_used_at: number }>()
      )?.last_used_at;
    const usedAt = await lastUsed();
    // An unknown or malformed layout, or a stale revision, changes nothing.
    const refused = await Promise.all([
      revokeLayout(by, "bank-signin", "3000", 1),
      revokeLayout(by, "bank-signin", "latest", 1),
      revokeLayout(by, "missing-signin", "1000", 1),
    ]);
    expect(refused.map((response) => response.status)).toEqual([404, 404, 404]);
    const stale = await revokeLayout(by, "bank-signin", "1000", 2);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      error: "recipe_conflict",
      current: { revision: 1 },
    });
    // The next revision keeps the other layout, and removing one is no use of the recipe.
    const removed = await revokeLayout(by, "bank-signin", "1000", 1);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({
      version: 1,
      change: {
        recipeId: "bank-signin",
        revision: 2,
        state: "active",
        recipe: { ...two, revision: 2, layouts: [two.layouts[1]] },
      },
    });
    expect(await lastUsed()).toBe(usedAt);
    expect((await list(by)).recipes[0]!.layouts).toEqual([
      { key: "2000", lastUsedAt: expect.any(Number), firstPage: byDevice },
    ]);
    // The removed layout's units go with it (ADR 0060).
    expect(await unitSources(ownerId!)).toEqual([
      { recipe_id: "bank-signin", layout: "2000", unit: "marker:0" },
      { recipe_id: "bank-signin", layout: "2000", unit: "page:0" },
    ]);
    // Removing the last layout revokes the recipe, and its layouts' uses go with it.
    const last = await revokeLayout(by, "bank-signin", "2000", 2);
    expect(await last.json()).toEqual({
      version: 1,
      change: { recipeId: "bank-signin", revision: 3, state: "revoked" },
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM recipe_layout_uses WHERE owner_id = ?")
        .bind(ownerId)
        .first("n"),
    ).toBe(0);
    expect(await unitSources(ownerId!)).toEqual([]);
  });

  it("removes a layout unused for 90 days while another is used (ADR 0060)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const now = Date.now();
    const old = now - 91 * 24 * 60 * 60 * 1000;
    const layouts = [
      { key: "1000", createdAt: old },
      { key: "2000", createdAt: old },
      { key: "3000", createdAt: now },
    ];
    const stored = recipe("bank-signin", 1, "https://bank.example", layouts);
    const written = await deviceApi(device.credential, "/v1/recipes/bank-signin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, expectedRevision: 0, state: "active", recipe: stored }),
    });
    expect(written.status).toBe(200);
    // The second old layout ran a login this week.
    const record = await deviceApi(device.credential, "/v1/recipes/bank-signin/logins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        revision: 1,
        branch: "2000",
        outcome: "authenticated",
        extensionBuild: "development",
        totalMs: 4000,
        serviceMs: 0,
        networkMs: 0,
        personMs: 0,
        pageMs: 0,
      }),
    });
    expect(record.status).toBe(204);
    const { recipes } = await list(by);
    expect(recipes.map((entry) => entry.change)).toEqual([
      {
        recipeId: "bank-signin",
        revision: 2,
        state: "active",
        recipe: { ...stored, revision: 2, layouts: stored.layouts.slice(1) },
      },
    ]);
    const rows = await env.DB.prepare(
      "SELECT revision, created_by_device_id FROM recipe_revisions WHERE owner_id = ? AND revision = 2",
    )
      .bind(await ownerIdFor(by.subject))
      .all();
    expect(rows.results).toEqual([{ revision: 2, created_by_device_id: null }]);
    // The removed layout's units go with it (ADR 0060).
    expect([
      ...new Set((await unitSources((await ownerIdFor(by.subject))!)).map((row) => row["layout"])),
    ]).toEqual(["2000", "3000"]);
  });

  it("keeps the idle layouts of a recipe generated as a verification, which never runs (ADR 0035, ADR 0060)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const now = Date.now();
    const old = now - 91 * 24 * 60 * 60 * 1000;
    const put = (layouts: { key: string; createdAt: number; pageKind?: PageKind }[]) =>
      deviceApi(device.credential, "/v1/recipes/bank-signin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          expectedRevision: 0,
          state: "active",
          recipe: recipe("bank-signin", 1, "https://bank.example", layouts),
        }),
      });
    // Every layout of a recipe has its start page's kind, so a document mixing them is
    // refused.
    expect(
      (
        await put([
          { key: "1000", createdAt: old, pageKind: "confirm" },
          { key: "2000", createdAt: now },
        ])
      ).status,
    ).toBe(400);
    const layouts = [
      { key: "1000", createdAt: old, pageKind: "confirm" as const },
      { key: "2000", createdAt: now, pageKind: "confirm" as const },
    ];
    expect((await put(layouts)).status).toBe(200);
    // No layout goes, and the recipe itself is never revoked as idle.
    const { recipes } = await list(by);
    expect(recipes.map((entry) => entry.change)).toEqual([
      {
        recipeId: "bank-signin",
        revision: 1,
        state: "active",
        recipe: recipe("bank-signin", 1, "https://bank.example", layouts),
      },
    ]);
  });

  it("keeps an idle layout whose use arrives while it is removed (ADR 0060)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const now = Date.now();
    const unusedBefore = now - 90 * 24 * 60 * 60 * 1000;
    const layouts = [
      { key: "1000", createdAt: unusedBefore - 1000 },
      { key: "2000", createdAt: now },
    ];
    const stored = recipe("bank-signin", 1, "https://bank.example", layouts);
    const written = await deviceApi(device.credential, "/v1/recipes/bank-signin", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, expectedRevision: 0, state: "active", recipe: stored }),
    });
    expect(written.status).toBe(200);
    const ownerId = (await ownerIdFor(by.subject))!;
    // The idle check read no use of layout 1000; a login reports one before it writes.
    await env.DB.prepare(
      "INSERT INTO recipe_layout_uses (owner_id, recipe_id, layout, last_used_at) VALUES (?, 'bank-signin', '1000', ?)",
    )
      .bind(ownerId, now)
      .run();
    const removal = (keys: string[]) =>
      writeRecipe(
        env.DB,
        ownerId,
        "bank-signin",
        {
          version: 1,
          expectedRevision: 1,
          state: "active",
          recipe: { ...stored, revision: 2, layouts: stored.layouts.slice(1) },
        },
        null,
        { used: false, idleLayouts: { keys, before: unusedBefore } },
      );
    expect(await removal(["1000"])).toMatchObject({ ok: false, limited: false });
    const uses = () =>
      env.DB.prepare("SELECT layout FROM recipe_layout_uses WHERE owner_id = ?")
        .bind(ownerId)
        .all()
        .then(({ results }) => results);
    expect(await uses()).toEqual([{ layout: "1000" }]);
    // The refused removal keeps the layout's units, which the same batch would drop.
    const layoutsWithUnits = async () => [
      ...new Set((await unitSources(ownerId)).map((row) => row["layout"])),
    ];
    expect(await layoutsWithUnits()).toEqual(["1000", "2000"]);
    // Once that use is old again, the removal wins and the use row goes with the layout.
    await env.DB.prepare("UPDATE recipe_layout_uses SET last_used_at = ? WHERE owner_id = ?")
      .bind(unusedBefore - 1, ownerId)
      .run();
    expect(await removal(["1000"])).toMatchObject({ ok: true, change: { revision: 2 } });
    expect(await uses()).toEqual([]);
    expect(await layoutsWithUnits()).toEqual(["2000"]);
  });

  it("lists the model and time of each layout's first page that the service generated (ADR 0060)", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    expect((await publish(device.credential, "bank-signin", 0)).status).toBe(200);
    // Stands in for the row a generated first page leaves.
    await env.DB.prepare(
      "UPDATE recipe_unit_sources SET origin = 'generated', provider = 'anthropic', model = 'claude-synthetic', created_at = 1234 WHERE owner_id = ? AND unit = 'page:0'",
    )
      .bind(await ownerIdFor(by.subject))
      .run();
    expect((await list(by)).recipes[0]!.layouts).toEqual([
      {
        key: "1000",
        lastUsedAt: null,
        firstPage: { origin: "generated", model: "claude-synthetic", createdAt: 1234 },
      },
    ]);
  });

  it("refuses other methods on the recipes API", async () => {
    const { token } = await owner();
    expect((await manageApi("/manage/api/recipes", token, "PUT")).status).toBe(405);
  });
});

// ADR 0012: the owner deletes their whole request log from the web UI (owner, 2026-10-18).
describe("owner web UI request log", () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  /** Writes a synthetic request log row, judgement or spend row for an owner. */
  const insertLog = (ownerId: string, createdAt: number) =>
    env.DB.prepare(
      "INSERT INTO inference_log (id, owner_id, role, provider, model_id, origin, path, request, outcome, recipe_id, cost_micro_usd, created_at) VALUES (?, ?, 'generate', 'anthropic', 'm', 'https://bank.example', '/login', '{}', 'ok', 'gen-synthetic', 0, ?)",
    ).bind(`log-${crypto.randomUUID()}`, ownerId, createdAt);
  /** A synthetic login result code a device sent (ADR 0019, amended 2026-10-18). */
  const insertOutcome = (ownerId: string, revision: number, createdAt: number) =>
    env.DB.prepare(
      "INSERT INTO login_outcomes (owner_id, recipe_id, branch, revision, outcome, cause, step, created_at) VALUES (?, 'gen-synthetic', '', ?, 'unknown-submit', 'settled', 1, ?)",
    ).bind(ownerId, revision, createdAt);
  /** A synthetic login record a device sent (ADR 0055). */
  const insertLogin = (ownerId: string, createdAt: number) =>
    env.DB.prepare(
      "INSERT INTO login_timings (id, owner_id, recipe_id, branch, revision, origin, outcome, extension_build, total_ms, service_ms, network_ms, person_ms, page_ms, created_at) VALUES (?, ?, 'gen-synthetic', '', 1, 'https://bank.example', 'authenticated', 'development', 4000, 0, 0, 0, 0, ?)",
    ).bind(`login-${crypto.randomUUID()}`, ownerId, createdAt);
  /** A synthetic problem line a device sent (ADR 0066). */
  const insertProblem = (ownerId: string, deviceId: string, seq: number, createdAt: number) =>
    env.DB.prepare(
      "INSERT INTO problem_log (owner_id, device_id, log_id, seq, extension_build, level, event, fields, logged_at, created_at) VALUES (?, ?, '0000000000000000000000000000000a', ?, 'development', 'warn', 'login.attempt', '{\"outcome\":\"target-missing\"}', ?, ?)",
    ).bind(ownerId, deviceId, seq, createdAt, createdAt);
  const loginCount = async (ownerId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM login_timings WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ n: number }>())!.n;
  const problemCount = async (ownerId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM problem_log WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ n: number }>())!.n;
  const outcomeCount = async (ownerId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM login_outcomes WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ n: number }>())!.n;
  const logCount = async (ownerId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM inference_log WHERE owner_id = ?")
      .bind(ownerId)
      .first<{ n: number }>())!.n;
  const read = async (by: Owner) => {
    const response = await request("/manage/api/request-log", { access: by.token });
    expect(response.status).toBe(200);
    return v.parse(manageRequestLogSchema, await response.json());
  };

  it("serves its page", async () => {
    const { token } = await owner();
    const page = await request("/manage/request-log", { access: token });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Pateat test app");
    expect((await request("/manage/request-log")).status).toBe(401);
    expect((await request("/manage/request-log", { access: token, method: "POST" })).status).toBe(
      405,
    );
  });

  it("counts and deletes only the signed-in owner's rows and codes, keeping recipes, settings and spend", async () => {
    const first = await owner();
    const second = await owner();
    const devicesOf = await Promise.all([pairDevice(first), pairDevice(second)]);
    const [mine, theirs] = await Promise.all([
      ownerIdFor(first.subject),
      ownerIdFor(second.subject),
    ]);
    // Each owner holds a recipe its device wrote, with a record of its units (ADR 0060).
    for (const { credential } of devicesOf) {
      // oxlint-disable-next-line no-await-in-loop -- One recipe per owner.
      const written = await deviceApi(credential, "/v1/recipes/bank-signin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          version: 1,
          expectedRevision: 0,
          state: "active",
          recipe: {
            version: 1,
            id: "bank-signin",
            revision: 1,
            origin: "https://bank.example",
            entry: { path: "/", target: { by: "text", value: "Log in" } },
          },
        }),
      });
      expect(written.status).toBe(200);
    }
    /** The owner's unit rows: which device and log row each names. */
    const units = async (ownerId: string) =>
      (
        await env.DB.prepare(
          "SELECT unit, origin, device_id, log_id FROM recipe_unit_sources WHERE owner_id = ?",
        )
          .bind(ownerId)
          .all()
      ).results;
    const [myDevice, theirDevice] = devicesOf.map(({ deviceId }) => deviceId);
    // Stands in for the log row a generated unit names.
    await env.DB.prepare("UPDATE recipe_unit_sources SET log_id = 'log-1'").run();
    expect(await units(mine!)).toEqual([
      { unit: "entry", origin: "device", device_id: myDevice, log_id: "log-1" },
    ]);
    const oldest = Date.now() - 40 * DAY_MS;
    await env.DB.batch([
      insertLog(mine!, Date.now() - 30 * DAY_MS),
      insertLog(mine!, Date.now()),
      insertLog(theirs!, Date.now() - 60 * DAY_MS),
      // The oldest row may be a login result code.
      insertOutcome(mine!, 1, oldest),
      insertOutcome(theirs!, 1, Date.now()),
      insertLogin(mine!, Date.now() - DAY_MS),
      insertLogin(mine!, Date.now()),
      insertLogin(mine!, Date.now()),
      insertLogin(theirs!, Date.now()),
      insertProblem(mine!, myDevice!, 1, Date.now()),
      insertProblem(mine!, myDevice!, 2, Date.now()),
      insertProblem(theirs!, theirDevice!, 1, Date.now()),
      env.DB.prepare(
        "INSERT INTO inference_spend (owner_id, period, calls, cost_micro_usd) VALUES (?, '2026-10', 2, 900)",
      ).bind(mine),
      env.DB.prepare(
        "INSERT INTO page_judgements (owner_id, recipe_id, branch, revision, origin, path, prompt_version, judged_at, verdict) VALUES (?, 'gen-synthetic', '', 1, 'https://bank.example', '/home', 'v', ?, 'signed-in')",
      ).bind(mine, Date.now()),
    ]);
    const settings = await request("/manage/api/settings", {
      method: "PUT",
      access: first.token,
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({
        version: 1,
        expectedRevision: 0,
        settings: { connections: [], excludedSites: [], siteDefaults: [], bindings: [] },
      }),
    });
    expect(settings.status).toBe(200);
    expect(await read(first)).toEqual({
      version: 1,
      entries: 2,
      outcomes: 1,
      logins: 3,
      problems: 2,
      oldestAt: oldest,
    });

    const deleted = await manageApi("/manage/api/request-log", first.token, "DELETE");
    expect(deleted.status).toBe(200);
    expect(v.parse(manageRequestLogDeletedSchema, await deleted.json())).toEqual({
      version: 1,
      deleted: 2,
      outcomes: 1,
      logins: 3,
      problems: 2,
    });
    expect(await read(first)).toEqual({
      version: 1,
      entries: 0,
      outcomes: 0,
      logins: 0,
      problems: 0,
      oldestAt: null,
    });
    expect(await logCount(theirs!)).toBe(1);
    expect(await outcomeCount(theirs!)).toBe(1);
    expect(await loginCount(theirs!)).toBe(1);
    expect(await problemCount(theirs!)).toBe(1);
    // The record of which call made each part of a recipe stays without the device and the
    // log row it named (ADR 0060).
    expect(await units(mine!)).toEqual([
      { unit: "entry", origin: "device", device_id: null, log_id: null },
    ]);
    expect(await units(theirs!)).toEqual([
      { unit: "entry", origin: "device", device_id: theirDevice, log_id: "log-1" },
    ]);
    // Only the log goes: the spend the limits count, judged pages, settings and recipes stay.
    const kept = await env.DB.batch([
      env.DB.prepare("SELECT calls FROM inference_spend WHERE owner_id = ?").bind(mine),
      env.DB.prepare("SELECT verdict FROM page_judgements WHERE owner_id = ?").bind(mine),
      env.DB.prepare("SELECT revision FROM settings WHERE owner_id = ?").bind(mine),
      env.DB.prepare("SELECT state FROM recipe_heads WHERE owner_id = ?").bind(mine),
    ]);
    expect(kept.map((result) => result.results)).toEqual([
      [{ calls: 2 }],
      [{ verdict: "signed-in" }],
      [{ revision: 1 }],
      [{ state: "active" }],
    ]);
    // Deleting an empty log is harmless.
    expect(
      await (await manageApi("/manage/api/request-log", first.token, "DELETE")).json(),
    ).toEqual({ version: 1, deleted: 0, outcomes: 0, logins: 0, problems: 0 });
  });

  it("shows an identity without a paired device an empty log and creates no owner", async () => {
    const by = await owner();
    expect(await read(by)).toEqual({
      version: 1,
      entries: 0,
      outcomes: 0,
      logins: 0,
      problems: 0,
      oldestAt: null,
    });
    const deleted = await manageApi("/manage/api/request-log", by.token, "DELETE");
    expect(await deleted.json()).toEqual({
      version: 1,
      deleted: 0,
      outcomes: 0,
      logins: 0,
      problems: 0,
    });
    const problems = await request("/manage/api/problems", { access: by.token });
    expect(await problems.json()).toEqual({ version: 1, problems: [] });
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("lists only the signed-in owner's newest problem lines with each device's label (ADR 0066)", async () => {
    const first = await owner();
    const second = await owner();
    const [laptop, theirDevice] = await Promise.all([
      pairDevice(first, "Laptop"),
      pairDevice(second),
    ]);
    const desktop = await pairDevice(first, "Desktop");
    const [mine, theirs] = await Promise.all([
      ownerIdFor(first.subject),
      ownerIdFor(second.subject),
    ]);
    const now = Date.now();
    await env.DB.batch([
      insertProblem(mine!, laptop.deviceId, 7, now - DAY_MS),
      insertProblem(mine!, desktop.deviceId, 3, now),
      insertProblem(theirs!, theirDevice.deviceId, 1, now),
      // A stored line that no longer passes the contract is left out.
      env.DB.prepare(
        "INSERT INTO problem_log (owner_id, device_id, log_id, seq, extension_build, level, event, fields, logged_at, created_at) VALUES (?, ?, '0000000000000000000000000000000a', 8, 'development', 'warn', 'login.attempt', 'not json', ?, ?)",
      ).bind(mine, laptop.deviceId, now, now),
    ]);
    const response = await request("/manage/api/problems", { access: first.token });
    expect(response.status).toBe(200);
    expect(v.parse(manageProblemsSchema, await response.json())).toEqual({
      version: 1,
      problems: [
        {
          device: "Desktop",
          extensionBuild: "development",
          level: "warn",
          event: "login.attempt",
          fields: { outcome: "target-missing" },
          loggedAt: now,
          receivedAt: now,
        },
        {
          device: "Laptop",
          extensionBuild: "development",
          level: "warn",
          event: "login.attempt",
          fields: { outcome: "target-missing" },
          loggedAt: now - DAY_MS,
          receivedAt: now - DAY_MS,
        },
      ],
    });
    expect((await request("/manage/api/problems")).status).toBe(401);
    expect((await manageApi("/manage/api/problems", first.token, "DELETE")).status).toBe(405);
  });

  it("refuses deletion without Access, from another origin or without one", async () => {
    const by = await owner();
    const device = await pairDevice(by);
    const ownerId = await ownerIdFor(by.subject);
    await env.DB.batch([
      insertLog(ownerId!, Date.now()),
      insertOutcome(ownerId!, 1, Date.now()),
      insertLogin(ownerId!, Date.now()),
      insertProblem(ownerId!, device.deviceId, 1, Date.now()),
    ]);
    const forged = await forgedAccess(claims(newSubject()));
    const responses = await Promise.all([
      manageApi("/manage/api/request-log", undefined, "DELETE"),
      manageApi("/manage/api/request-log", forged, "DELETE"),
      manageApi("/manage/api/request-log", by.token, "DELETE", "https://attacker.example"),
      manageApi("/manage/api/request-log", by.token, "DELETE", null),
      manageApi("/manage/api/request-log", by.token, "POST"),
    ]);
    expect(responses.map((response) => response.status)).toEqual([401, 403, 403, 403, 405]);
    expect(await logCount(ownerId!)).toBe(1);
    expect(await outcomeCount(ownerId!)).toBe(1);
    expect(await loginCount(ownerId!)).toBe(1);
    expect(await problemCount(ownerId!)).toBe(1);
    expect((await request("/manage/api/request-log")).status).toBe(401);
  });
});

describe("device self-revocation", () => {
  it("revokes only the calling device", async () => {
    const by = await owner();
    const leaving = await pairDevice(by);
    const staying = await pairDevice(by);
    const response = await deviceApi(leaving.credential, "/v1/device", { method: "DELETE" });
    expect(response.status).toBe(204);
    expect(await (await deviceApi(leaving.credential)).json()).toEqual({
      error: "device_revoked",
    });
    expect((await deviceApi(staying.credential)).status).toBe(200);
    expect((await deviceApi(leaving.credential, "/v1/device", { method: "DELETE" })).status).toBe(
      401,
    );
    expect((await request("/v1/device", { method: "DELETE" })).status).toBe(401);
    expect((await deviceApi(staying.credential, "/v1/device", { method: "PUT" })).status).toBe(405);
  });
});
