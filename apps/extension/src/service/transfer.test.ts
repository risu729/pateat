import {
  createSettingsStore,
  parseLoginRecipe,
  toLoginLayout,
  type LocalSettings,
  type LoginRecipeDocument,
  type SettingsSnapshot,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { createDeviceRecipes, type DeviceRecipeStorage } from "./device-recipes";
import { createTransfer } from "./transfer";

// Synthetic accounts, sites and recipes only.

const SITE = "https://bank.example";
const USER = "00000000-0000-4000-8000-000000000001";
const owner = { provider: "bitwarden", server: "cloud-us", userId: USER };
const demo = { provider: "dummy", server: "cloud-us", userId: "demo-personal-account" };
const target = (value: string) => ({ by: "id" as const, value });
const exportRequest = { version: 1, type: "settings.export" };
const importRequest = (file: unknown, apply = true) => ({
  version: 1,
  type: "settings.import",
  file,
  apply,
});

function recipe(id: string, revision = 4, path = "/login"): LoginRecipeDocument {
  const route = parseLoginRecipe({
    version: 1,
    id,
    revision,
    origin: SITE,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill",
        path,
        fields: [
          { slot: "username", target: target("user") },
          { slot: "password", target: target("pass") },
        ],
      },
      { kind: "click", path, target: target("login"), purpose: "submit" },
    ],
    completion: [{ target: target("welcome") }],
    maxSubmissions: 1,
  });
  return {
    version: 1,
    id,
    revision,
    origin: SITE,
    layouts: [toLoginLayout(route, { key: "1000", createdAt: 1000 })],
  };
}

const site = (hostname: string) => ({ hostname, includeSubdomains: false });
const policy = (who: typeof owner, accountName: string) => ({
  ...who,
  accountName,
  enabled: true,
  selection: { mode: "all" as const },
});
const binding = (origin: string, itemId = "item-1") => ({
  recipeId: "bank-signin",
  origin,
  ...owner,
  itemId,
  itemName: "Example Bank",
  slots: [{ slot: "password", field: "password" as const }],
});
const settingsOf = (parts: Partial<LocalSettings> = {}): LocalSettings => ({
  connections: [],
  accountPolicies: [],
  itemPolicies: [],
  customFieldReviews: [],
  excludedSites: [],
  passkeyBrowserSites: [],
  repromptSites: [],
  siteDefaults: [],
  bindings: [],
  detailLinks: [],
  ...parts,
});

/** The synced settings name the allowed sites even while empty and off (ADR 0077). */
const NO_ALLOWED_SITES = { allowedSites: [], allowedSitesEnabled: false };

function setup(
  options: {
    settings?: LocalSettings;
    recipes?: StoredLoginRecipe[];
    /** The paired service's synced recipes; without them, no service is paired. */
    synced?: StoredLoginRecipe[];
  } = {},
) {
  let stored: SettingsSnapshot | undefined = options.settings
    ? { version: 1, revision: 3, settings: options.settings }
    : undefined;
  const settings = createSettingsStore(
    {
      read: async () => structuredClone(stored),
      write: async (snapshot) => {
        stored = structuredClone(snapshot) as SettingsSnapshot;
      },
    },
    { connections: [] },
  );
  let held: unknown = options.recipes ? { version: 1, recipes: options.recipes } : undefined;
  const storage: DeviceRecipeStorage = {
    read: async () => structuredClone(held),
    write: async (store) => {
      held = structuredClone(store);
    },
    clear: async () => {
      held = undefined;
    },
  };
  const device = createDeviceRecipes({
    storage,
    transport: { writeRecipe: vi.fn() },
    maxBytes: 64 * 1024,
  });
  const imported = vi.fn();
  const { synced } = options;
  const transfer = createTransfer({
    settings,
    recipes: async () => synced ?? device.list(),
    paired: async () => synced !== undefined,
    device,
    imported,
    now: () => Date.UTC(2026, 9, 23, 12),
  });
  return {
    transfer,
    imported,
    snapshot: () => stored,
    recipes: () => device.list(),
  };
}

async function exported(device: ReturnType<typeof setup>) {
  const response = await device.transfer.handle(exportRequest);
  if (!response?.ok || response.type !== "settings.export") throw new Error("No export");
  return response.file;
}

describe("export and import", () => {
  it("exports what a pairing shares and nothing of this device's own", async () => {
    const device = setup({
      settings: settingsOf({
        connections: [{ connectionId: "connection-1", enabled: true }],
        accountPolicies: [policy(owner, "risu"), policy(demo, "Demo")],
        excludedSites: [site("shop.example")],
        bindings: [binding(SITE)],
        popupPageSection: false,
      }),
      recipes: [recipe("a")],
    });
    expect(await exported(device)).toEqual({
      format: "pateat-transfer",
      version: 1,
      exportedAt: "2026-10-23T12:00:00.000Z",
      settings: settingsOf({
        ...NO_ALLOWED_SITES,
        accountPolicies: [policy(owner, "risu")],
        excludedSites: [site("shop.example")],
        bindings: [binding(SITE)],
        popupPageSection: false,
      }),
      recipes: [recipe("a")],
    });
  });

  it("imports into another device as a first pairing merges, keeping its own entries", async () => {
    const file = await exported(
      setup({
        settings: settingsOf({
          accountPolicies: [policy(owner, "From the file")],
          excludedSites: [site("shop.example")],
          bindings: [binding(SITE)],
        }),
        recipes: [recipe("a", 4), recipe("b", 2)],
      }),
    );
    const other = setup({
      settings: settingsOf({
        connections: [{ connectionId: "connection-2", enabled: true }],
        accountPolicies: [policy(owner, "Kept here"), policy(demo, "Demo")],
        excludedSites: [site("news.example")],
      }),
      // A newer copy kept here stays; an older one is replaced.
      recipes: [recipe("a", 9, "/kept"), recipe("b", 1, "/old")],
    });
    expect(await other.transfer.handle(importRequest(file))).toEqual({
      version: 1,
      ok: true,
      type: "settings.import",
      recipes: 1,
    });
    const snapshot = other.snapshot();
    expect(snapshot?.settings).toEqual(
      settingsOf({
        ...NO_ALLOWED_SITES,
        connections: [{ connectionId: "connection-2", enabled: true }],
        accountPolicies: [policy(owner, "From the file"), policy(demo, "Demo")],
        excludedSites: [site("shop.example"), site("news.example")],
        bindings: [binding(SITE)],
      }),
    );
    expect(snapshot?.changes).toEqual([{ revision: 4, cause: "settings-import" }]);
    expect(await other.recipes()).toEqual([recipe("a", 9, "/kept"), recipe("b", 2)]);
    expect(other.imported).toHaveBeenCalledTimes(1);
  });

  it("shows what an import would change before it changes anything", async () => {
    const file = await exported(
      setup({
        settings: settingsOf({
          accountPolicies: [policy(owner, "From the file")],
          excludedSites: [site("shop.example"), site("news.example")],
          bindings: [binding(SITE), binding("https://other.example", "item-2")],
          siteDefaults: [{ origin: "https://other.example", ...owner, itemId: "item-2" }],
        }),
        recipes: [recipe("a", 4), recipe("b", 2), recipe("c", 1)],
      }),
    );
    const device = setup({
      settings: settingsOf({
        accountPolicies: [policy(owner, "Kept here")],
        excludedSites: [site("news.example")],
        bindings: [binding(SITE)],
      }),
      recipes: [recipe("a", 9), recipe("b", 1)],
    });
    expect(await device.transfer.handle(importRequest(file, false))).toEqual({
      version: 1,
      ok: true,
      type: "settings.import-preview",
      sites: ["https://other.example"],
      policies: 1,
      others: 1,
      recipes: 2,
    });
    expect(device.snapshot()?.revision).toBe(3);
    expect(await device.recipes()).toEqual([recipe("a", 9), recipe("b", 1)]);
    expect(device.imported).not.toHaveBeenCalled();

    // The device's own file changes nothing.
    const own = await exported(device);
    expect(await device.transfer.handle(importRequest(own, false))).toMatchObject({
      sites: [],
      policies: 0,
      others: 0,
      recipes: 0,
    });
  });

  it("counts an item limit the file drops as a change", async () => {
    const exclusion = {
      ...owner,
      itemId: "item-1",
      itemName: "Example Bank",
      selected: false,
      excluded: true,
      excludedFields: [],
    };
    const review = {
      ...owner,
      itemId: "item-1",
      evidence: `bitwarden-v1:sha256:${"a".repeat(64)}`,
      revisionDate: "2026-10-11T07:10:03.1234567Z",
    };
    // An older export: the item's review without the exclusion made since.
    const file = await exported(setup({ settings: settingsOf({ customFieldReviews: [review] }) }));
    const device = setup({
      settings: settingsOf({ itemPolicies: [exclusion], customFieldReviews: [review] }),
    });
    expect(await device.transfer.handle(importRequest(file, false))).toMatchObject({
      policies: 1,
    });
  });

  it("refuses recipes beyond the device's limit before anything is imported", async () => {
    const many = Array.from({ length: 1_000 }, (_, index) => recipe(`r-${index}`, 1, "/l"));
    const device = setup({ settings: settingsOf(), recipes: many });
    const file = await exported(setup({ recipes: [recipe("one-more")] }));
    expect(await device.transfer.handle(importRequest(file, false))).toMatchObject({
      ok: false,
      error: "too-large",
    });
  });

  it("refuses an import while a paired device's synced recipes cannot be read", async () => {
    const file = await exported(setup({ recipes: [recipe("a")] }));
    const device = setup({ settings: settingsOf() });
    const transfer = createTransfer({
      settings: {
        read: async () => ({ version: 1, revision: 0, settings: settingsOf() }),
        update: vi.fn(),
      },
      recipes: async () => undefined,
      paired: async () => true,
      device: { list: async () => [], keep: vi.fn() },
    });
    expect(await transfer.handle(importRequest(file))).toMatchObject({
      error: "storage-unavailable",
    });
    expect(await device.recipes()).toEqual([]);
  });

  it("leaves out the recipes a paired service already holds", async () => {
    const file = await exported(setup({ recipes: [recipe("a", 7), recipe("b", 2)] }));
    const device = setup({ settings: settingsOf(), synced: [recipe("a", 3)] });
    expect(await device.transfer.handle(importRequest(file, false))).toMatchObject({
      recipes: 1,
    });
    expect(await device.transfer.handle(importRequest(file))).toMatchObject({ recipes: 1 });
    expect(await device.recipes()).toEqual([recipe("b", 2)]);
    expect(device.imported).toHaveBeenCalledTimes(1);
  });

  it("refuses settings that would be larger than a service holds", async () => {
    const bindings = (prefix: string) =>
      Array.from({ length: 400 }, (_, index) => binding(`https://${prefix}-${index}.example`));
    const file = await exported(setup({ settings: settingsOf({ bindings: bindings("file") }) }));
    const device = setup({ settings: settingsOf({ bindings: bindings("here") }) });
    expect(await device.transfer.handle(importRequest(file, false))).toMatchObject({
      ok: false,
      error: "too-large",
    });
    expect(await device.transfer.handle(importRequest(file))).toMatchObject({
      ok: false,
      error: "too-large",
    });
    expect(device.snapshot()?.revision).toBe(3);
  });

  it("refuses a file that is not an export, or one with vault connections", async () => {
    const file = await exported(setup({ recipes: [recipe("a")] }));
    const device = setup({ settings: settingsOf({ excludedSites: [site("news.example")] }) });
    for (const value of [
      undefined,
      "not json",
      { ...file, format: "other" },
      { ...file, version: 2 },
      { ...file, recipes: [recipe("a"), recipe("a")] },
      {
        ...file,
        settings: { ...file.settings, connections: [{ connectionId: "c", enabled: true }] },
      },
    ])
      // oxlint-disable-next-line no-await-in-loop -- one import after another
      expect(await device.transfer.handle(importRequest(value))).toEqual({
        version: 1,
        ok: false,
        error: "invalid-file",
      });
    expect(device.snapshot()?.revision).toBe(3);
    expect(await device.recipes()).toEqual([]);
    expect(device.imported).not.toHaveBeenCalled();
  });

  it("changes nothing when the settings cannot join this device's", async () => {
    const sites = (prefix: string) =>
      Array.from({ length: 600 }, (_, index) => site(`${prefix}-${index}.example`));
    const file = await exported(
      setup({ settings: settingsOf({ excludedSites: sites("file") }), recipes: [recipe("a")] }),
    );
    const device = setup({ settings: settingsOf({ excludedSites: sites("here") }) });
    expect(await device.transfer.handle(importRequest(file))).toMatchObject({
      ok: false,
      error: "invalid-file",
    });
    expect(device.snapshot()?.revision).toBe(3);
    expect(await device.recipes()).toEqual([]);
  });

  it("changes nothing when the recipes do not fit with the ones kept here", async () => {
    const long = (id: string) => recipe(id, 1, `/${"x".repeat(200)}`);
    const many = Array.from({ length: 150 }, (_, index) => long(`file-${index}`));
    const file = await exported(setup({ recipes: [] }));
    const device = setup({ settings: settingsOf() });
    expect(await device.transfer.handle(importRequest({ ...file, recipes: many }))).toEqual({
      version: 1,
      ok: false,
      error: "too-large",
    });
    expect(device.snapshot()?.revision).toBe(3);
    expect(await device.recipes()).toEqual([]);
  });

  it("answers an unreadable store as unavailable, and nothing else at all", async () => {
    const transfer = createTransfer({
      settings: { read: async () => Promise.reject(new Error("gone")), update: vi.fn() },
      recipes: async () => [],
      paired: async () => false,
      device: { list: vi.fn(), keep: vi.fn() },
    });
    expect(await transfer.handle(exportRequest)).toMatchObject({ error: "storage-unavailable" });
    const noRecipes = createTransfer({
      settings: {
        read: async () => ({ version: 1, revision: 0, settings: settingsOf() }),
        update: vi.fn(),
      },
      recipes: async () => undefined,
      paired: async () => false,
      device: { list: vi.fn(), keep: vi.fn() },
    });
    expect(await noRecipes.handle(exportRequest)).toMatchObject({ error: "storage-unavailable" });
    expect(await transfer.handle({ version: 1, type: "settings.get" })).toBeUndefined();
  });
});
