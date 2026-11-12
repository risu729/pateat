import {
  createSettingsStore,
  type LocalSettings,
  type SettingsSnapshot,
  type SyncSettingsState,
  type VaultCatalog,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ServiceConnection } from "./runtime";
import {
  createSettingsSync,
  mergeSyncedSettings,
  refreshDisplayNames,
  syncedSettings,
} from "./settings-sync";
import type { ServiceTransport, SettingsResult } from "./transport";
import { registerAfterFirst } from "../../test/service/settings-sync/after-first";
import { registerVaultPolicy } from "../../test/service/settings-sync/vault-policy";
import { registerDetailLinks } from "../../test/service/settings-sync/detail-links";

// Synthetic service, credential and vault references only.

const SERVICE = "https://pateat.example.com";
const DEVICE = "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41";
const PROFILE = "00000000-0000-4000-8000-000000000010";
const OTHER_PROFILE = "00000000-0000-4000-8000-000000000011";
const OTHER_DEVICE = "7a2e4d2f-6e1c-4b63-8e66-4e8b9f1f3c52";
const CREDENTIAL = `pateat_device_${"C".repeat(43)}`;
const CONNECTION: ServiceConnection = {
  origin: SERVICE,
  deviceId: DEVICE,
  credential: CREDENTIAL,
  rejected: false,
};
const USER = "00000000-0000-4000-8000-000000000001";

const account = (origin: string, itemId = "item-1") => ({
  origin,
  provider: "bitwarden",
  server: "cloud-us",
  userId: USER,
  itemId,
});
const binding = (origin: string, field: "password" | "totp" = "password") => ({
  recipeId: "bank-signin",
  origin,
  provider: "bitwarden",
  server: "cloud-us",
  userId: USER,
  itemId: "item-1",
  itemName: "Example Bank",
  slots: [{ slot: "password", field }],
});
const site = (hostname: string) => ({ hostname, includeSubdomains: false });
const localConnection = { connectionId: "connection-1", enabled: true };
const settingsOf = (parts: Partial<LocalSettings> = {}): LocalSettings => ({
  connections: [],
  accountPolicies: [],
  itemPolicies: [],
  customFieldReviews: [],
  excludedSites: [],
  passkeyBrowserSites: [],
  repromptSites: [],
  allowedSites: [],
  allowedSitesEnabled: false,
  siteDefaults: [],
  bindings: [],
  detailLinks: [],
  ...parts,
});
const state = (revision: number, settings: LocalSettings | null): SyncSettingsState => ({
  version: 1,
  profileId: PROFILE,
  revision,
  settings,
});

function setup(
  options: {
    local?: LocalSettings;
    service?: SyncSettingsState;
    base?: unknown;
    deferred?: () => boolean;
    now?: () => number;
    catalog?: () => Promise<VaultCatalog | undefined>;
  } = {},
) {
  let stored: SettingsSnapshot | undefined = options.local
    ? { version: 1, revision: 7, settings: options.local }
    : undefined;
  const store = createSettingsStore(
    {
      read: async () => structuredClone(stored),
      write: async (snapshot) => {
        stored = structuredClone(snapshot) as SettingsSnapshot;
      },
    },
    { connections: [] },
  );
  let service = options.service ?? state(0, null);
  // The write ID of this device's last stored write, as the service answers it.
  let written: string | undefined;
  const answer = () => structuredClone({ ...service, ...(written ? { written } : {}) });
  const transport = {
    settings: vi.fn<ServiceTransport["settings"]>(async (): Promise<SettingsResult> => ({
      kind: "state",
      state: answer(),
    })),
    saveSettings: vi.fn<ServiceTransport["saveSettings"]>(async (_, __, write) => {
      if (write.expectedRevision !== service.revision)
        return { kind: "conflict", current: answer() };
      service = { ...state(service.revision + 1, write.settings), profileId: service.profileId };
      written = write.writeId;
      return { kind: "state", state: answer() };
    }),
  };
  let base = options.base;
  const storage = {
    read: vi.fn(async () => structuredClone(base)),
    write: vi.fn(async (value: unknown) => {
      base = structuredClone(value);
    }),
    clear: vi.fn(async () => {
      base = undefined;
    }),
  };
  let since: unknown;
  const hold = {
    read: vi.fn(async () => since),
    write: vi.fn(async (value: number) => {
      since = value;
    }),
    clear: vi.fn(async () => {
      since = undefined;
    }),
  };
  const applied = vi.fn();
  // A new instance over the same storage stands for a restarted service worker.
  const start = () =>
    createSettingsSync({
      transport,
      settings: store,
      storage,
      hold,
      applied,
      ...(options.deferred ? { deferred: options.deferred } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.catalog ? { catalog: options.catalog } : {}),
    });
  return {
    sync: start(),
    restart: start,
    hold,
    store,
    transport,
    storage,
    applied,
    local: () => stored,
    service: () => service,
    base: () => base as { revision: number; settings: LocalSettings } | undefined,
    setService: (next: SyncSettingsState) => {
      service = next;
    },
  };
}
const never = () => false;
const baseOf = (
  revision: number,
  settings: LocalSettings,
  deviceId = DEVICE,
  local: LocalSettings = settings,
) => ({ version: 1, origin: SERVICE, deviceId, profileId: PROFILE, revision, settings, local });

export type SettingsSyncFixtures = {
  setup: typeof setup;
  localConnection: typeof localConnection;
  state: typeof state;
  baseOf: typeof baseOf;
  CONNECTION: typeof CONNECTION;
  never: typeof never;
  account: typeof account;
  binding: typeof binding;
  settingsOf: typeof settingsOf;
  site: typeof site;
  PROFILE: typeof PROFILE;
  OTHER_PROFILE: typeof OTHER_PROFILE;
};

describe("settings sync on a new pairing", () => {
  it("seeds a service that has never stored settings from this device", async () => {
    const local = settingsOf({
      connections: [localConnection],
      excludedSites: [site("intranet.example")],
      siteDefaults: [account("https://bank.example")],
      bindings: [binding("https://bank.example")],
    });
    const { sync, service, base, local: after, applied } = setup({ local });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    // Connections name device-local IDs; they never leave the device.
    const uploaded = settingsOf({
      excludedSites: [site("intranet.example")],
      siteDefaults: [account("https://bank.example")],
      bindings: [binding("https://bank.example")],
    });
    expect(service()).toEqual(state(1, uploaded));
    expect(base()).toMatchObject({ revision: 1, settings: uploaded });
    expect(after()?.revision).toBe(7);
    expect(applied).not.toHaveBeenCalled();
  });

  it("stores nothing on the service when there is nothing to sync", async () => {
    const { sync, transport, base } = setup({
      local: settingsOf({ connections: [localConnection] }),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(base()).toMatchObject({ revision: 0 });
  });

  it("adopts an initialized selected profile without importing prior local policy", async () => {
    const local = settingsOf({
      connections: [localConnection],
      excludedSites: [site("local-only.example")],
      siteDefaults: [
        account("https://bank.example", "item-local"),
        account("https://shop.example", "item-3"),
      ],
    });
    const remote = settingsOf({
      excludedSites: [site("intranet.example")],
      siteDefaults: [account("https://bank.example"), account("https://shop.example")],
      bindings: [binding("https://bank.example")],
    });
    const { sync, service, local: after, applied } = setup({ local, service: state(3, remote) });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    const merged = {
      excludedSites: [site("intranet.example")],
      repromptSites: [],
      allowedSites: [],
      allowedSitesEnabled: false,
      passkeyBrowserSites: [],
      siteDefaults: [account("https://bank.example"), account("https://shop.example")],
      bindings: [binding("https://bank.example")],
      detailLinks: [],
    };
    expect(service()).toEqual(state(3, settingsOf(merged)));
    expect(after()?.revision).toBe(8);
    expect(after()?.settings).toEqual(settingsOf({ connections: [localConnection], ...merged }));
    // A settings page save drafted before the merge names it (ADR 0025).
    expect(after()?.changes).toEqual([{ revision: 8, cause: "service-sync" }]);
    expect(applied).toHaveBeenCalledOnce();
  });

  it("keeps this device's bindings when it adopts a profile's site settings", async () => {
    // Bindings belong to the owner, not to a profile (ADR 0076).
    const local = settingsOf({
      excludedSites: [site("local-only.example")],
      bindings: [binding("https://local.example")],
    });
    const remote = settingsOf({
      excludedSites: [site("intranet.example")],
      bindings: [binding("https://bank.example")],
    });
    const { sync, service, local: after } = setup({ local, service: state(3, remote) });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    const merged = {
      excludedSites: [site("intranet.example")],
      repromptSites: [],
      allowedSites: [],
      allowedSitesEnabled: false,
      passkeyBrowserSites: [],
      siteDefaults: [],
      bindings: [binding("https://bank.example"), binding("https://local.example")],
      detailLinks: [],
    };
    expect(service()).toEqual(state(4, settingsOf(merged)));
    expect(after()?.settings).toEqual(settingsOf(merged));
  });

  it("uploads this device's site settings to a profile created for it", async () => {
    const local = settingsOf({
      excludedSites: [site("local-only.example")],
      siteDefaults: [account("https://bank.example")],
    });
    // A profile created while pairing has no settings of its own yet; the bindings
    // already on the service are the owner's.
    const remote = settingsOf({ bindings: [binding("https://bank.example")] });
    const {
      sync,
      service,
      local: after,
    } = setup({
      local,
      service: { ...state(3, remote), newProfile: true },
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    const merged = { ...local, bindings: [binding("https://bank.example")] };
    expect(service()).toEqual(state(4, merged));
    expect(after()?.settings).toEqual(merged);
  });

  it("ignores the base of another pairing", async () => {
    const { sync, local: after } = setup({
      local: settingsOf({ excludedSites: [site("local-only.example")] }),
      service: state(3, settingsOf({ excludedSites: [site("intranet.example")] })),
      // This base would delete the local entry if it were used.
      base: baseOf(3, settingsOf({ excludedSites: [site("local-only.example")] }), OTHER_DEVICE),
    });
    await sync.run(CONNECTION, never);
    expect(after()?.settings.excludedSites).toEqual([site("intranet.example")]);
  });

  it("removes nothing when the service went back to an older revision", async () => {
    const agreed = settingsOf({ excludedSites: [site("intranet.example")] });
    for (const service of [state(0, null), state(2, settingsOf())]) {
      const {
        sync,
        local: after,
        service: now,
      } = setup({
        local: agreed,
        service,
        base: baseOf(9, agreed),
      });
      // oxlint-disable-next-line no-await-in-loop -- independent setups
      expect(await sync.run(CONNECTION, never)).toBe("synced");
      expect(after()?.settings.excludedSites).toEqual([site("intranet.example")]);
      expect(now().settings?.excludedSites).toEqual([site("intranet.example")]);
    }
  });
});

describe("settings sync after the first", () => {
  const agreed = settingsOf({
    excludedSites: [site("intranet.example")],
    siteDefaults: [account("https://bank.example")],
    bindings: [binding("https://bank.example")],
  });

  registerAfterFirst({
    setup,
    agreed,
    localConnection,
    state,
    baseOf,
    CONNECTION,
    never,
    account,
    binding,
    settingsOf,
    site,
    PROFILE,
  });
});

describe("vault policy (ADR 0023)", () => {
  const owner = { provider: "bitwarden", server: "cloud-us", userId: USER };
  const demo = { provider: "dummy", server: "cloud-us", userId: "demo-personal-account" };
  const accountPolicy = (
    enabled = true,
    who: { provider: string; server: string; userId: string } = owner,
  ): LocalSettings["accountPolicies"][number] => ({
    ...who,
    accountName: "risu",
    enabled,
    selection: { mode: "all" },
  });
  const itemPolicy = (
    itemId: string,
    overrides: Partial<LocalSettings["itemPolicies"][number]> = {},
  ): LocalSettings["itemPolicies"][number] => ({
    ...owner,
    itemId,
    itemName: "Example Bank",
    selected: false,
    excluded: false,
    excludedFields: [],
    ...overrides,
  });
  const review = (
    itemId: string,
    digit = "a",
    who: { provider: string; server: string; userId: string } = owner,
  ): LocalSettings["customFieldReviews"][number] => ({
    ...who,
    itemId,
    evidence: `bitwarden-v1:sha256:${digit.repeat(64)}`,
    revisionDate: "2026-10-11T07:10:03.1234567Z",
  });
  const demoEntries = {
    accountPolicies: [accountPolicy(true, demo)],
    itemPolicies: [{ ...itemPolicy("primary"), ...demo, excluded: true }],
    customFieldReviews: [review("primary", "f", demo)],
  };

  registerVaultPolicy({
    settingsOf,
    localConnection,
    accountPolicy,
    demoEntries,
    itemPolicy,
    review,
    setup,
    CONNECTION,
    never,
    state,
    owner,
    binding,
    baseOf,
    demo,
  });
});

describe("display names from this device's catalog", () => {
  const OTHER_USER = "00000000-0000-4000-8000-000000000002";
  const vault = (
    id: string,
    userId: string | undefined,
    label = "risu",
  ): VaultCatalog["connections"][number] => ({
    id,
    label,
    provider: "bitwarden",
    server: "cloud-us",
    ...(userId ? { userId } : {}),
    state: userId ? "ready" : "unavailable",
    groups: [],
    items: userId
      ? [{ id: "item-1", label: "Example Bank", allowedOrigins: [], groupIds: [], fields: [] }]
      : [],
  });
  const catalogOf = (...connections: VaultCatalog["connections"]): VaultCatalog => ({
    connections,
  });
  const unnamed = settingsOf({
    siteDefaults: [account("https://bank.example")],
    // A binding made by AI generation, whose item has been renamed since; another device
    // may still hold the old label, so the stored name is kept.
    bindings: [{ ...binding("https://bank.example"), itemName: "Old name" }],
  });
  const { slots, ...owner } = binding("https://bank.example");
  const named = settingsOf({
    siteDefaults: [
      { ...account("https://bank.example"), itemName: "Example Bank", accountName: "risu" },
    ],
    // In the schema's key order, as the service and the settings store return it.
    bindings: [{ ...owner, itemName: "Old name", accountName: "risu", slots }],
  });

  it("names entries of an account connected here once, then writes nothing", async () => {
    const catalog = vi.fn(async () => catalogOf(vault("connection-1", USER)));
    const {
      sync,
      transport,
      service,
      local: after,
      applied,
    } = setup({
      local: { ...unnamed, connections: [localConnection] },
      service: state(4, unnamed),
      base: baseOf(4, unnamed),
      catalog,
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(service()).toEqual(state(5, named));
    expect(syncedSettings(after()!.settings)).toEqual(syncedSettings(named));
    expect(after()!.revision).toBe(8);
    expect(applied).toHaveBeenCalledOnce();

    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).toHaveBeenCalledOnce();
    expect(after()!.revision).toBe(8);
    expect(applied).toHaveBeenCalledOnce();
    // The second sync finds every entry named and does not build the catalog.
    expect(catalog).toHaveBeenCalledOnce();
  });

  it("does not read the catalog when every entry is named", async () => {
    const catalog = vi.fn(async () => catalogOf(vault("connection-1", USER, "Desktop")));
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: named,
      service: state(4, named),
      base: baseOf(4, named),
      catalog,
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(catalog).not.toHaveBeenCalled();
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()!.revision).toBe(7);
  });

  it.each<[string, VaultCatalog]>([
    ["not connected here", catalogOf(vault("connection-1", OTHER_USER))],
    [
      "connected twice",
      catalogOf(vault("connection-1", USER), vault("connection-2", USER, "risu again")),
    ],
    ["locked", catalogOf(vault("connection-1", undefined))],
    ["absent from an empty catalog", catalogOf()],
  ])("leaves the names of an account %s", async (_label, catalog) => {
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: unnamed,
      service: state(4, unnamed),
      base: baseOf(4, unnamed),
      catalog: async () => catalog,
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()!.revision).toBe(7);
  });

  it("leaves names alone when the catalog cannot be read", async () => {
    const { sync, transport } = setup({
      local: unnamed,
      service: state(4, unnamed),
      base: baseOf(4, unnamed),
      catalog: async () => {
        throw new Error("Synthetic catalog failure");
      },
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
  });

  it("keeps an account name another device gave and an item missing from the vault", () => {
    const synced = syncedSettings(
      settingsOf({
        siteDefaults: [
          { ...account("https://bank.example"), accountName: "Laptop vault" },
          account("https://shop.example", "item-gone"),
        ],
      }),
    );
    const refreshed = refreshDisplayNames(synced, catalogOf(vault("connection-1", USER)));
    // Another device's item label is kept too, even where this vault's label differs.
    expect(
      refreshDisplayNames(
        syncedSettings(
          settingsOf({
            siteDefaults: [{ ...account("https://bank.example"), itemName: "New name" }],
          }),
        ),
        catalogOf(vault("connection-1", USER)),
      ).siteDefaults,
    ).toEqual([{ ...account("https://bank.example"), itemName: "New name", accountName: "risu" }]);
    expect(refreshed.siteDefaults).toEqual([
      { ...account("https://bank.example"), itemName: "Example Bank", accountName: "Laptop vault" },
      { ...account("https://shop.example", "item-gone"), accountName: "risu" },
    ]);
    // Unchanged entries keep their identity.
    expect(refreshDisplayNames(refreshed, catalogOf(vault("connection-1", USER)))).toEqual(
      refreshed,
    );
    expect(
      refreshDisplayNames(refreshed, catalogOf(vault("connection-1", USER))).siteDefaults[0],
    ).toBe(refreshed.siteDefaults[0]);
  });
});

describe("device profile switches", () => {
  it("never uploads the old profile cache after a deferred switch or a worker restart", async () => {
    let running = true;
    const old = settingsOf({
      excludedSites: [site("old-profile.example")],
      siteDefaults: [account("https://old.example")],
    });
    const next = settingsOf({ excludedSites: [site("new-profile.example")] });
    const h = setup({
      local: { ...old, connections: [localConnection] },
      service: { ...state(8, next), profileId: OTHER_PROFILE },
      base: baseOf(7, old),
      deferred: () => running,
    });
    expect(await h.sync.run(CONNECTION, never)).toBe("busy");
    expect(h.transport.saveSettings).not.toHaveBeenCalled();
    expect(h.local()?.settings.excludedSites).toEqual(old.excludedSites);
    // Keeping the prior identity prevents this cache becoming a new profile's edits.
    expect(h.base()).toMatchObject({ profileId: PROFILE });
    expect(await h.restart().run(CONNECTION, never)).toBe("busy");
    expect(h.transport.saveSettings).not.toHaveBeenCalled();
    running = false;
    expect(await h.restart().run(CONNECTION, never)).toBe("synced");
    expect(h.transport.saveSettings).not.toHaveBeenCalled();
    expect(h.local()?.settings).toEqual({ ...next, connections: [localConnection] });
    expect(h.base()).toMatchObject({ profileId: OTHER_PROFILE });
  });
});

describe("a profile switch whose final base was lost", () => {
  it("keeps the person's later edit once the switch's local write landed", async () => {
    const old = settingsOf({ excludedSites: [site("old-profile.example")] });
    const next = settingsOf({ excludedSites: [site("new-profile.example")] });
    const h = setup({
      local: old,
      service: { ...state(8, next), profileId: OTHER_PROFILE },
      base: baseOf(7, old),
    });
    // The record before the local write lands; the one after it is lost.
    const write = h.storage.write.getMockImplementation()!;
    h.storage.write.mockImplementationOnce(write).mockRejectedValueOnce(new Error("lost"));
    expect(await h.sync.run(CONNECTION, never)).toBe("synced");
    expect(h.local()?.settings).toEqual(next);
    expect(h.base()).toMatchObject({ profileId: PROFILE });

    await h.store.update(undefined, "settings-save", (current) => ({
      ...current,
      settings: {
        ...current.settings,
        excludedSites: [...current.settings.excludedSites, site("person.example")],
      },
    }));
    expect(await h.restart().run(CONNECTION, never)).toBe("synced");
    const sites = [site("new-profile.example"), site("person.example")];
    expect(h.service().settings?.excludedSites).toEqual(sites);
    expect(h.local()?.settings.excludedSites).toEqual(sites);
    expect(h.base()).toMatchObject({ profileId: OTHER_PROFILE });
  });
});

describe("profile switch with refreshed account names", () => {
  it("retains the old profile marker through an upload and deferred local replacement", async () => {
    let running = true;
    const old = settingsOf({ excludedSites: [site("old-profile.example")] });
    const remote = settingsOf({ siteDefaults: [account("https://bank.example")] });
    const h = setup({
      local: old,
      service: { ...state(8, remote), profileId: OTHER_PROFILE },
      base: baseOf(7, old),
      deferred: () => running,
      catalog: async () => ({
        connections: [
          {
            id: "connection-1",
            label: "Synthetic account",
            provider: "bitwarden",
            server: "cloud-us",
            userId: USER,
            state: "ready",
            groups: [],
            items: [
              {
                id: "item-1",
                label: "Synthetic bank",
                allowedOrigins: [],
                groupIds: [],
                fields: [],
              },
            ],
          },
        ],
      }),
    });
    expect(await h.sync.run(CONNECTION, never)).toBe("busy");
    expect(h.transport.saveSettings).toHaveBeenCalledOnce();
    expect(h.base()).toMatchObject({ profileId: PROFILE });
    expect(h.service().settings?.excludedSites).toEqual([]);
    expect(await h.restart().run(CONNECTION, never)).toBe("busy");
    expect(h.service().settings?.excludedSites).toEqual([]);
    running = false;
    expect(await h.restart().run(CONNECTION, never)).toBe("synced");
    expect(h.local()?.settings.excludedSites).toEqual([]);
    expect(h.local()?.settings.siteDefaults).toEqual([
      expect.objectContaining({ itemName: "Synthetic bank" }),
    ]);
    expect(h.base()).toMatchObject({ profileId: OTHER_PROFILE });
  });
});

describe("moves to a profile no device has written yet", () => {
  it("keeps this device's entries when the move lands during an upload", async () => {
    const agreed = settingsOf({ excludedSites: [site("agreed.example")] });
    const local = settingsOf({
      excludedSites: [site("agreed.example"), site("local-edit.example")],
    });
    const h = setup({ local, service: state(4, agreed), base: baseOf(4, agreed) });
    // The owner moves the device before its upload lands.
    h.transport.saveSettings.mockImplementationOnce(async () => {
      const moved: SyncSettingsState = {
        ...state(5, settingsOf()),
        profileId: OTHER_PROFILE,
        newProfile: true,
      };
      h.setService(moved);
      return { kind: "conflict", current: structuredClone(moved) };
    });
    expect(await h.sync.run(CONNECTION, never)).toBe("synced");
    expect(h.service().settings?.excludedSites).toEqual(local.excludedSites);
    expect(h.local()?.settings.excludedSites).toEqual(local.excludedSites);
  });

  it("does not bring back a binding removed while this device was away", async () => {
    const agreed = settingsOf({
      bindings: [binding("https://kept.example"), binding("https://removed.example")],
    });
    const h = setup({
      local: agreed,
      // Another device removed one binding, then this device moved to a new profile.
      service: {
        ...state(6, settingsOf({ bindings: [binding("https://kept.example")] })),
        profileId: OTHER_PROFILE,
        newProfile: true,
      },
      base: baseOf(4, agreed),
    });
    expect(await h.sync.run(CONNECTION, never)).toBe("synced");
    expect(h.local()?.settings.bindings).toEqual([binding("https://kept.example")]);
    expect(h.service().settings?.bindings).toEqual([binding("https://kept.example")]);
  });
});

it("changes nothing when the merge base cannot be read", async () => {
  const local = settingsOf({ excludedSites: [site("local-only.example")] });
  const h = setup({
    local,
    service: state(3, settingsOf({ excludedSites: [site("intranet.example")] })),
  });
  h.storage.read.mockRejectedValueOnce(new Error("synthetic storage failure"));
  expect(await h.sync.run(CONNECTION, never)).toBe("storage-unavailable");
  expect(h.transport.saveSettings).not.toHaveBeenCalled();
  expect(h.local()?.settings.excludedSites).toEqual(local.excludedSites);
});

describe("personal-detail links (ADR 0061)", () => {
  // Links reference vault items and fields only; synthetic IDs and field names.
  const link = (
    origin: string,
    detail: "birth-date" | "card-code" | "secret-answer" = "birth-date",
    source: { itemId: string; field: "card.code" | { custom: string } } = {
      itemId: "identity-1",
      field: { custom: "Birth date" },
    },
    question?: string,
  ) => ({
    origin,
    provider: "bitwarden",
    server: "cloud-us",
    userId: USER,
    itemId: "item-1",
    detail,
    source,
    ...(question === undefined ? {} : { question }),
  });
  const birthDate = link("https://bank.example");
  const cardCode = link("https://bank.example", "card-code", {
    itemId: "card-1",
    field: "card.code",
  });

  registerDetailLinks({
    link,
    setup,
    settingsOf,
    state,
    baseOf,
    CONNECTION,
    never,
    localConnection,
    birthDate,
    cardCode,
    site,
    OTHER_PROFILE,
  });
});

describe("allowed sites (ADR 0077)", () => {
  const agreed = settingsOf({
    excludedSites: [site("intranet.example")],
    allowedSites: [site("bank.example")],
    allowedSitesEnabled: true,
  });

  it("merges allowed sites like exclusions, entry by entry", () => {
    const base = syncedSettings(agreed);
    const local = syncedSettings({
      ...agreed,
      allowedSites: [site("bank.example"), site("local.example")],
    });
    const service = syncedSettings({
      ...agreed,
      allowedSites: [site("service.example")],
    });
    expect(
      mergeSyncedSettings({ service: base, local: base }, local, service).allowedSites,
    ).toEqual([site("service.example"), site("local.example")]);
  });

  it("merges the switch like an entry: the service's change wins, then a local one", () => {
    const base = syncedSettings(agreed);
    const off = syncedSettings({ ...agreed, allowedSitesEnabled: false });
    const merge = (local: typeof base, service: typeof base) =>
      mergeSyncedSettings({ service: base, local: base }, local, service).allowedSitesEnabled;
    expect(merge(off, base)).toBe(false);
    expect(merge(base, off)).toBe(false);
    const offBase = { service: off, local: off };
    // From off: turning it on locally stands while the service stayed off, and so does the service's.
    expect(mergeSyncedSettings(offBase, base, off).allowedSitesEnabled).toBe(true);
    expect(mergeSyncedSettings(offBase, off, base).allowedSitesEnabled).toBe(true);
  });

  it("keeps the list when the switch is turned off on another device", async () => {
    const turnedOff = { ...agreed, allowedSitesEnabled: false };
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: { ...agreed, connections: [localConnection] },
      service: state(5, turnedOff),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()?.settings).toMatchObject({
      allowedSites: [site("bank.example")],
      allowedSitesEnabled: false,
    });
  });

  // A device that pairs with an existing profile takes its allowed sites and switch,
  // both when the profile has them on and when it has none (ADR 0076).
  it.each([
    settingsOf({ allowedSites: [site("bank.example")], allowedSitesEnabled: true }),
    settingsOf({ excludedSites: [site("intranet.example")] }),
  ])("adopts a profile's allowed sites in place of this device's %#", async (remote) => {
    const local = settingsOf({
      allowedSites: [site("local-only.example")],
      allowedSitesEnabled: true,
    });
    const { sync, local: after } = setup({ local, service: state(3, remote) });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings).toMatchObject({
      allowedSites: remote.allowedSites,
      allowedSitesEnabled: remote.allowedSitesEnabled,
    });
  });

  it("treats settings without allowed sites as an empty list that is off", async () => {
    const bare: LocalSettings = {
      connections: [],
      accountPolicies: [],
      itemPolicies: [],
      customFieldReviews: [],
      excludedSites: [],
      passkeyBrowserSites: [],
      repromptSites: [],
      siteDefaults: [],
      bindings: [],
    };
    expect(syncedSettings(bare)).toMatchObject({ allowedSites: [], allowedSitesEnabled: false });
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: bare,
      service: state(4, bare),
      base: baseOf(4, bare),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    // Nothing changed, so nothing is written on either side.
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()?.revision).toBe(7);
  });
});
