import {
  devicePairResultSchema,
  manageDevicesSchema,
  manageRecipesSchema,
  manageRequestLogDeletedSchema,
  manageRequestLogSchema,
  type DevicePairResult,
  type LoginRecipe,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { app } from "../src/app";
import {
  claims,
  deviceApi,
  forgedAccess,
  installAccessKeys,
  jwks,
  newSubject,
  ORIGIN,
  owner,
  ownerIdFor,
  pairOwner,
  rejectedTokens,
  request,
  type Owner,
} from "./access-helpers";
import { awaitRoomInMinute } from "./limiter";

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
    const claudeForm = await request("/manage/claude", {
      method: "POST",
      access: viaPair.token,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: ORIGIN },
      body: new URLSearchParams({ action: "save" }),
    });
    expect(claudeForm.status).toBe(403);
    // Refused by Access, not by the form's own origin or body checks.
    const claudeFormBody = await claudeForm.text();
    expect(claudeFormBody).toContain("Access denied");
    expect(claudeFormBody).toContain("Your sign-in could not be verified.");

    const apiResponses = await Promise.all([
      manageApi("/manage/api/devices", viaPair.token, "GET"),
      manageApi("/manage/api/settings", viaPair.token, "GET"),
      manageApi("/manage/api/recipes", viaPair.token, "GET"),
      manageApi("/manage/api/dashboard", viaPair.token, "GET"),
      manageApi(`/manage/api/devices/${device.deviceId}/revoke`, viaPair.token, "POST"),
    ]);
    expect(apiResponses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
    expect(await Promise.all(apiResponses.map((response) => response.json()))).toEqual(
      apiResponses.map(() => ({ error: "forbidden" })),
    );

    // The device was not revoked, and the host-wide application still reaches the owner.
    expect((await deviceApi(device.credential)).status).toBe(200);
    const viaHost = await owner(viaPair.subject);
    expect((await request("/manage", { access: viaHost.token })).status).toBe(200);
    const listed = v.parse(
      manageDevicesSchema,
      await (await manageApi("/manage/api/devices", viaHost.token, "GET")).json(),
    );
    expect(listed.devices.map((entry) => entry.id)).toEqual([device.deviceId]);
  });

  it("fails closed when the signing keys cannot be fetched", async () => {
    jwks.available = false;
    try {
      const response = await request("/manage", { access: (await owner()).token });
      expect(response.status).toBe(403);
    } finally {
      jwks.available = true;
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
      completion: [{ target: { by: "id", value: "welcome" } }],
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
    // A revoked recipe keeps only its tombstone.
    expect(rows.results).toEqual([{ revision: 2, state: "revoked", created_by_device_id: null }]);
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
    expect(await (await deviceApi(device.credential, "/v1/recipes?after=2")).json()).toMatchObject({
      changes: [{ recipeId: "bank-signin", revision: 2, state: "revoked" }],
    });
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
  const loginCount = async (ownerId: string) =>
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM login_timings WHERE owner_id = ?")
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
    await Promise.all([pairDevice(first), pairDevice(second)]);
    const [mine, theirs] = await Promise.all([
      ownerIdFor(first.subject),
      ownerIdFor(second.subject),
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
      oldestAt: oldest,
    });

    const deleted = await manageApi("/manage/api/request-log", first.token, "DELETE");
    expect(deleted.status).toBe(200);
    expect(v.parse(manageRequestLogDeletedSchema, await deleted.json())).toEqual({
      version: 1,
      deleted: 2,
      outcomes: 1,
      logins: 3,
    });
    expect(await read(first)).toEqual({
      version: 1,
      entries: 0,
      outcomes: 0,
      logins: 0,
      oldestAt: null,
    });
    expect(await logCount(theirs!)).toBe(1);
    expect(await outcomeCount(theirs!)).toBe(1);
    expect(await loginCount(theirs!)).toBe(1);
    // Only the log goes: the spend the limits count, judged pages and settings stay.
    const kept = await env.DB.batch([
      env.DB.prepare("SELECT calls FROM inference_spend WHERE owner_id = ?").bind(mine),
      env.DB.prepare("SELECT verdict FROM page_judgements WHERE owner_id = ?").bind(mine),
      env.DB.prepare("SELECT revision FROM settings WHERE owner_id = ?").bind(mine),
    ]);
    expect(kept.map((result) => result.results)).toEqual([
      [{ calls: 2 }],
      [{ verdict: "signed-in" }],
      [{ revision: 1 }],
    ]);
    // Deleting an empty log is harmless.
    expect(
      await (await manageApi("/manage/api/request-log", first.token, "DELETE")).json(),
    ).toEqual({ version: 1, deleted: 0, outcomes: 0, logins: 0 });
  });

  it("shows an identity without a paired device an empty log and creates no owner", async () => {
    const by = await owner();
    expect(await read(by)).toEqual({
      version: 1,
      entries: 0,
      outcomes: 0,
      logins: 0,
      oldestAt: null,
    });
    const deleted = await manageApi("/manage/api/request-log", by.token, "DELETE");
    expect(await deleted.json()).toEqual({ version: 1, deleted: 0, outcomes: 0, logins: 0 });
    expect(await ownerIdFor(by.subject)).toBeNull();
  });

  it("refuses deletion without Access, from another origin or without one", async () => {
    const by = await owner();
    await pairDevice(by);
    const ownerId = await ownerIdFor(by.subject);
    await env.DB.batch([
      insertLog(ownerId!, Date.now()),
      insertOutcome(ownerId!, 1, Date.now()),
      insertLogin(ownerId!, Date.now()),
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
