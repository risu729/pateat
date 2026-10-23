import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  createDefaultSettings,
  detailLinkSchema,
  detailSourceFieldSchema,
  DUMMY_VAULT_CATALOG,
  getItemEligibility,
  isSiteExcluded,
  normalizeHostname,
  parseLocalSettings,
  parseSettingsResponse,
  parseSiteUrl,
  resolveSiteAccount,
  SETTINGS_CHANGE_HISTORY,
  siteDefaultConnection,
  vaultCatalogSchema,
  type SettingsSnapshot,
} from "./settings";
import { createSettingsStore, type SettingsStorage } from "./settings-store";

function withDefault() {
  const settings = createDefaultSettings();
  settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
    userId: "demo-personal-account",
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
      "/signin",
      "https://[",
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

  // The URL parser keeps a backslash in the query and fragment, so tab URLs can hold one.
  it.each(["https://bank.example/login?next=a\\b", "https://bank.example/#/x\\y"])(
    "accepts a backslash in the query or fragment of %s",
    (url) => {
      expect(new URL(url).href).toBe(url);
      expect(parseSiteUrl(url)?.origin).toBe("https://bank.example");
      expect(isSiteExcluded(createDefaultSettings(), url)).toBe(false);
      expect(resolveSiteAccount(withDefault(), DUMMY_VAULT_CATALOG, url)).toMatchObject({
        ok: true,
        origin: "https://bank.example",
        connectionId: "demo-personal",
        itemId: "primary",
      });
      const excluded = createDefaultSettings();
      excluded.excludedSites = [{ hostname: "bank.example", includeSubdomains: false }];
      expect(isSiteExcluded(excluded, url)).toBe(true);
    },
  );

  it.each([
    "https://bank.example\\@evil.test/login",
    "https://bank.example\\@evil.test?next=a\\b",
    "https://bank.example/a\\b/login?next=a\\b",
  ])("still rejects a backslash in the authority or path of %s", (url) => {
    expect(parseSiteUrl(url)).toBeUndefined();
    expect(isSiteExcluded(createDefaultSettings(), url)).toBe(true);
    expect(resolveSiteAccount(withDefault(), DUMMY_VAULT_CATALOG, url)).toEqual({
      ok: false,
      reason: "invalid-url",
    });
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

  it("resolves a provider-account default to its one local connection", () => {
    const catalog = structuredClone(DUMMY_VAULT_CATALOG);
    catalog.connections[0]!.userId = "account-1";
    const settings = createDefaultSettings();
    settings.siteDefaults.push({
      origin: "https://bank.example",
      provider: "dummy",
      userId: "account-1",
      itemId: "primary",
    });
    expect(resolveSiteAccount(settings, catalog, "https://bank.example/login")).toMatchObject({
      ok: true,
      connectionId: "demo-personal",
      itemId: "primary",
    });
    expect(siteDefaultConnection(settings.siteDefaults[0]!, catalog)).toEqual({
      ok: true,
      connectionId: "demo-personal",
    });
    // Not connected here, connected twice, or a vault that cannot name its account.
    expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, "https://bank.example")).toEqual({
      ok: false,
      reason: "connection-missing",
    });
    const locked = structuredClone(DUMMY_VAULT_CATALOG);
    delete locked.connections[1]!.userId;
    expect(resolveSiteAccount(settings, locked, "https://bank.example")).toEqual({
      ok: false,
      reason: "vault-unavailable",
    });
    catalog.connections[1]!.userId = "account-1";
    expect(resolveSiteAccount(settings, catalog, "https://bank.example")).toEqual({
      ok: false,
      reason: "account-ambiguous",
    });
  });

  it("keeps optional item and account names on a provider-account default", () => {
    const settings = createDefaultSettings();
    const named = {
      origin: "https://bank.example",
      provider: "dummy",
      userId: "account-1",
      itemId: "primary",
      itemName: "Example Bank",
      accountName: "Personal vault",
    };
    const unnamed = {
      origin: "https://mail.example",
      provider: "dummy",
      userId: "account-1",
      itemId: "secondary",
    };
    settings.siteDefaults.push(named, unnamed);
    expect(parseLocalSettings(settings).siteDefaults).toEqual([named, unnamed]);
  });

  it.each([
    ["a mixed entry", { connectionId: "demo-personal", provider: "dummy", userId: "a" }],
    ["an entry without a user ID", { provider: "dummy" }],
    ["an entry without a provider", { userId: "a" }],
    ["an empty item name", { provider: "dummy", userId: "a", itemName: "" }],
    [
      "an item name over 200 characters",
      { provider: "dummy", userId: "a", itemName: "x".repeat(201) },
    ],
    ["an empty account name", { provider: "dummy", userId: "a", accountName: "" }],
    [
      "an account name over 200 characters",
      { provider: "dummy", userId: "a", accountName: "x".repeat(201) },
    ],
  ])("rejects a site default with %s", (_label, fields) => {
    const settings = createDefaultSettings();
    settings.siteDefaults.push({
      origin: "https://bank.example",
      itemId: "primary",
      ...fields,
    } as never);
    expect(() => parseLocalSettings(settings)).toThrow();
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
    settings.siteDefaults[0]!.userId = "missing";
    expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, "https://bank.example")).toEqual({
      ok: false,
      reason: "connection-missing",
    });
    settings.siteDefaults[0]!.userId = "demo-personal-account";
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
          {
            origin: "https://bank.example/",
            provider: "dummy",
            userId: "demo-personal-account",
            itemId: "primary",
          },
        ],
      },
      {
        ...settings,
        siteDefaults: [
          {
            origin: "https://user@bank.example",
            provider: "dummy",
            userId: "demo-personal-account",
            itemId: "primary",
          },
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

describe("personal-detail links (ADR 0061)", () => {
  const link = {
    origin: "https://bank.example",
    provider: "dummy",
    userId: "demo-personal-account",
    itemId: "primary",
    detail: "birth-date",
    source: { itemId: "identity", field: { custom: "生年月日" } },
  };
  const withLinks = (detailLinks: unknown[]) => ({ ...createDefaultSettings(), detailLinks });

  it("keeps links to an identity's phone, a card's fields and custom fields by name", () => {
    const links = [
      link,
      { ...link, detail: "phone-last-4", source: { itemId: "identity", field: "identity.phone" } },
      { ...link, detail: "card-last-4", source: { itemId: "card", field: "card.number" } },
      { ...link, detail: "card-code", source: { itemId: "card", field: "card.code" } },
      // The same detail of another login item, or of the same item on another site.
      { ...link, itemId: "secondary" },
      { ...link, origin: "https://shop.example" },
      {
        ...link,
        userId: "demo-family-account",
        source: { itemId: "identity", field: { custom: "Birthday", position: 2, count: 2 } },
      },
    ];
    expect(parseLocalSettings(withLinks(links)).detailLinks).toEqual(links);
    // Settings saved before links existed have none.
    expect(parseLocalSettings(createDefaultSettings())).not.toHaveProperty("detailLinks");
  });

  it("rejects two links for one login item, site and detail", () => {
    expect(() =>
      parseLocalSettings(
        withLinks([link, { ...link, source: { itemId: "other", field: { custom: "DOB" } } }]),
      ),
    ).toThrow();
  });

  it.each([
    ["an item name", { ...link, itemName: "Synthetic identity" }],
    ["a value", { ...link, value: "1990-04-01" }],
    ["a source item name", { ...link, source: { ...link.source, itemName: "Me" } }],
    ["an unknown detail", { ...link, detail: "passport-number" }],
    ["a page URL as the site", { ...link, origin: "https://bank.example/signin" }],
    ["a login field as the source", { ...link, source: { itemId: "identity", field: "password" } }],
    [
      "an unknown built-in field",
      { ...link, source: { itemId: "identity", field: "identity.ssn" } },
    ],
    ["no source item", { ...link, source: { field: "identity.phone" } }],
  ])("rejects a link with %s", (_label, malformed) => {
    expect(() => parseLocalSettings(withLinks([malformed]))).toThrow();
    expect(v.is(detailLinkSchema, malformed)).toBe(false);
  });

  it("rejects more than 1000 links", () => {
    const links = Array.from({ length: 1001 }, (_, index) => ({
      ...link,
      itemId: `item-${index}`,
    }));
    expect(() => parseLocalSettings(withLinks(links))).toThrow();
    expect(parseLocalSettings(withLinks(links.slice(0, 1000))).detailLinks).toHaveLength(1000);
  });

  it("names a source field as a built-in detail field or a custom reference", () => {
    for (const field of [
      "identity.phone",
      "card.number",
      "card.code",
      { custom: "生年月日" },
      { custom: "Birthday", position: 1, count: 2 },
    ])
      expect(v.is(detailSourceFieldSchema, field)).toBe(true);
    for (const field of [
      "username",
      "password",
      "totp",
      "login.password",
      "identity.email",
      { custom: "" },
      { custom: "Birthday", position: 1 },
      { custom: "Birthday", position: 3, count: 2 },
      { custom: "Birthday", value: "1990-04-01" },
    ])
      expect(v.is(detailSourceFieldSchema, field)).toBe(false);
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

describe("settings change causes (ADR 0025)", () => {
  const same = (snapshot: SettingsSnapshot) => snapshot;

  it("records a save as settings-save", async () => {
    const memory = memoryStorage();
    const store = createSettingsStore(memory.storage);
    expect(await store.handle(save(0))).toMatchObject({
      ok: true,
      snapshot: { revision: 1, changes: [{ revision: 1, cause: "settings-save" }] },
    });
    expect(memory.value).toMatchObject({ changes: [{ revision: 1, cause: "settings-save" }] });
  });

  it("records an update's cause, which a mutation cannot drop or rewrite", async () => {
    const memory = memoryStorage();
    const store = createSettingsStore(memory.storage);
    await store.update(undefined, "vault-added", same);
    const dropped = await store.update(undefined, "vault-sync", (snapshot) => {
      const { changes: _changes, ...rest } = snapshot;
      return rest;
    });
    expect(dropped.changes).toEqual([
      { revision: 1, cause: "vault-added" },
      { revision: 2, cause: "vault-sync" },
    ]);
    const rewritten = await store.update(undefined, "field-review", (snapshot) => ({
      ...snapshot,
      changes: [{ revision: 2, cause: "settings-save" }],
    }));
    expect(rewritten.changes).toEqual([
      { revision: 1, cause: "vault-added" },
      { revision: 2, cause: "vault-sync" },
      { revision: 3, cause: "field-review" },
    ]);
    expect(memory.value).toMatchObject({ revision: 3, changes: rewritten.changes });
  });

  it("keeps only the newest causes", async () => {
    const memory = memoryStorage();
    const store = createSettingsStore(memory.storage);
    await store.update(undefined, "vault-added", same);
    for (let index = 0; index < SETTINGS_CHANGE_HISTORY; index++)
      // oxlint-disable-next-line no-await-in-loop -- each update advances one revision
      await store.update(undefined, "automatic-vault-sync", same);
    const snapshot = await store.read();
    expect(snapshot.revision).toBe(SETTINGS_CHANGE_HISTORY + 1);
    expect(snapshot.changes).toHaveLength(SETTINGS_CHANGE_HISTORY);
    expect(snapshot.changes![0]).toEqual({ revision: 2, cause: "automatic-vault-sync" });
    expect(snapshot.changes!.at(-1)).toEqual({
      revision: SETTINGS_CHANGE_HISTORY + 1,
      cause: "automatic-vault-sync",
    });
    // The history covers every revision after 1, but not revision 1 itself.
    expect(await store.handle(save(1))).toMatchObject({
      ok: false,
      error: { code: "revision-conflict", causes: ["automatic-vault-sync"] },
    });
    expect(parseSettingsResponse(await store.handle(save(0)))).toMatchObject({
      ok: false,
      error: { code: "revision-conflict", causes: ["unknown", "automatic-vault-sync"] },
    });
  });

  it("names an automatic vault sync to a stale save", async () => {
    const memory = memoryStorage();
    const store = createSettingsStore(memory.storage);
    await store.handle(save(0));
    await store.update(undefined, "automatic-vault-sync", same);
    const response = await store.handle(save(1));
    expect(parseSettingsResponse(response)).toEqual({
      version: 1,
      ok: false,
      error: {
        code: "revision-conflict",
        message: expect.any(String),
        causes: ["automatic-vault-sync"],
      },
    });
    expect(memory.writes).toHaveLength(2);
  });

  it("returns each cause once, oldest first", async () => {
    const memory = memoryStorage();
    const store = createSettingsStore(memory.storage);
    await store.handle(save(0));
    await store.update(undefined, "automatic-vault-sync", same);
    await store.update(undefined, "service-sync", same);
    await store.update(undefined, "automatic-vault-sync", same);
    await store.update(undefined, "account-choice", same);
    expect(await store.handle(save(1))).toMatchObject({
      error: {
        code: "revision-conflict",
        causes: ["automatic-vault-sync", "service-sync", "account-choice"],
      },
    });
    expect(await store.handle(save(0))).toMatchObject({
      error: {
        code: "revision-conflict",
        causes: ["settings-save", "automatic-vault-sync", "service-sync", "account-choice"],
      },
    });
    expect(await store.handle(save(3))).toMatchObject({
      error: { code: "revision-conflict", causes: ["automatic-vault-sync", "account-choice"] },
    });
  });

  it("returns unknown for revisions without a recorded cause", async () => {
    const memory = memoryStorage({ version: 1, revision: 4, settings: withDefault() });
    const store = createSettingsStore(memory.storage);
    expect(await store.handle(save(2))).toMatchObject({
      error: { code: "revision-conflict", causes: ["unknown"] },
    });
    await store.update(undefined, "vault-sync", same);
    expect(await store.handle(save(2))).toMatchObject({
      error: { code: "revision-conflict", causes: ["unknown", "vault-sync"] },
    });
    expect(await store.handle(save(4))).toMatchObject({
      error: { code: "revision-conflict", causes: ["vault-sync"] },
    });
  });

  it("returns unknown when the store is behind the expected revision", async () => {
    const empty = createSettingsStore(memoryStorage().storage);
    expect(await empty.handle(save(3))).toMatchObject({
      error: { code: "revision-conflict", causes: ["unknown"] },
    });
    const memory = memoryStorage();
    const store = createSettingsStore(memory.storage);
    await store.handle(save(0));
    await store.update(undefined, "vault-added", same);
    expect(await store.handle(save(5))).toMatchObject({
      error: { code: "revision-conflict", causes: ["unknown"] },
    });
  });
});

describe("vault catalog field metadata", () => {
  const withField = (field: Record<string, unknown>) => {
    const catalog = structuredClone(DUMMY_VAULT_CATALOG);
    catalog.connections[0]!.items[0]!.fields = [field as never];
    return catalog;
  };

  it("carries raw names, kinds and Linked sources", () => {
    expect(v.is(vaultCatalogSchema, DUMMY_VAULT_CATALOG)).toBe(true);
    expect(
      v.is(
        vaultCatalogSchema,
        withField({
          id: "custom.x.0",
          label: "PIN",
          name: "PIN",
          kind: "linked",
          linkedFieldId: "login.password",
        }),
      ),
    ).toBe(true);
  });

  it("carries a value-free empty flag on built-in fields", () => {
    for (const id of ["login.password", "login.totp-code"])
      expect(
        v.is(
          vaultCatalogSchema,
          withField({ id, label: "Password", name: null, kind: "hidden", empty: true }),
        ),
      ).toBe(true);
    for (const empty of [false, "true", 1, null])
      expect(
        v.is(
          vaultCatalogSchema,
          withField({ id: "login.password", label: "Password", name: null, kind: "hidden", empty }),
        ),
      ).toBe(false);
  });

  it.each([
    ["an empty name", { name: "" }],
    ["a name over 200 characters", { name: "x".repeat(201) }],
    ["a missing name", { name: undefined }],
    ["a missing kind", { kind: undefined }],
    ["an unknown kind", { kind: "password" }],
  ])("rejects %s", (_label, change) => {
    const field = { id: "custom.x.0", label: "PIN", name: "PIN", kind: "text", ...change };
    for (const key of Object.keys(field))
      if (field[key as keyof typeof field] === undefined) delete field[key as keyof typeof field];
    expect(v.is(vaultCatalogSchema, withField(field))).toBe(false);
  });
});
