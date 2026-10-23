import {
  createDefaultSettings,
  devicePairResultSchema,
  syncSettingsStateSchema,
  type LocalSettings,
} from "@pateat/contracts";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  deviceApi,
  installAccessKeys,
  owner,
  ORIGIN,
  pairOwner,
  request,
  type Owner,
} from "./access-helpers";

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

function pair(
  by: Owner,
  profileId?: string,
  { label = "Synthetic browser", newProfile }: { label?: string; newProfile?: string } = {},
) {
  return request("/pair", {
    access: by.token,
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: EXTENSION_ORIGIN },
    body: JSON.stringify({
      version: 1,
      label,
      ...(profileId ? { profileId } : {}),
      ...(newProfile ? { newProfile } : {}),
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
  it("asks an existing owner's pairing to choose a profile even when there is one", async () => {
    const { by, settings } = await setup();
    const asked = await pair(by);
    expect(asked.status).toBe(409);
    expect(await asked.json()).toEqual({
      error: "profile_required",
      profiles: [{ id: settings.profileId, name: "Default" }],
    });
  });

  it("creates a new profile while pairing, which the device's first sync fills", async () => {
    const { by, device, settings } = await setup();
    const shared = {
      ...createDefaultSettings(),
      connections: [],
      excludedSites: [{ hostname: "default-only.example", includeSubdomains: false }],
      repromptSites: [{ hostname: "default-bank.example", includeSubdomains: true }],
      passkeyBrowserSites: [{ hostname: "default-passkeys.example" }],
    };
    expect((await save(device.credential, settings.revision, shared)).status).toBe(200);
    const created = await pair(by, undefined, { label: "Agent", newProfile: "Agent browser" });
    expect(created.status).toBe(201);
    const agent = v.parse(devicePairResultSchema, await created.json());
    const state = v.parse(
      syncSettingsStateSchema,
      await (await deviceApi(agent.credential)).json(),
    );
    // Its own parts are empty and marked new; the shared bindings are the owner's.
    expect(state).toMatchObject({
      revision: 1,
      newProfile: true,
      settings: {
        excludedSites: [],
        repromptSites: [],
        passkeyBrowserSites: [],
        siteDefaults: [],
        bindings: [],
      },
    });
    expect(state.profileId).not.toBe(settings.profileId);
    const filled = await save(agent.credential, state.revision, {
      ...shared,
      excludedSites: [{ hostname: "agent-only.example", includeSubdomains: false }],
      repromptSites: [{ hostname: "agent-bank.example", includeSubdomains: false }],
      passkeyBrowserSites: [{ hostname: "agent-passkeys.example" }],
    });
    expect(filled.status).toBe(200);
    const after = v.parse(
      syncSettingsStateSchema,
      await (await deviceApi(agent.credential)).json(),
    );
    expect(after.newProfile).toBeUndefined();
    expect(after.settings?.excludedSites).toEqual([
      { hostname: "agent-only.example", includeSubdomains: false },
    ]);
    expect(after.settings?.repromptSites).toEqual([
      { hostname: "agent-bank.example", includeSubdomains: false },
    ]);
    // So are the sites whose passkey requests go to the browser (ADR 0007).
    expect(after.settings?.passkeyBrowserSites).toEqual([{ hostname: "agent-passkeys.example" }]);
    // The Default profile keeps its own sites that ask for the master password.
    const original = v.parse(
      syncSettingsStateSchema,
      await (await deviceApi(device.credential)).json(),
    );
    expect(original.settings?.repromptSites).toEqual([
      { hostname: "default-bank.example", includeSubdomains: true },
    ]);
    expect(original.settings?.passkeyBrowserSites).toEqual([
      { hostname: "default-passkeys.example" },
    ]);
    // Names are unique per owner, ignoring case.
    const taken = await pair(by, undefined, { newProfile: "agent BROWSER" });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({
      error: "profile_name_taken",
      profiles: expect.arrayContaining([
        { id: settings.profileId, name: "Default" },
        { id: state.profileId, name: "Agent browser" },
      ]),
    });
    const gone = await pair(by, "00000000-0000-4000-8000-0000000000ff");
    expect(gone.status).toBe(404);
    expect(await gone.json()).toMatchObject({
      error: "profile_not_found",
      profiles: expect.any(Array),
    });
  });

  it("renames a profile and refuses a name another profile has", async () => {
    const { by, settings } = await setup();
    const copied = await copy(by, settings.profileId);
    const renamed = await manage(
      by,
      `/profiles/${copied.id}`,
      { version: 1, name: "Grok Bot" },
      "PATCH",
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toEqual({ id: copied.id, name: "Grok Bot" });
    const taken = await manage(
      by,
      `/profiles/${copied.id}`,
      { version: 1, name: "default" },
      "PATCH",
    );
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "profile_name_taken" });
    // Its own name, in another case, is not taken.
    expect(
      (await manage(by, `/profiles/${copied.id}`, { version: 1, name: "GROK BOT" }, "PATCH"))
        .status,
    ).toBe(200);
  });

  it("deletes a profile only when no device uses it and it is not the last", async () => {
    const { by, device, settings } = await setup();
    const remove = (id: string) =>
      request(`/manage/api/profiles/${id}`, {
        access: by.token,
        method: "DELETE",
        headers: { Origin: ORIGIN },
      });
    const last = await remove(settings.profileId);
    expect(last.status).toBe(409);
    expect(await last.json()).toEqual({ error: "profile_in_use", devices: ["Synthetic browser"] });
    const copied = await copy(by, settings.profileId);
    const agent = v.parse(
      devicePairResultSchema,
      await (await pair(by, copied.id, { label: "Agent" })).json(),
    );
    const inUse = await remove(copied.id);
    expect(inUse.status).toBe(409);
    expect(await inUse.json()).toEqual({ error: "profile_in_use", devices: ["Agent"] });
    // A revoked device does not keep the profile.
    expect((await deviceApi(agent.credential, "/v1/device", { method: "DELETE" })).status).toBe(
      204,
    );
    expect((await remove(copied.id)).status).toBe(204);
    expect(await (await manage(by, "/profiles")).json()).toEqual({
      version: 1,
      profiles: [{ id: settings.profileId, name: "Default" }],
    });
    // Deleted profiles can no longer be read, written, copied, assigned or paired.
    const gone = await Promise.all([
      manage(by, `/profiles/${copied.id}/settings`),
      manage(by, "/profiles", { version: 1, name: "Copy of gone", copyFrom: copied.id }),
      manage(by, `/devices/${device.deviceId}/profile`, { version: 1, profileId: copied.id }),
      pair(by, copied.id),
      remove(copied.id),
    ]);
    expect(gone.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);
    // The owner's only profile stays, once no device uses it.
    expect((await deviceApi(device.credential, "/v1/device", { method: "DELETE" })).status).toBe(
      204,
    );
    const only = await remove(settings.profileId);
    expect(only.status).toBe(409);
    expect(await only.json()).toEqual({ error: "last_profile" });
  });

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
      connections: [],
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
      connections: [],
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
    return request(`/extension/profiles${path}`, {
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
        await deviceApi(device.credential, `/extension/profiles${path}`, {
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
    // A sign-in through the pairing application, which needs no WARP, is not enough
    // (ADR 0030, ADR 0076).
    const viaPair = await pairOwner(by.subject);
    expect((await editor(viaPair, path)).status).toBe(403);
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
