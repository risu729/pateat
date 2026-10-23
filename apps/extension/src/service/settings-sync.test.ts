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
  MAX_SETTINGS_DEFER_MS,
  MAX_SETTINGS_SYNC_ATTEMPTS,
  mergeSyncedSettings,
  refreshDisplayNames,
  syncedSettings,
} from "./settings-sync";
import type { ServiceTransport, SettingsResult } from "./transport";

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
  userId: USER,
  itemId,
});
const binding = (origin: string, field: "password" | "totp" = "password") => ({
  recipeId: "bank-signin",
  origin,
  provider: "bitwarden",
  userId: USER,
  itemId: "item-1",
  itemName: "Example Bank",
  slots: [{ slot: "password", field }],
});
const site = (hostname: string) => ({ hostname, includeSubdomains: false });
const localConnection = {
  connectionId: "connection-1",
  enabled: true,
  selection: { mode: "all" as const, groupIds: [], itemIds: [] },
  excludedItemIds: [],
  excludedFields: [],
};
const settingsOf = (parts: Partial<LocalSettings> = {}): LocalSettings => ({
  connections: [],
  excludedSites: [],
  repromptSites: [],
  allowedSites: [],
  allowedSitesEnabled: false,
  siteDefaults: [],
  bindings: [],
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
  const transport = {
    settings: vi.fn<ServiceTransport["settings"]>(async (): Promise<SettingsResult> => ({
      kind: "state",
      state: structuredClone(service),
    })),
    saveSettings: vi.fn<ServiceTransport["saveSettings"]>(async (_, __, write) => {
      if (write.expectedRevision !== service.revision)
        return { kind: "conflict", current: structuredClone(service) };
      service = { ...state(service.revision + 1, write.settings), profileId: service.profileId };
      return { kind: "state", state: structuredClone(service) };
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
      siteDefaults: [account("https://bank.example"), account("https://shop.example")],
      bindings: [binding("https://bank.example")],
    };
    expect(service()).toEqual(state(3, { connections: [], ...merged }));
    expect(after()?.revision).toBe(8);
    expect(after()?.settings).toEqual({ connections: [localConnection], ...merged });
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
      siteDefaults: [],
      bindings: [binding("https://bank.example"), binding("https://local.example")],
    };
    expect(service()).toEqual(state(4, { connections: [], ...merged }));
    expect(after()?.settings).toEqual({ connections: [], ...merged });
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

  it("changes nothing when neither side changed", async () => {
    const {
      sync,
      transport,
      local: after,
      applied,
    } = setup({
      local: { ...agreed, connections: [localConnection] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    // No revision bump, so running login attempts are not stopped.
    expect(after()?.revision).toBe(7);
    expect(applied).not.toHaveBeenCalled();
  });

  it("uploads local changes and applies service changes in one merge", async () => {
    const {
      sync,
      service,
      local: after,
      base,
    } = setup({
      local: {
        ...agreed,
        // Added on this device, for example by an automatic account choice.
        siteDefaults: [...agreed.siteDefaults, account("https://shop.example")],
      },
      service: state(5, {
        ...agreed,
        // Removed on the service.
        excludedSites: [],
        repromptSites: [],
        bindings: [...agreed.bindings, binding("https://shop.example")],
      }),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    const merged = settingsOf({
      excludedSites: [],
      repromptSites: [],
      siteDefaults: [account("https://bank.example"), account("https://shop.example")],
      bindings: [binding("https://bank.example"), binding("https://shop.example")],
    });
    expect(service().revision).toBe(6);
    expect(syncedSettings(service().settings!)).toEqual(syncedSettings(merged));
    expect(syncedSettings(after()!.settings)).toEqual(syncedSettings(merged));
    expect(base()).toMatchObject({ revision: 6 });
  });

  it("lets the service win when both sides changed one entry", () => {
    const base = syncedSettings(agreed);
    const local = syncedSettings({
      ...agreed,
      siteDefaults: [account("https://bank.example", "item-local")],
      bindings: [],
    });
    const service = syncedSettings({
      ...agreed,
      siteDefaults: [account("https://bank.example", "item-service")],
      bindings: [binding("https://bank.example", "totp")],
    });
    expect(mergeSyncedSettings({ service: base, local: base }, local, service)).toEqual({
      excludedSites: [site("intranet.example")],
      repromptSites: [],
      allowedSites: [],
      allowedSitesEnabled: false,
      siteDefaults: [account("https://bank.example", "item-service")],
      bindings: [binding("https://bank.example", "totp")],
    });
  });

  it("merges the sites that ask for the master password per site, like exclusions", () => {
    const base = syncedSettings({ ...agreed, repromptSites: [site("bank.example")] });
    // This device stopped asking on bank.example and started on shop.example; the service
    // started on mail.example.
    const local = syncedSettings({ ...agreed, repromptSites: [site("shop.example")] });
    const service = syncedSettings({
      ...agreed,
      repromptSites: [site("bank.example"), site("mail.example")],
    });
    expect(
      mergeSyncedSettings({ service: base, local: base }, local, service).repromptSites,
    ).toEqual([site("mail.example"), site("shop.example")]);
  });

  it("applies a default that differs only in its item name once, then stays settled", async () => {
    const named = { ...account("https://bank.example"), itemName: "Example Bank" };
    const serviceSettings = { ...agreed, siteDefaults: [named] };
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: agreed,
      service: state(5, serviceSettings),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()!.settings.siteDefaults).toEqual([named]);
    const revision = after()!.revision;
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()!.revision).toBe(revision);
  });

  it("removes an entry deleted on this device from the service", async () => {
    const { sync, service } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    await sync.run(CONNECTION, never);
    expect(service().settings?.excludedSites).toEqual([]);
  });

  it("merges again when the service changed during the write", async () => {
    const { sync, transport, service, setService } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    transport.settings.mockImplementationOnce(async () => {
      const read = { kind: "state" as const, state: state(4, agreed) };
      setService(state(5, { ...agreed, bindings: [] }));
      return read;
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).toHaveBeenCalledTimes(2);
    expect(service()).toEqual(
      state(6, { ...agreed, excludedSites: [], repromptSites: [], bindings: [] }),
    );
  });

  it("merges again when local settings changed during the sync", async () => {
    const {
      sync,
      store,
      transport,
      local: after,
    } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
    });
    transport.settings.mockImplementationOnce(async () => {
      // An automatic account choice saved while the service was being read.
      await store.update(undefined, "account-choice", (snapshot) => ({
        ...snapshot,
        settings: {
          ...snapshot.settings,
          siteDefaults: [...snapshot.settings.siteDefaults, account("https://shop.example")],
        },
      }));
      return { kind: "state", state: state(5, { ...agreed, excludedSites: [] }) };
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(after()?.settings.siteDefaults).toContainEqual(account("https://shop.example"));
  });

  it("writes nothing for a device disconnected during the sync", async () => {
    let gone = false;
    const {
      sync,
      transport,
      storage,
      local: after,
    } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
    });
    transport.settings.mockImplementationOnce(async () => {
      gone = true;
      return { kind: "state", state: state(5, { ...agreed, excludedSites: [] }) };
    });
    expect(await sync.run(CONNECTION, () => gone)).toBe("busy");
    expect(after()?.revision).toBe(7);
    expect(storage.write).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "rejected" } as const, "rejected"],
    [{ kind: "failed", error: "unreachable" } as const, "unreachable"],
  ])("reports %o without changing anything", async (result, outcome) => {
    const { sync, transport, local: after } = setup({ local: agreed, base: baseOf(4, agreed) });
    transport.settings.mockResolvedValueOnce(result);
    expect(await sync.run(CONNECTION, never)).toBe(outcome);
    expect(after()?.revision).toBe(7);
  });

  it("treats a reordered copy as unchanged", async () => {
    const reordered = settingsOf({
      excludedSites: [site("b.example"), site("a.example")],
    });
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: reordered,
      service: state(4, settingsOf({ excludedSites: [site("a.example"), site("b.example")] })),
      base: baseOf(4, settingsOf({ excludedSites: [site("a.example"), site("b.example")] })),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()?.revision).toBe(7);
  });

  it("merges a local edit made between reading and writing local settings", async () => {
    const {
      sync,
      store,
      local: after,
    } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
    });
    const read = store.read.bind(store);
    vi.spyOn(store, "read").mockImplementationOnce(async () => {
      const snapshot = await read();
      await store.update(undefined, "settings-save", (current) => ({
        ...current,
        settings: { ...current.settings, siteDefaults: [] },
      }));
      return snapshot;
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(after()?.settings.siteDefaults).toEqual([]);
  });

  it("does not restore a service removal when the local write must merge again", async () => {
    const {
      sync,
      store,
      transport,
      service,
      local: after,
    } = setup({
      local: { ...agreed, siteDefaults: [] },
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
    });
    const save = transport.saveSettings.getMockImplementation()!;
    transport.saveSettings.mockImplementationOnce(async (...args) => {
      const result = await save(...args);
      // An unrelated local edit after the upload makes the local write conflict.
      await store.update(undefined, "settings-save", (current) => ({
        ...current,
        settings: { ...current.settings, bindings: [] },
      }));
      return result;
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(service().settings?.excludedSites).toEqual([]);
    expect(after()?.settings.bindings).toEqual([]);
    expect(service().settings?.bindings).toEqual([]);
  });

  it("keeps a local edit to an entry made while its upload was in flight", async () => {
    const {
      sync,
      store,
      transport,
      service,
      local: after,
    } = setup({
      local: { ...agreed, siteDefaults: [account("https://bank.example", "item-b")] },
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
    });
    const save = transport.saveSettings.getMockImplementation()!;
    transport.saveSettings.mockImplementationOnce(async (...args) => {
      const result = await save(...args);
      await store.update(undefined, "settings-save", (current) => ({
        ...current,
        settings: {
          ...current.settings,
          siteDefaults: [account("https://bank.example", "item-c")],
        },
      }));
      return result;
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(service().settings?.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
  });

  it("starts over when the service holds other settings at the same revision", async () => {
    const { sync, local: after } = setup({
      local: agreed,
      // Restored from elsewhere: same revision, without the entries this base has.
      service: state(4, settingsOf()),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(syncedSettings(after()!.settings)).toEqual(syncedSettings(agreed));
  });

  it("gives up after repeated conflicts", async () => {
    const { sync, transport } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    transport.saveSettings.mockResolvedValue({ kind: "conflict", current: state(4, agreed) });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(transport.saveSettings).toHaveBeenCalledTimes(MAX_SETTINGS_SYNC_ATTEMPTS);
  });

  it.each([
    [{ kind: "rejected" } as const, "rejected"],
    [{ kind: "failed", error: "rate-limited" } as const, "rate-limited"],
  ])("stops when the write answers %o", async (result, outcome) => {
    const {
      sync,
      transport,
      local: after,
      storage,
    } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    transport.saveSettings.mockResolvedValueOnce(result);
    expect(await sync.run(CONNECTION, never)).toBe(outcome);
    expect(after()?.revision).toBe(7);
    expect(storage.write).not.toHaveBeenCalled();
  });

  it("changes neither side when the merge exceeds the entry limits", async () => {
    const sites = (prefix: string) =>
      Array.from({ length: 600 }, (_, index) => site(`${prefix}-${index}.example`));
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: settingsOf({ excludedSites: sites("local") }),
      service: state(4, settingsOf({ excludedSites: sites("service") })),
      base: baseOf(3, settingsOf()),
    });
    expect(await sync.run(CONNECTION, never)).toBe("too-large");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()?.revision).toBe(7);
  });

  it("refuses an upload over the service's body limit", async () => {
    const long = "x".repeat(150);
    const bindings = Array.from({ length: 400 }, (_, index) => ({
      ...binding(`https://site-${index}.example`),
      itemName: long,
      slots: [{ slot: "password", field: { custom: long } }],
    }));
    const { sync, transport } = setup({ local: settingsOf({ bindings }) });
    expect(await sync.run(CONNECTION, never)).toBe("too-large");
    expect(transport.saveSettings).not.toHaveBeenCalled();
  });

  it("applies a service document over the upload limit when nothing needs uploading", async () => {
    const long = "x".repeat(150);
    const bindings = Array.from({ length: 400 }, (_, index) => ({
      ...binding(`https://site-${index}.example`),
      itemName: long,
      slots: [{ slot: "password", field: { custom: long } }],
    }));
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: settingsOf(),
      service: state(4, settingsOf({ bindings })),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()?.settings.bindings).toHaveLength(400);
  });

  it("waits to change local settings while a login is running", async () => {
    let running = true;
    const {
      sync,
      service,
      local: after,
      applied,
    } = setup({
      local: { ...agreed, siteDefaults: [] },
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => running,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    // The local removal still reaches the service; only the local write waits.
    expect(service().settings?.siteDefaults).toEqual([]);
    expect(after()?.revision).toBe(7);
    expect(applied).not.toHaveBeenCalled();
    running = false;
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(after()?.settings.siteDefaults).toEqual([]);
  });

  it("keeps a local edit made while a merge waited for a login", async () => {
    let running = true;
    const {
      sync,
      store,
      service,
      local: after,
    } = setup({
      local: { ...agreed, siteDefaults: [account("https://bank.example", "item-b")] },
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => running,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    await store.update(undefined, "settings-save", (current) => ({
      ...current,
      settings: { ...current.settings, siteDefaults: [account("https://bank.example", "item-c")] },
    }));
    running = false;
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
    expect(after()?.settings.excludedSites).toEqual([]);
    expect(service().settings?.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
  });

  it("keeps a local edit to an entry the service changed while the write waited", async () => {
    let running = true;
    const {
      sync,
      store,
      service,
      base,
      local: after,
    } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(5, { ...agreed, siteDefaults: [account("https://bank.example", "item-s")] }),
      base: baseOf(4, agreed),
      deferred: () => running,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(base()).toMatchObject({ revision: 6 });
    expect(service().settings?.siteDefaults).toEqual([account("https://bank.example", "item-s")]);
    await store.update(undefined, "settings-save", (current) => ({
      ...current,
      settings: { ...current.settings, siteDefaults: [account("https://bank.example", "item-c")] },
    }));
    running = false;
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
    expect(service().settings?.siteDefaults).toEqual([account("https://bank.example", "item-c")]);
    expect(service().settings?.excludedSites).toEqual([]);
  });

  it("stops waiting for a login left unfinished", async () => {
    let time = 0;
    const { sync, local: after } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => true,
      now: () => time,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    time += MAX_SETTINGS_DEFER_MS;
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
  });

  it("counts the wait for a login across service worker restarts", async () => {
    let time = 0;
    const { restart, local: after } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => true,
      now: () => time,
    });
    expect(await restart().run(CONNECTION, never)).toBe("busy");
    time += MAX_SETTINGS_DEFER_MS / 2;
    expect(await restart().run(CONNECTION, never)).toBe("busy");
    time += MAX_SETTINGS_DEFER_MS / 2;
    expect(await restart().run(CONNECTION, never)).toBe("synced");
    expect(after()?.settings.excludedSites).toEqual([]);
  });

  it("starts the wait again when the stored start is in the future", async () => {
    const { sync, hold } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => true,
      now: () => 1000,
    });
    await hold.write(1000 + MAX_SETTINGS_DEFER_MS * 10);
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(await hold.read()).toBe(1000);
  });

  it.each(["read", "write"] as const)(
    "writes local settings when the stored wait fails to %s",
    async (method) => {
      const {
        sync,
        hold,
        local: after,
      } = setup({
        local: agreed,
        service: state(5, { ...agreed, excludedSites: [] }),
        base: baseOf(4, agreed),
        deferred: () => true,
      });
      hold[method].mockRejectedValue(new Error("synthetic storage failure"));
      expect(await sync.run(CONNECTION, never)).toBe("synced");
      expect(after()?.settings.excludedSites).toEqual([]);
    },
  );

  it("forgets the wait on disconnect", async () => {
    const { sync, hold } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => true,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(await hold.read()).toBeTypeOf("number");
    await sync.clear();
    expect(await hold.read()).toBeUndefined();
  });

  it("forgets the wait once the local write is done", async () => {
    // Running when the first sync starts and decides; the second sync sees the login
    // still running at its start but finished when it writes.
    const answers = [true, true, true, false];
    const { sync, hold } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => answers.shift() ?? false,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(await hold.read()).toBeTypeOf("number");
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(await hold.read()).toBeUndefined();
  });

  it("waits the full time again for a later login", async () => {
    let time = 0;
    let running = true;
    const {
      sync,
      transport,
      local: after,
    } = setup({
      local: agreed,
      service: state(5, { ...agreed, excludedSites: [] }),
      base: baseOf(4, agreed),
      deferred: () => running,
      now: () => time,
    });
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    // The login ends, but the next sync cannot reach the service.
    running = false;
    transport.settings.mockResolvedValueOnce({ kind: "failed", error: "unreachable" });
    expect(await sync.run(CONNECTION, never)).toBe("unreachable");
    time += MAX_SETTINGS_DEFER_MS;
    running = true;
    expect(await sync.run(CONNECTION, never)).toBe("busy");
    expect(after()?.revision).toBe(7);
  });

  it.each([
    ["the login ends", true],
    ["the login keeps running", false],
  ])(
    "writes nothing locally after a disconnect while checking whether %s",
    async (_name, ended) => {
      let gone = false;
      let calls = 0;
      const {
        sync,
        hold,
        local: after,
      } = setup({
        local: agreed,
        service: state(5, { ...agreed, excludedSites: [] }),
        base: baseOf(4, agreed),
        // Running when the sync starts; the device is disconnected during the second check.
        deferred: () => {
          calls += 1;
          if (calls === 1) return true;
          gone = true;
          return !ended;
        },
      });
      expect(await sync.run(CONNECTION, () => gone)).toBe("busy");
      expect(hold.write).not.toHaveBeenCalled();
      expect(after()?.revision).toBe(7);
    },
  );

  it("does not upload for a device disconnected before the merge", async () => {
    const { sync, transport } = setup({
      local: { ...agreed, excludedSites: [] },
      service: state(4, agreed),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, () => true)).toBe("busy");
    expect(transport.saveSettings).not.toHaveBeenCalled();
  });

  it("forgets the base on disconnect", async () => {
    const { sync, base } = setup({ base: baseOf(4, agreed) });
    await sync.clear();
    expect(base()).toBeUndefined();
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

  it("treats settings without allowed sites as an empty list that is off", async () => {
    const bare: LocalSettings = {
      connections: [],
      excludedSites: [],
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
