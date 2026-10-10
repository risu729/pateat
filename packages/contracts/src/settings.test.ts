import { describe, expect, it } from "vitest";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  getItemEligibility,
  isSiteExcluded,
  normalizeHostname,
  parseLocalSettings,
  parseSettingsResponse,
  parseSiteUrl,
  resolveSiteAccount,
} from "./settings";
import { createSettingsStore, type SettingsStorage } from "./settings-store";

function withDefault() {
  const settings = createDefaultSettings();
  settings.siteDefaults.push({
    origin: "https://bank.example",
    connectionId: "demo-personal",
    itemId: "primary",
  });
  return settings;
}

describe("host policy and URL validation", () => {
  it("matches exact hosts independently of ports and paths, with explicit subdomains", () => {
    const settings = createDefaultSettings();
    settings.excludedSites = [{ hostname: "bank.example", includeSubdomains: false }];
    for (const url of [
      "https://bank.example/login",
      "http://BANK.EXAMPLE:8080/?next=elsewhere",
      "https://bank.example./",
    ])
      expect(isSiteExcluded(settings, url)).toBe(true);
    for (const url of [
      "https://auth.bank.example",
      "https://notbank.example",
      "https://bank.example.evil.test",
      "https://other.example/?site=bank.example",
    ])
      expect(isSiteExcluded(settings, url)).toBe(false);
    settings.excludedSites[0]!.includeSubdomains = true;
    expect(isSiteExcluded(settings, "https://a.auth.bank.example")).toBe(true);
    expect(isSiteExcluded(settings, "https://notbank.example")).toBe(false);
    expect(isSiteExcluded(settings, "https://bank.example.evil.test")).toBe(false);
  });

  it("fails closed on invalid and non-web destinations", () => {
    const settings = withDefault();
    for (const url of [
      "bank.example",
      "https:bank.example",
      "https:///bank.example",
      "javascript:alert(1)",
      "file:///tmp",
      "https://user:password@bank.example",
      "https://@bank.example",
      "https://bank.example\\@evil.test",
      " https://bank.example",
      "https://bank.example\n",
      "https://bank.example:99999",
    ]) {
      expect(parseSiteUrl(url), url).toBeUndefined();
      expect(isSiteExcluded(settings, url), url).toBe(true);
      expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, url), url).toEqual({
        ok: false,
        reason: "invalid-url",
      });
    }
  });

  it("canonicalizes IDN, trailing dots and IP host forms without accepting URLs as hosts", () => {
    expect(normalizeHostname("BANK.EXAMPLE.")).toBe("bank.example");
    expect(normalizeHostname("bücher.example")).toBe("xn--bcher-kva.example");
    expect(normalizeHostname("127.0.0.1")).toBe("127.0.0.1");
    expect(normalizeHostname("[::1]")).toBe("[::1]");
    for (const host of [
      "https://bank.example",
      "bank.example:443",
      "bank.example/path",
      "*.bank.example",
      "bank..example",
      "-bank.example",
      "user@bank.example",
    ])
      expect(normalizeHostname(host)).toBeUndefined();
    const settings = createDefaultSettings();
    settings.excludedSites = [{ hostname: "xn--bcher-kva.example", includeSubdomains: true }];
    expect(isSiteExcluded(settings, "https://bücher.example")).toBe(true);
    expect(isSiteExcluded(settings, "https://auth.bücher.example")).toBe(true);
  });
});

describe("scoped metadata eligibility and next-login defaults", () => {
  it("does not automatically enable future real providers", () => {
    const catalog = structuredClone(DUMMY_VAULT_CATALOG);
    catalog.connections[0]!.provider = "future-real-provider";
    expect(createDefaultSettings(catalog).connections[0]!.enabled).toBe(false);
  });
  it("unions selected items and groups, with item exclusions winning", () => {
    const settings = createDefaultSettings();
    const personal = settings.connections[0]!;
    personal.selection = { mode: "selected", groupIds: [], itemIds: [] };
    expect(getItemEligibility(settings, DUMMY_VAULT_CATALOG, "demo-personal", "primary")).toEqual({
      eligible: false,
      reason: "item-not-selected",
    });
    personal.selection.groupIds = ["everyday"];
    expect(
      getItemEligibility(settings, DUMMY_VAULT_CATALOG, "demo-personal", "primary").eligible,
    ).toBe(true);
    expect(
      getItemEligibility(settings, DUMMY_VAULT_CATALOG, "demo-personal", "secondary").eligible,
    ).toBe(false);
    personal.selection.itemIds = ["secondary", "primary"];
    expect(
      getItemEligibility(settings, DUMMY_VAULT_CATALOG, "demo-personal", "secondary").eligible,
    ).toBe(true);
    personal.excludedItemIds = ["primary"];
    expect(getItemEligibility(settings, DUMMY_VAULT_CATALOG, "demo-personal", "primary")).toEqual({
      eligible: false,
      reason: "item-excluded",
    });
    // Identical item IDs in another connection do not inherit this exclusion.
    expect(getItemEligibility(settings, DUMMY_VAULT_CATALOG, "demo-work", "primary").eligible).toBe(
      true,
    );
  });

  it("scopes field exclusions by both connection and item", () => {
    const settings = createDefaultSettings();
    settings.connections[0]!.excludedFields = [{ itemId: "primary", fieldId: "password" }];
    expect(
      getItemEligibility(settings, DUMMY_VAULT_CATALOG, "demo-personal", "primary"),
    ).toMatchObject({ eligible: true, fieldIds: ["username", "branch"] });
    expect(
      getItemEligibility(settings, DUMMY_VAULT_CATALOG, "demo-personal", "secondary"),
    ).toMatchObject({ eligible: true, fieldIds: ["username", "password"] });
    expect(getItemEligibility(settings, DUMMY_VAULT_CATALOG, "demo-work", "primary")).toMatchObject(
      { eligible: true, fieldIds: ["username", "password"] },
    );
    settings.connections[0]!.excludedFields.push(
      { itemId: "primary", fieldId: "username" },
      { itemId: "primary", fieldId: "branch" },
    );
    expect(getItemEligibility(settings, DUMMY_VAULT_CATALOG, "demo-personal", "primary")).toEqual({
      eligible: false,
      reason: "fields-excluded",
    });
  });

  it("does not guess even with eligible accounts; defaults use exact scheme/host/port", () => {
    const settings = withDefault();
    expect(
      resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, "https://bank.example/login?next=x"),
    ).toMatchObject({ ok: true, connectionId: "demo-personal", itemId: "primary" });
    for (const url of [
      "http://bank.example",
      "https://bank.example:8443",
      "https://auth.bank.example",
      "https://mail.example",
    ])
      expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, url)).toEqual({
        ok: false,
        reason: "default-not-set",
      });
    settings.siteDefaults[0]!.origin = "https://mail.example";
    expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, "https://mail.example")).toEqual({
      ok: false,
      reason: "item-origin-mismatch",
    });
  });

  it("reports missing and ineligible saved references, without selecting another account", () => {
    const settings = withDefault();
    settings.siteDefaults[0]!.connectionId = "missing";
    expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, "https://bank.example")).toEqual({
      ok: false,
      reason: "connection-missing",
    });
    settings.siteDefaults[0]!.connectionId = "demo-personal";
    settings.siteDefaults[0]!.itemId = "missing";
    expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, "https://bank.example")).toEqual({
      ok: false,
      reason: "item-missing",
    });
    settings.siteDefaults[0]!.itemId = "primary";
    settings.connections[0]!.enabled = false;
    expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, "https://bank.example")).toEqual({
      ok: false,
      reason: "connection-disabled",
    });
    settings.connections[0]!.enabled = true;
    settings.connections[0]!.excludedItemIds = ["primary"];
    expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, "https://bank.example")).toEqual({
      ok: false,
      reason: "item-excluded",
    });
    settings.excludedSites = [{ hostname: "bank.example", includeSubdomains: false }];
    expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, "https://bank.example")).toEqual({
      ok: false,
      reason: "site-excluded",
    });
  });
});

describe("strict settings schema", () => {
  it("rejects secret-shaped extras, duplicates, ambiguous hosts and non-origin defaults", () => {
    expect(parseLocalSettings(createDefaultSettings())).toEqual(createDefaultSettings());
    const settings = createDefaultSettings();
    for (const malformed of [
      { ...settings, password: "synthetic" },
      { ...settings, connections: [{ ...settings.connections[0], secret: "synthetic" }] },
      { ...settings, connections: [settings.connections[0], settings.connections[0]] },
      { ...settings, excludedSites: [{ hostname: "BANK.EXAMPLE", includeSubdomains: true }] },
      { ...settings, excludedSites: [{ hostname: "bank.example:443", includeSubdomains: true }] },
      {
        ...settings,
        siteDefaults: [
          { origin: "https://bank.example/", connectionId: "demo-personal", itemId: "primary" },
        ],
      },
      {
        ...settings,
        siteDefaults: [
          { origin: "https://user@bank.example", connectionId: "demo-personal", itemId: "primary" },
        ],
      },
      {
        ...settings,
        connections: [{ ...settings.connections[0], excludedItemIds: ["primary", "primary"] }],
      },
    ])
      expect(() => parseLocalSettings(malformed)).toThrow();
  });
});

function memoryStorage(initial?: unknown) {
  let value = initial;
  const writes: unknown[] = [];
  const storage: SettingsStorage = {
    async read() {
      return structuredClone(value);
    },
    async write(snapshot) {
      value = structuredClone(snapshot);
      writes.push(value);
    },
  };
  return {
    storage,
    writes,
    get value() {
      return value;
    },
  };
}
const get = { version: 1, type: "settings.get" };
const save = (expectedRevision: number, settings = withDefault()) => ({
  version: 1,
  type: "settings.save",
  expectedRevision,
  settings,
});

describe("serialized persistent settings store", () => {
  it("persists only on save and restores the revision in a new worker", async () => {
    const memory = memoryStorage();
    const store = createSettingsStore(memory.storage);
    expect(parseSettingsResponse(await store.handle(get))).toMatchObject({
      ok: true,
      snapshot: { revision: 0, settings: createDefaultSettings() },
    });
    expect(memory.writes).toHaveLength(0);
    expect(await store.handle(save(0))).toMatchObject({
      ok: true,
      snapshot: { revision: 1, settings: withDefault() },
    });
    const resumed = createSettingsStore(memory.storage);
    expect(await resumed.handle(get)).toMatchObject({
      ok: true,
      snapshot: { revision: 1, settings: withDefault() },
    });
  });

  it("fails closed for corrupt/version-mismatched storage and never overwrites it", async () => {
    const corruptSnapshots = [
      null,
      {},
      { version: 2, revision: 4, settings: withDefault() },
      { version: 1, revision: -1, settings: withDefault() },
      { version: 1, revision: 1, settings: { ...withDefault(), password: "synthetic" } },
    ];
    await Promise.all(
      corruptSnapshots.map(async (corrupt) => {
        const memory = memoryStorage(corrupt);
        const store = createSettingsStore(memory.storage);
        expect(await store.handle(get)).toMatchObject({
          ok: false,
          error: { code: "storage-corrupt" },
        });
        expect(await store.handle(save(0))).toMatchObject({
          ok: false,
          error: { code: "storage-corrupt" },
        });
        expect(memory.value).toEqual(corrupt);
        expect(memory.writes).toHaveLength(0);
      }),
    );
  });

  it("allows one concurrent revision writer and rejects stale saves", async () => {
    const memory = memoryStorage();
    const store = createSettingsStore(memory.storage);
    const secondSettings = withDefault();
    secondSettings.siteDefaults[0]!.itemId = "secondary";
    const [first, second] = await Promise.all([
      store.handle(save(0)),
      store.handle(save(0, secondSettings)),
    ]);
    expect(first).toMatchObject({ ok: true, snapshot: { revision: 1 } });
    expect(second).toMatchObject({ ok: false, error: { code: "revision-conflict" } });
    expect(memory.writes).toHaveLength(1);
    expect(await store.handle(save(1, secondSettings))).toMatchObject({
      ok: true,
      snapshot: { revision: 2, settings: secondSettings },
    });
    expect(await store.handle(save(0))).toMatchObject({
      ok: false,
      error: { code: "revision-conflict" },
    });
  });

  it("does not access storage for invalid requests or expose storage errors", async () => {
    let reads = 0;
    const store = createSettingsStore({
      async read() {
        reads++;
        throw new Error("private detail");
      },
      async write() {
        throw new Error("private detail");
      },
    });
    expect(await store.handle({ ...get, secret: "synthetic" })).toMatchObject({
      ok: false,
      error: { code: "invalid-request" },
    });
    expect(
      await store.handle({ ...save(0), settings: { ...withDefault(), secret: "synthetic" } }),
    ).toMatchObject({ ok: false, error: { code: "invalid-settings" } });
    expect(reads).toBe(0);
    const response = await store.handle(get);
    expect(response).toMatchObject({ ok: false, error: { code: "storage-unavailable" } });
    expect(JSON.stringify(response)).not.toContain("private detail");
  });

  it("keeps the previous revision after failed writes and recovers the queue", async () => {
    const memory = memoryStorage();
    let fail = true;
    const store = createSettingsStore({
      ...memory.storage,
      async write(snapshot) {
        if (fail) throw new Error("synthetic write failure");
        await memory.storage.write(snapshot);
      },
    });
    expect(await store.handle(save(0))).toMatchObject({
      ok: false,
      error: { code: "storage-unavailable" },
    });
    expect(await store.handle(get)).toMatchObject({ ok: true, snapshot: { revision: 0 } });
    fail = false;
    expect(await store.handle(save(0))).toMatchObject({ ok: true, snapshot: { revision: 1 } });
  });

  it("detaches accepted mutations from caller changes while queued", async () => {
    const memory = memoryStorage();
    const store = createSettingsStore(memory.storage);
    const settings = withDefault();
    const pending = store.handle(save(0, settings));
    settings.connections[0]!.enabled = false;
    settings.siteDefaults[0]!.itemId = "secondary";
    expect(await pending).toMatchObject({ ok: true, snapshot: { settings: withDefault() } });
  });
});
