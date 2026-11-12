import {
  createDefaultSettings,
  devicePairResultSchema,
  localSettingsSchema,
  MAX_SETTINGS_DOCUMENT_BYTES,
  settingsDocumentBytes,
  syncSettingsStateSchema,
  syncSettingsWriteSchema,
  type LocalSettings,
} from "@pateat/contracts";
import { env } from "cloudflare:workers";
import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { readSettings, writeSettings } from "../src/settings-store";
import { assignProfile, copyProfile, deleteProfile, ensureProfile } from "../src/profile-store";
import {
  deviceApi,
  installAccessKeys,
  ORIGIN,
  owner,
  ownerIdFor,
  request,
  type Owner,
} from "./access-helpers";

installAccessKeys();

const EXTENSION_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const USER = "00000000-0000-4000-8000-000000000001";
const empty = (): LocalSettings => ({ ...createDefaultSettings(), connections: [] });
const excluded = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    hostname: `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.x${index}.example`,
    includeSubdomains: false,
  }));
const bindings = (count: number): LocalSettings["bindings"] =>
  Array.from({ length: count }, (_, index) => ({
    recipeId: `synthetic-${index}`,
    origin: "https://bank.example",
    provider: "bitwarden",
    server: "cloud-us",
    userId: USER,
    itemId: `synthetic-item-${index}`,
    itemName: "架空の口座".repeat(20),
    slots: [{ slot: "password", field: "password" }],
  }));
const links = (count: number): NonNullable<LocalSettings["detailLinks"]> =>
  Array.from({ length: count }, (_, index) => ({
    origin: "https://bank.example",
    provider: "bitwarden",
    server: "cloud-us",
    userId: USER,
    itemId: `synthetic-item-${index}`,
    detail: "secret-answer",
    source: { itemId: `synthetic-source-${index}`, field: { custom: "合言葉".repeat(30) } },
    question: `synthetic question ${index}`,
  }));

function editor(
  by: Owner,
  profileId: string,
  revision: number,
  settings: LocalSettings,
  mount = "manage",
) {
  return request(
    mount === "extension"
      ? `/extension/profiles/${profileId}/settings`
      : `/manage/api/profiles/${profileId}/settings`,
    {
      access: by.token,
      method: "PUT",
      headers: {
        Origin: mount === "extension" ? EXTENSION_ORIGIN : ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ version: 1, expectedRevision: revision, settings }),
    },
  );
}
function save(
  credential: string,
  expectedRevision: number,
  settings: LocalSettings,
  writeId = crypto.randomUUID(),
) {
  return deviceApi(credential, "/v1/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, expectedRevision, settings, writeId }),
  });
}
async function setup() {
  const by = await owner();
  const response = await request("/pair", {
    access: by.token,
    method: "POST",
    headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
    body: JSON.stringify({ version: 1, label: "Synthetic composition browser" }),
  });
  expect(response.status).toBe(201);
  const device = v.parse(devicePairResultSchema, await response.json());
  const state = v.parse(syncSettingsStateSchema, await (await deviceApi(device.credential)).json());
  const ownerId = (await ownerIdFor(by.subject))!;
  return { by, device, state, ownerId };
}
async function rows(ownerId: string) {
  const [shared, profiles, devices] = await Promise.all([
    env.DB.prepare("SELECT * FROM settings WHERE owner_id = ?").bind(ownerId).all(),
    env.DB.prepare("SELECT * FROM profiles WHERE owner_id = ? ORDER BY id").bind(ownerId).all(),
    env.DB.prepare(
      "SELECT id, profile_id, settings_write_id FROM devices WHERE owner_id = ? ORDER BY id",
    )
      .bind(ownerId)
      .all(),
  ]);
  return [shared.results, profiles.results, devices.results];
}
async function liveDocuments(ownerId: string) {
  const profiles = await env.DB.prepare(
    "SELECT id FROM profiles WHERE owner_id = ? AND deleted_at IS NULL",
  )
    .bind(ownerId)
    .all<{ id: string }>();
  const states = await Promise.all(
    profiles.results.map((profile) => readSettings(env.DB, ownerId, profile.id)),
  );
  for (const state of states) {
    if (!state.settings) continue;
    expect(settingsDocumentBytes(state.settings)).toBeLessThanOrEqual(MAX_SETTINGS_DOCUMENT_BYTES);
    expect(
      v.is(syncSettingsWriteSchema, {
        version: 1,
        expectedRevision: state.revision,
        settings: state.settings,
      }),
    ).toBe(true);
  }
}
/** Two legal profiles whose policy and later shared changes must be checked together. */
async function twoProfiles() {
  const context = await setup();
  const large = { ...empty(), excludedSites: excluded(410) };
  expect(v.is(syncSettingsWriteSchema, { version: 1, expectedRevision: 0, settings: large })).toBe(
    true,
  );
  expect((await save(context.device.credential, 0, large)).status).toBe(200);
  const copy = await copyProfile(env.DB, context.ownerId, context.state.profileId, "Small profile");
  expect(copy.ok).toBe(true);
  if (!copy.ok) throw new Error("copy failed");
  const secondId = copy.profile.id;
  const current = await readSettings(env.DB, context.ownerId, secondId);
  expect((await editor(context.by, secondId, current.revision, empty())).status).toBe(200);
  const before = await readSettings(env.DB, context.ownerId, secondId);
  return { ...context, large, secondId, revision: before.revision };
}

describe("fully composed settings size", () => {
  it.each([
    ["bindings", "manage"],
    ["bindings", "extension"],
    ["bindings", "device"],
    ["links", "manage"],
    ["links", "extension"],
    ["links", "device"],
  ] as const)(
    "rejects shared %s growth through %s that overflows another live profile, with no partial write or acknowledgement",
    async (kind, mount) => {
      const c = await twoProfiles();
      const incoming = {
        ...empty(),
        ...(kind === "bindings" ? { bindings: bindings(60) } : { detailLinks: links(60) }),
      };
      expect(v.is(localSettingsSchema, incoming)).toBe(true);
      expect(
        v.is(syncSettingsWriteSchema, {
          version: 1,
          expectedRevision: c.revision,
          settings: incoming,
        }),
      ).toBe(true);
      const composed = {
        ...c.large,
        bindings: incoming.bindings,
        ...(incoming.detailLinks ? { detailLinks: incoming.detailLinks } : {}),
      };
      expect(settingsDocumentBytes(composed)).toBeGreaterThan(MAX_SETTINGS_DOCUMENT_BYTES);
      if (mount === "device")
        expect(await assignProfile(env.DB, c.ownerId, c.device.deviceId, c.secondId)).toBe(true);
      const latest = await readSettings(env.DB, c.ownerId, c.secondId);
      const before = await rows(c.ownerId);
      const response =
        mount === "device"
          ? await save(c.device.credential, latest.revision, incoming)
          : await editor(c.by, c.secondId, latest.revision, incoming, mount);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "settings_limit" });
      expect(await rows(c.ownerId)).toEqual(before);
      await liveDocuments(c.ownerId);
    },
  );
});

/** Build a legal Unicode document at an exact UTF-8 byte size, independently of storage composition. */
function exactDocument(bytes: number, profile = empty()): LocalSettings {
  const document = {
    ...profile,
    bindings: bindings(200).map((binding) => ({ ...binding, itemName: "界" })),
  };
  for (const binding of document.bindings) {
    for (const key of ["itemName", "itemId"] as const) {
      const remaining = bytes - new TextEncoder().encode(JSON.stringify(document)).byteLength;
      if (remaining < 0) throw new Error("fixture already exceeds target");
      binding[key] += "x".repeat(Math.min(remaining, 200 - binding[key].length));
    }
  }
  expect(new TextEncoder().encode(JSON.stringify(document)).byteLength).toBe(bytes);
  expect(v.is(localSettingsSchema, document)).toBe(true);
  return document;
}

/** Execute a real competing operation after the writer's reads, immediately before its atomic batch. */
function beforeBatch(compete: () => Promise<unknown>): D1Database {
  let first = true;
  return {
    prepare: env.DB.prepare.bind(env.DB),
    batch: async (statements: D1PreparedStatement[]) => {
      if (first) {
        first = false;
        await compete();
      }
      return env.DB.batch(statements);
    },
  } as D1Database;
}

describe("settings composition round trips and lifecycle", () => {
  it.each([false, true])(
    "omitted or explicitly removed links replace the old shared links (explicit %s)",
    async (explicit) => {
      const c = await setup();
      const initial = { ...empty(), detailLinks: links(200) };
      expect((await save(c.device.credential, 0, initial)).status).toBe(200);
      const replacement = {
        ...empty(),
        excludedSites: excluded(410),
        ...(explicit ? { detailLinks: [] } : {}),
      };
      expect(
        settingsDocumentBytes({ ...replacement, detailLinks: initial.detailLinks }),
      ).toBeGreaterThan(MAX_SETTINGS_DOCUMENT_BYTES);
      const response = await save(c.device.credential, 1, replacement);
      expect(response.status).toBe(200);
      const after = v.parse(
        syncSettingsStateSchema,
        await (await deviceApi(c.device.credential)).json(),
      );
      expect(after.settings).toEqual(replacement);
      await liveDocuments(c.ownerId);
    },
  );

  it("accepts exactly 120 KiB with Unicode and rejects one additional UTF-8 byte without changing data or acknowledgement", async () => {
    const c = await setup();
    const exact = exactDocument(MAX_SETTINGS_DOCUMENT_BYTES);
    expect(JSON.stringify(exact).length).toBeLessThan(MAX_SETTINGS_DOCUMENT_BYTES);
    expect(settingsDocumentBytes(exact)).toBe(MAX_SETTINGS_DOCUMENT_BYTES);
    const response = await save(c.device.credential, 0, exact);
    expect(response.status).toBe(200);
    const after = v.parse(
      syncSettingsStateSchema,
      await (await deviceApi(c.device.credential)).json(),
    );
    expect(after.settings).toEqual(exact);
    expect(settingsDocumentBytes(after.settings)).toBe(MAX_SETTINGS_DOCUMENT_BYTES);
    const before = await rows(c.ownerId);
    const over = structuredClone(exact);
    const adjustable = over.bindings.find((binding) => binding.itemName.length < 200)!;
    adjustable.itemName += "x";
    expect(settingsDocumentBytes(over)).toBe(MAX_SETTINGS_DOCUMENT_BYTES + 1);
    expect(v.is(localSettingsSchema, over)).toBe(true);
    expect((await save(c.device.credential, 1, over)).status).toBe(400);
    expect(await rows(c.ownerId)).toEqual(before);
    // Readback can itself be uploaded; JSON key ordering and optional defaults do not add bytes.
    expect((await save(c.device.credential, 1, after.settings!)).status).toBe(200);
    await liveDocuments(c.ownerId);
  });

  it("checks an exact-boundary non-writing profile before allowing a one-byte shared growth", async () => {
    const c = await setup();
    const exact = exactDocument(MAX_SETTINGS_DOCUMENT_BYTES, {
      ...empty(),
      excludedSites: excluded(100),
    });
    expect((await save(c.device.credential, 0, exact)).status).toBe(200);
    const copied = await copyProfile(env.DB, c.ownerId, c.state.profileId, "Small");
    expect(copied.ok).toBe(true);
    if (!copied.ok) throw new Error("copy failed");
    const other = await readSettings(env.DB, c.ownerId, copied.profile.id);
    expect(
      (await editor(c.by, copied.profile.id, other.revision, { ...exact, excludedSites: [] }))
        .status,
    ).toBe(200);
    const current = await readSettings(env.DB, c.ownerId, copied.profile.id);
    const grow = structuredClone(current.settings!);
    grow.bindings.find((binding) => binding.itemName.length < 200)!.itemName += "x";
    expect(settingsDocumentBytes(grow)).toBeLessThan(MAX_SETTINGS_DOCUMENT_BYTES);
    expect(settingsDocumentBytes({ ...grow, excludedSites: exact.excludedSites })).toBe(
      MAX_SETTINGS_DOCUMENT_BYTES + 1,
    );
    const before = await rows(c.ownerId);
    expect((await editor(c.by, copied.profile.id, current.revision, grow)).status).toBe(413);
    expect(await rows(c.ownerId)).toEqual(before);
    await liveDocuments(c.ownerId);
  });

  it("does not combine another owner's policy or a deleted profile with the proposed shared document", async () => {
    const alice = await twoProfiles();
    const bob = await setup();
    expect(
      (await save(bob.device.credential, 0, { ...empty(), excludedSites: excluded(410) })).status,
    ).toBe(200);
    expect(await assignProfile(env.DB, alice.ownerId, alice.device.deviceId, alice.secondId)).toBe(
      true,
    );
    expect(await deleteProfile(env.DB, alice.ownerId, alice.state.profileId)).toEqual({ ok: true });
    const bobBefore = await rows(bob.ownerId);
    const latest = await readSettings(env.DB, alice.ownerId, alice.secondId);
    const incoming = { ...empty(), bindings: bindings(60), detailLinks: links(20) };
    expect((await save(alice.device.credential, latest.revision, incoming)).status).toBe(200);
    expect(await rows(bob.ownerId)).toEqual(bobBefore);
    await liveDocuments(alice.ownerId);
    await liveDocuments(bob.ownerId);
  });

  it("serializes competing profile and shared-data writes so at most one conflicting composition commits", async () => {
    const c = await setup();
    expect((await save(c.device.credential, 0, empty())).status).toBe(200);
    const copied = await copyProfile(env.DB, c.ownerId, c.state.profileId, "Other");
    expect(copied.ok).toBe(true);
    if (!copied.ok) throw new Error("copy failed");
    const revision = (await readSettings(env.DB, c.ownerId, c.state.profileId)).revision;
    const shared = { ...empty(), bindings: bindings(60) };
    const profile = { ...empty(), excludedSites: excluded(410) };
    const responses = await Promise.all([
      save(c.device.credential, revision, profile),
      editor(c.by, copied.profile.id, revision, shared),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    await liveDocuments(c.ownerId);
  });

  it.each(["writer", "copy", "delete", "assign"] as const)(
    "rechecks compare-and-swap when %s changes the owner between composition validation and commit",
    async (operation) => {
      const c = await twoProfiles();
      const before = await readSettings(env.DB, c.ownerId, c.state.profileId, c.device.deviceId);
      const candidate = { ...c.large, language: "ja" as const };
      let afterCompeting: Awaited<ReturnType<typeof rows>> | undefined;
      const db = beforeBatch(async () => {
        switch (operation) {
          case "writer":
            expect(
              (
                await writeSettings(
                  env.DB,
                  c.ownerId,
                  c.secondId,
                  {
                    version: 1,
                    expectedRevision: before.revision,
                    settings: { ...empty(), theme: "dark" },
                  },
                  null,
                )
              ).ok,
            ).toBe(true);
            break;
          case "copy":
            expect(
              (await copyProfile(env.DB, c.ownerId, c.state.profileId, "Racing copy")).ok,
            ).toBe(true);
            break;
          case "delete":
            expect(await deleteProfile(env.DB, c.ownerId, c.secondId)).toEqual({ ok: true });
            break;
          case "assign":
            expect(await assignProfile(env.DB, c.ownerId, c.device.deviceId, c.secondId)).toBe(
              true,
            );
            break;
        }
        afterCompeting = await rows(c.ownerId);
      });
      const result = await writeSettings(
        db,
        c.ownerId,
        c.state.profileId,
        {
          version: 1,
          expectedRevision: before.revision,
          settings: candidate,
          writeId: crypto.randomUUID(),
        },
        c.device.deviceId,
      );
      expect(result).toMatchObject({ ok: false, current: { revision: before.revision + 1 } });
      expect(await rows(c.ownerId)).toEqual(afterCompeting);
      await liveDocuments(c.ownerId);
    },
  );
});

describe("canonical defaults and empty-profile creation races", () => {
  it("measures schema-defaulted readback rather than an exact-boundary raw upload with omitted optional lists", async () => {
    const c = await setup();
    const canonical = exactDocument(MAX_SETTINGS_DOCUMENT_BYTES);
    const {
      repromptSites: _reprompt,
      passkeyBrowserSites: _passkeys,
      ...raw
    } = structuredClone(canonical);
    const missingBytes = MAX_SETTINGS_DOCUMENT_BYTES - settingsDocumentBytes(raw);
    raw.bindings.find((binding) => binding.itemName.length + missingBytes <= 200)!.itemName +=
      "x".repeat(missingBytes);
    expect(settingsDocumentBytes(raw)).toBe(MAX_SETTINGS_DOCUMENT_BYTES);
    const parsed = v.parse(localSettingsSchema, raw);
    expect(settingsDocumentBytes(parsed)).toBeGreaterThan(MAX_SETTINGS_DOCUMENT_BYTES);
    const before = await rows(c.ownerId);
    const response = await deviceApi(c.device.credential, "/v1/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        version: 1,
        expectedRevision: 0,
        settings: raw,
        writeId: crypto.randomUUID(),
      }),
    });
    expect(response.status).toBe(400);
    expect(await rows(c.ownerId)).toEqual(before);
    // A normalized document exactly at the limit is still accepted and reads back unchanged.
    expect((await save(c.device.credential, 0, canonical)).status).toBe(200);
    await liveDocuments(c.ownerId);
  });

  it.each(["pair", "ensure"] as const)(
    "keeps every profile valid when %s adds an empty profile without changing the owner revision",
    async (operation) => {
      const c = await twoProfiles();
      let target = c.state.profileId;
      if (operation === "ensure") {
        // An owner whose default row is absent still has an independently named live profile.
        expect(await assignProfile(env.DB, c.ownerId, c.device.deviceId, c.secondId)).toBe(true);
        await env.DB.prepare("DELETE FROM profiles WHERE owner_id = ? AND id = ?")
          .bind(c.ownerId, c.state.profileId)
          .run();
        target = c.secondId;
      }
      const before = await readSettings(env.DB, c.ownerId, target);
      const incoming = exactDocument(MAX_SETTINGS_DOCUMENT_BYTES, {
        ...empty(),
        excludedSites: operation === "pair" ? excluded(100) : [],
      });
      // The other large profile would prohibit this candidate, so clear its policy first.
      if (operation === "pair") {
        const existing = await readSettings(env.DB, c.ownerId, c.secondId);
        expect((await editor(c.by, c.secondId, existing.revision, empty())).status).toBe(200);
      }
      const revision = (await readSettings(env.DB, c.ownerId, target)).revision;
      const db = beforeBatch(async () => {
        if (operation === "ensure") await ensureProfile(env.DB, c.ownerId);
        else {
          const response = await request("/pair", {
            access: c.by.token,
            method: "POST",
            headers: { Origin: EXTENSION_ORIGIN, "Content-Type": "application/json" },
            body: JSON.stringify({
              version: 1,
              label: "New profile browser",
              newProfile: "Racing empty profile",
            }),
          });
          expect(response.status).toBe(201);
        }
        expect((await readSettings(env.DB, c.ownerId, target)).revision).toBe(revision);
      });
      const result = await writeSettings(
        db,
        c.ownerId,
        target,
        {
          version: 1,
          expectedRevision: revision,
          settings: incoming,
          writeId: crypto.randomUUID(),
        },
        c.device.deviceId,
      );
      expect(result).toMatchObject({ ok: true, state: { revision: revision + 1 } });
      const count = await env.DB.prepare(
        "SELECT count(*) AS count FROM profiles WHERE owner_id = ? AND deleted_at IS NULL",
      )
        .bind(c.ownerId)
        .first<{ count: number }>();
      expect(count?.count).toBe(operation === "pair" ? 3 : 2);
      expect(before.settings).not.toBeNull();
      await liveDocuments(c.ownerId);
    },
  );
});

describe("profiles already over the composed limit", () => {
  /** Profile A holds shared bindings; profile B's own parts put it over the limit, as stored before the limit covered every profile. */
  async function overLimit() {
    const c = await setup();
    const shared = { ...empty(), bindings: bindings(60) };
    expect((await save(c.device.credential, 0, shared)).status).toBe(200);
    const copied = await copyProfile(env.DB, c.ownerId, c.state.profileId, "Over limit");
    expect(copied.ok).toBe(true);
    if (!copied.ok) throw new Error("copy failed");
    await env.DB.prepare("UPDATE profiles SET document = ? WHERE owner_id = ? AND id = ?")
      .bind(JSON.stringify({ excludedSites: excluded(410) }), c.ownerId, copied.profile.id)
      .run();
    const over = await readSettings(env.DB, c.ownerId, copied.profile.id);
    const bytes = settingsDocumentBytes(over.settings);
    expect(bytes).toBeGreaterThan(MAX_SETTINGS_DOCUMENT_BYTES);
    return { ...c, shared, overId: copied.profile.id, bytes, revision: over.revision };
  }
  const overBytes = async (ownerId: string, profileId: string) =>
    settingsDocumentBytes((await readSettings(env.DB, ownerId, profileId)).settings);

  it("accepts an unrelated edit from another profile", async () => {
    const c = await overLimit();
    const response = await save(c.device.credential, c.revision, { ...c.shared, language: "ja" });
    expect(response.status).toBe(200);
    expect(await overBytes(c.ownerId, c.overId)).toBe(c.bytes);
  });

  it("accepts a shared edit that shrinks the over-limit profile without bringing it under", async () => {
    const c = await overLimit();
    const response = await editor(c.by, c.state.profileId, c.revision, {
      ...empty(),
      bindings: bindings(55),
    });
    expect(response.status).toBe(200);
    const after = await overBytes(c.ownerId, c.overId);
    expect(after).toBeLessThan(c.bytes);
    expect(after).toBeGreaterThan(MAX_SETTINGS_DOCUMENT_BYTES);
  });

  it.each(["device", "manage"] as const)(
    "refuses a shared edit through %s that grows the over-limit profile further",
    async (mount) => {
      const c = await overLimit();
      const before = await rows(c.ownerId);
      const grown = { ...empty(), bindings: bindings(61) };
      const response =
        mount === "device"
          ? await save(c.device.credential, c.revision, grown)
          : await editor(c.by, c.state.profileId, c.revision, grown);
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: "settings_limit" });
      expect(await rows(c.ownerId)).toEqual(before);
    },
  );

  it("does not fail writes when another profile's stored document no longer passes the schema", async () => {
    const c = await overLimit();
    await env.DB.prepare("UPDATE profiles SET document = ? WHERE owner_id = ? AND id = ?")
      .bind(JSON.stringify({ excludedSites: "not a list" }), c.ownerId, c.overId)
      .run();
    const response = await save(c.device.credential, c.revision, { ...c.shared, language: "ja" });
    expect(response.status).toBe(200);
  });
});

describe("writes against another revision", () => {
  it("refuses a future expectedRevision before a concurrent write could make it current", async () => {
    const c = await twoProfiles();
    const small = await readSettings(env.DB, c.ownerId, c.secondId);
    let batched = false;
    const db = beforeBatch(async () => {
      batched = true;
      await writeSettings(
        env.DB,
        c.ownerId,
        c.secondId,
        { version: 1, expectedRevision: small.revision, settings: empty() },
        null,
      );
    });
    const before = await rows(c.ownerId);
    // Shared bindings that would put the large profile over the limit.
    const result = await writeSettings(
      db,
      c.ownerId,
      c.secondId,
      {
        version: 1,
        expectedRevision: small.revision + 1,
        settings: { ...empty(), bindings: bindings(60) },
      },
      null,
    );
    expect(result).toMatchObject({ ok: false, current: { revision: small.revision } });
    expect(batched).toBe(false);
    expect(await rows(c.ownerId)).toEqual(before);
    await liveDocuments(c.ownerId);
  });

  it("answers a missing profile without writing", async () => {
    const c = await setup();
    const before = await rows(c.ownerId);
    const result = await writeSettings(
      env.DB,
      c.ownerId,
      crypto.randomUUID(),
      { version: 1, expectedRevision: 0, settings: empty() },
      null,
    );
    expect(result).toEqual({ ok: false, current: undefined });
    expect(await rows(c.ownerId)).toEqual(before);
  });
});
