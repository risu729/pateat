import {
  createDefaultSettings,
  devicePairResultSchema,
  syncSettingsStateSchema,
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
  ORIGIN,
  owner,
  request,
  type Owner,
} from "./access-helpers";
import { withLimiter } from "./limiter";

installAccessKeys();

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const UNKNOWN_PROFILE = "00000000-0000-4000-8000-0000000000ff";
const settingsDocument = () => ({ ...createDefaultSettings(), connections: [] });
const mounts = [
  {
    name: "extension",
    path: "/extension/profiles",
    origin: EXTENSION_ORIGIN,
    missing: "not_found",
    forbidden: "extension_not_allowed",
  },
  {
    name: "management",
    path: "/manage/api/profiles",
    origin: ORIGIN,
    missing: "not_paired",
    forbidden: "forbidden",
  },
] as const;
type Mount = (typeof mounts)[number];

function editor(mount: Mount, by: Owner, path = "", init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Origin")) headers.set("Origin", mount.origin);
  return request(`${mount.path}${path}`, { ...init, access: by.token, headers });
}
function write(expectedRevision: number, settings = settingsDocument()): RequestInit {
  return {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, expectedRevision, settings }),
  };
}
async function expectError(response: Response, status: number, error: string) {
  expect(response.status).toBe(status);
  expect(await response.json()).toEqual({ error });
  expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
}
async function paired() {
  const by = await owner();
  const response = await request("/pair", {
    access: by.token,
    method: "POST",
    headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, label: "Synthetic profile editor" }),
  });
  expect(response.status).toBe(201);
  const device = v.parse(devicePairResultSchema, await response.json());
  const state = v.parse(syncSettingsStateSchema, await (await deviceApi(device.credential)).json());
  const initialized = await deviceApi(device.credential, "/v1/settings", write(state.revision));
  expect(initialized.status).toBe(200);
  return { by, device, state: v.parse(syncSettingsStateSchema, await initialized.json()) };
}
async function copyProfile(by: Owner, profileId: string) {
  const response = await request("/manage/api/profiles", {
    access: by.token,
    method: "POST",
    headers: { Origin: ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, name: "Copied profile", copyFrom: profileId }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string };
}

describe.each(mounts)("$name profile editor route parity", (mount) => {
  it("lists no profiles for an unpaired identity and preserves its settings-specific missing-owner code", async () => {
    const by = await owner();
    const listed = await editor(mount, by);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ version: 1, profiles: [] });
    const path = `/${UNKNOWN_PROFILE}/settings`;
    await expectError(await editor(mount, by, path), 404, mount.missing);
    await expectError(await editor(mount, by, path, write(0)), 404, mount.missing);
  });

  it("validates profile syntax before media type, then JSON before owner lookup", async () => {
    const by = await owner();
    const invalid = await editor(mount, by, "/not-a-profile/settings", {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: "{",
    });
    await expectError(invalid, 404, "not_found");
    const path = `/${UNKNOWN_PROFILE}/settings`;
    await expectError(
      await editor(mount, by, path, {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: "{",
      }),
      415,
      "unsupported_media_type",
    );
    await expectError(
      await editor(mount, by, path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      400,
      "bad_request",
    );
    await expectError(
      await editor(mount, by, path, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, expectedRevision: -1, settings: settingsDocument() }),
      }),
      400,
      "bad_request",
    );
    await expectError(await editor(mount, by, path, write(0)), 404, mount.missing);
  });

  it("reads and writes another owned profile without reassigning the device, and rejects stale revisions atomically", async () => {
    const { by, device, state } = await paired();
    const copied = await copyProfile(by, state.profileId);
    const path = `/${copied.id}/settings`;
    const beforeResponse = await editor(mount, by, path);
    expect(beforeResponse.status).toBe(200);
    const before = v.parse(syncSettingsStateSchema, await beforeResponse.json());
    const policy = {
      ...settingsDocument(),
      excludedSites: [{ hostname: "edited.example", includeSubdomains: false }],
      language: "ja" as const,
    };
    const savedResponse = await editor(mount, by, path, write(before.revision, policy));
    expect(savedResponse.status).toBe(200);
    const saved = v.parse(syncSettingsStateSchema, await savedResponse.json());
    expect(saved.profileId).toBe(copied.id);
    expect(saved.revision).toBeGreaterThan(before.revision);
    expect(saved.settings).toMatchObject(policy);
    const otherMount = mounts.find((candidate) => candidate.name !== mount.name)!;
    expect(await (await editor(otherMount, by, path)).json()).toEqual(saved);

    const stale = await editor(mount, by, path, write(before.revision));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "settings_conflict", current: saved });
    expect(await (await editor(mount, by, path)).json()).toEqual(saved);
    const deviceAfter = v.parse(
      syncSettingsStateSchema,
      await (await deviceApi(device.credential)).json(),
    );
    expect(deviceAfter.profileId).toBe(state.profileId);
    expect(deviceAfter.settings?.excludedSites).toEqual(state.settings?.excludedSites);
    expect(
      await env.DB.prepare("SELECT profile_id FROM devices WHERE id = ?")
        .bind(device.deviceId)
        .first(),
    ).toEqual({ profile_id: state.profileId });
  });

  it("hides foreign, missing and deleted profiles on both reads and writes without changing owned settings", async () => {
    const alice = await paired();
    const bob = await paired();
    const copied = await copyProfile(alice.by, alice.state.profileId);
    const removed = await request(`/manage/api/profiles/${copied.id}`, {
      access: alice.by.token,
      method: "DELETE",
      headers: { Origin: ORIGIN },
    });
    expect(removed.status).toBe(204);
    const aliceBefore = await (await deviceApi(alice.device.credential)).json();
    const bobBefore = await (await deviceApi(bob.device.credential)).json();
    await Promise.all(
      [alice.state.profileId, copied.id, UNKNOWN_PROFILE].map(async (id) => {
        const by = id === copied.id ? alice.by : bob.by;
        const path = `/${id}/settings`;
        await expectError(await editor(mount, by, path), 404, "not_found");
        await expectError(await editor(mount, by, path, write(0)), 404, "not_found");
      }),
    );
    const listed = await editor(mount, bob.by);
    expect(await listed.json()).toEqual({
      version: 1,
      profiles: [{ id: bob.state.profileId, name: "Default" }],
    });
    expect(await (await deviceApi(alice.device.credential)).json()).toEqual(aliceBefore);
    expect(await (await deviceApi(bob.device.credential)).json()).toEqual(bobBefore);
  });

  it("keeps Access and origin guards ahead of malformed body and profile validation", async () => {
    const by = await owner();
    const path = `${mount.path}/not-a-profile/settings`;
    const malformed = {
      method: "PUT",
      headers: { Origin: "https://attacker.example", "Content-Type": "text/plain" },
      body: "{",
    };
    await expectError(await request(path, malformed), 401, "unauthorized");
    const forged = await forgedAccess(claims(by.subject));
    await expectError(await request(path, { ...malformed, access: forged }), 403, "forbidden");
    await expectError(
      await request(path, { ...malformed, access: by.token }),
      403,
      mount.forbidden,
    );
    await expectError(
      await editor(mount, by, "/not-a-profile/settings", malformed),
      403,
      mount.forbidden,
    );
    const { device } = await paired();
    await expectError(await deviceApi(device.credential, path, malformed), 401, "unauthorized");
  });

  it("keeps identity limiting and body size ahead of route-level validation", async () => {
    const by = await owner();
    const path = `${mount.path}/not-a-profile/settings`;
    const headers = {
      Origin: mount.origin,
      "Content-Type": "application/json",
      "Cf-Access-Jwt-Assertion": by.token,
    };
    const limited = await app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: "PUT",
        headers,
        body: "{",
      }),
      withLimiter("OWNER_LIMITER", 0),
    );
    expect(limited.headers.get("Retry-After")).toBe("60");
    await expectError(limited, 429, "rate_limited");
    await expectError(
      await request(path, {
        access: by.token,
        method: "PUT",
        headers,
        body: "x".repeat(128 * 1024 + 1),
      }),
      413,
      "payload_too_large",
    );
  });

  it("preserves explicit unsupported-method responses after the mount middleware", async () => {
    const by = await owner();
    const path = `/${UNKNOWN_PROFILE}/settings`;
    await Promise.all(
      ["POST", "PATCH", "DELETE"].map(async (method) => {
        const response = await editor(mount, by, path, { method });
        expect(response.headers.get("Allow")).toBe("GET, PUT");
        await expectError(response, 405, "method_not_allowed");
      }),
    );
    const list = await editor(mount, by, "", { method: "PATCH" });
    expect(list.headers.get("Allow")).toBe(mount.name === "management" ? "GET, POST" : "GET");
    await expectError(list, 405, "method_not_allowed");
    const denied = await request(`${mount.path}${path}`, {
      access: by.token,
      method: "POST",
      headers: { Origin: "https://attacker.example" },
    });
    await expectError(denied, 403, mount.forbidden);
  });
});

describe("the shared editor retains each mount's surrounding routes and origin policy", () => {
  it("leaves management profile create, rename and delete available without adding extension CRUD", async () => {
    const { by, state } = await paired();
    const copied = await copyProfile(by, state.profileId);
    const renamed = await request(`/manage/api/profiles/${copied.id}`, {
      access: by.token,
      method: "PATCH",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, name: "Renamed profile" }),
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ id: copied.id, name: "Renamed profile" });
    const managementList = await (await editor(mounts[1], by)).json();
    expect(await (await editor(mounts[0], by)).json()).toEqual(managementList);
    expect(managementList).toMatchObject({
      profiles: expect.arrayContaining([{ id: copied.id, name: "Renamed profile" }]),
    });
    const deniedCreate = await editor(mounts[0], by, "", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1, name: "Not created", copyFrom: copied.id }),
    });
    await expectError(deniedCreate, 405, "method_not_allowed");
    const removed = await request(`/manage/api/profiles/${copied.id}`, {
      access: by.token,
      method: "DELETE",
      headers: { Origin: ORIGIN },
    });
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe("");
    expect(await (await editor(mounts[1], by)).json()).toEqual({
      version: 1,
      profiles: [{ id: state.profileId, name: "Default" }],
    });
  });

  it("keeps no-Origin extension GET metadata limited to reads, and fails closed for an invalid allowlist", async () => {
    const by = await owner();
    const metadata = { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "cors" };
    const read = await request(mounts[0].path, { access: by.token, headers: metadata });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ version: 1, profiles: [] });
    await expectError(
      await request(`${mounts[0].path}/${UNKNOWN_PROFILE}/settings`, {
        access: by.token,
        ...write(0),
        headers: { ...metadata, "Content-Type": "application/json" },
      }),
      403,
      "extension_not_allowed",
    );
    await expectError(
      await request(mounts[0].path, {
        access: by.token,
        headers: { ...metadata, Origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      }),
      403,
      "extension_not_allowed",
    );
    const headers = { Origin: EXTENSION_ORIGIN, "Cf-Access-Jwt-Assertion": by.token };
    await expectError(
      await app.fetch(new Request(`${ORIGIN}${mounts[0].path}`, { headers }), {
        ...env,
        PAIRING_EXTENSION_IDS: [],
      }),
      503,
      "pairing_unavailable",
    );
    // Management does not acquire the extension allowlist guard when reusing the editor.
    const management = await app.fetch(
      new Request(`${ORIGIN}${mounts[1].path}`, {
        headers: { "Cf-Access-Jwt-Assertion": by.token },
      }),
      { ...env, PAIRING_EXTENSION_IDS: [] },
    );
    expect(management.status).toBe(200);
    expect(await management.json()).toEqual({ version: 1, profiles: [] });
    await expectError(
      await request(`${mounts[1].path}/${UNKNOWN_PROFILE}/settings`, {
        access: by.token,
        ...write(0),
        headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
      }),
      403,
      "forbidden",
    );
  });
});
