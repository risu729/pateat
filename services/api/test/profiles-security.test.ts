import {
  createDefaultSettings,
  devicePairResultSchema,
  syncSettingsStateSchema,
  type LocalSettings,
} from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { deviceApi, installAccessKeys, owner, ORIGIN, request, type Owner } from "./access-helpers";

// Synthetic Access identities and vault references only. Every test pairs a new owner.
installAccessKeys();

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const USER = "00000000-0000-4000-8000-000000000001";

function manage(by: Owner, path: string, body?: unknown, method = "POST") {
  return request(`/manage/api${path}`, {
    access: by.token,
    ...(body === undefined
      ? {}
      : {
          method,
          headers: { "Content-Type": "application/json", Origin: ORIGIN },
          body: JSON.stringify(body),
        }),
  });
}

function pair(by: Owner, profileId?: string) {
  return request("/pair", {
    access: by.token,
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: EXTENSION_ORIGIN },
    body: JSON.stringify({
      version: 1,
      label: "Synthetic browser",
      ...(profileId ? { profileId } : {}),
    }),
  });
}

async function setup() {
  const by = await owner();
  const paired = await pair(by);
  expect(paired.status).toBe(201);
  const device = v.parse(devicePairResultSchema, await paired.json());
  const settings = v.parse(
    syncSettingsStateSchema,
    await (await deviceApi(device.credential)).json(),
  );
  return { by, device, settings };
}

async function copy(by: Owner, copyFrom: string) {
  const response = await manage(by, "/profiles", { version: 1, name: "Agent browser", copyFrom });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; name: string };
}

async function save(credential: string, expectedRevision: number, settings: LocalSettings) {
  return deviceApi(credential, "/v1/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, expectedRevision, settings }),
  });
}

describe("settings profile isolation", () => {
  it("requires an explicit profile for pairing when multiple profiles exist", async () => {
    const { by, device, settings } = await setup();
    const copied = await copy(by, settings.profileId);
    const listed = await manage(by, "/profiles");
    expect(await listed.json()).toMatchObject({
      version: 1,
      profiles: expect.arrayContaining([
        expect.objectContaining({ id: settings.profileId }),
        { id: copied.id, name: "Agent browser" },
      ]),
    });
    const rejected = await pair(by);
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ error: "profile_required" });
    const accepted = await pair(by, copied.id);
    expect(accepted.status).toBe(201);
    const second = v.parse(devicePairResultSchema, await accepted.json());
    expect(await (await deviceApi(second.credential)).json()).toMatchObject({
      profileId: copied.id,
    });
    expect(await (await deviceApi(device.credential)).json()).toMatchObject({
      profileId: settings.profileId,
    });
  });

  it("does not expose, copy, edit, assign or pair another owner's profile", async () => {
    const alice = await setup();
    const bob = await setup();
    const foreign = alice.settings.profileId;
    const listed = await manage(bob.by, "/profiles");
    expect(JSON.stringify(await listed.json())).not.toContain(foreign);
    const responses = await Promise.all([
      manage(bob.by, `/profiles/${foreign}/settings`),
      manage(bob.by, "/profiles", { version: 1, name: "Foreign copy", copyFrom: foreign }),
      manage(
        bob.by,
        `/profiles/${foreign}/settings`,
        {
          version: 1,
          expectedRevision: 0,
          settings: { ...createDefaultSettings(), connections: [] },
        },
        "PUT",
      ),
      manage(bob.by, `/devices/${bob.device.deviceId}/profile`, { version: 1, profileId: foreign }),
      pair(bob.by, foreign),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.clone().text()));
    expect(
      responses.map((response) => response.status),
      JSON.stringify(bodies),
    ).toEqual([404, 404, 404, 404, 404]);
    expect(await (await deviceApi(bob.device.credential)).json()).toEqual(bob.settings);
    expect(await (await deviceApi(alice.device.credential)).json()).toEqual(alice.settings);
  });

  it("rejects a stale device write after reassignment and keeps the new profile unchanged", async () => {
    const { by, device, settings } = await setup();
    const oldSettings = {
      ...createDefaultSettings(),
      excludedSites: [{ hostname: "old-profile.example", includeSubdomains: true }],
    };
    const written = await save(device.credential, settings.revision, oldSettings);
    expect(written.status).toBe(200);
    const beforeSwitch = v.parse(syncSettingsStateSchema, await written.json());
    const copied = await copy(by, settings.profileId);
    const reassigned = await manage(by, `/devices/${device.deviceId}/profile`, {
      version: 1,
      profileId: copied.id,
    });
    expect(reassigned.status).toBe(204);
    const afterSwitch = v.parse(
      syncSettingsStateSchema,
      await (await deviceApi(device.credential)).json(),
    );
    expect(afterSwitch.profileId).toBe(copied.id);
    expect(afterSwitch.revision).toBeGreaterThan(beforeSwitch.revision);
    const stale = await save(device.credential, beforeSwitch.revision, {
      ...oldSettings,
      excludedSites: [{ hostname: "stale-local-change.example", includeSubdomains: false }],
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: "settings_conflict", current: afterSwitch });
    expect(await (await deviceApi(device.credential)).json()).toEqual(afterSwitch);
  });

  it("copies profile policy independently while sharing later binding changes", async () => {
    const { by, device, settings } = await setup();
    const initial = {
      ...createDefaultSettings(),
      excludedSites: [{ hostname: "copied.example", includeSubdomains: false }],
    };
    expect((await save(device.credential, settings.revision, initial)).status).toBe(200);
    const copied = await copy(by, settings.profileId);
    const secondPair = await pair(by, copied.id);
    const second = v.parse(devicePairResultSchema, await secondPair.json());
    const current = v.parse(
      syncSettingsStateSchema,
      await (await deviceApi(device.credential)).json(),
    );
    const binding = {
      recipeId: "synthetic-login",
      origin: "https://bank.example",
      provider: "bitwarden",
      userId: USER,
      itemId: "synthetic-item",
      itemName: "Synthetic account",
      slots: [{ slot: "password", field: "password" as const }],
    };
    expect(
      (
        await save(device.credential, current.revision, {
          ...initial,
          excludedSites: [{ hostname: "original-only.example", includeSubdomains: false }],
          bindings: [binding],
        })
      ).status,
    ).toBe(200);
    expect(await (await deviceApi(second.credential)).json()).toMatchObject({
      profileId: copied.id,
      settings: { excludedSites: initial.excludedSites, bindings: [binding] },
    });
  });
});

describe("extension profile editor authorization", () => {
  function editor(by: Owner, path: string, init: RequestInit = {}) {
    return request(`/pair/profiles${path}`, {
      access: by.token,
      ...init,
      headers: { Origin: EXTENSION_ORIGIN, ...init.headers },
    });
  }
  it("requires Access and an allowed extension rather than a paired device token", async () => {
    const { by, device, settings } = await setup();
    const path = `/${settings.profileId}/settings`;
    expect((await editor(by, path)).status).toBe(200);
    expect(
      (
        await deviceApi(device.credential, `/pair/profiles${path}`, {
          headers: { Origin: EXTENSION_ORIGIN },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await editor(by, path, {
          headers: { Origin: "chrome-extension://bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        })
      ).status,
    ).toBe(403);
    expect(
      (await editor(by, path, { headers: { Origin: "https://attacker.example" } })).status,
    ).toBe(403);
  });
  it("never reads or overwrites a foreign owner's profile through the editor", async () => {
    const alice = await setup();
    const bob = await setup();
    const path = `/${alice.settings.profileId}/settings`;
    expect((await editor(bob.by, path)).status).toBe(404);
    const write = await editor(bob.by, path, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        expectedRevision: 0,
        settings: { ...createDefaultSettings(), connections: [] },
      }),
    });
    expect(write.status).toBe(404);
    expect(await (await deviceApi(alice.device.credential)).json()).toEqual(alice.settings);
  });
});
