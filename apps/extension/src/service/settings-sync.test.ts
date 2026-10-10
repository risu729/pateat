import {
  createSettingsStore,
  type LocalSettings,
  type SettingsSnapshot,
  type SyncSettingsState,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import type { ServiceConnection } from "./runtime";
import { createSettingsSync, mergeSyncedSettings, syncedSettings } from "./settings-sync";
import type { ServiceTransport, SettingsResult } from "./transport";

// Synthetic service, credential and vault references only.

const SERVICE = "https://pateat.example.com";
const DEVICE = "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41";
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
  siteDefaults: [],
  bindings: [],
  ...parts,
});
const state = (revision: number, settings: LocalSettings | null): SyncSettingsState => ({
  version: 1,
  revision,
  settings,
});

function setup(
  options: {
    local?: LocalSettings;
    service?: SyncSettingsState;
    base?: unknown;
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
      service = state(service.revision + 1, write.settings);
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
  const applied = vi.fn();
  const sync = createSettingsSync({ transport, settings: store, storage, applied });
  return {
    sync,
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
const baseOf = (revision: number, settings: LocalSettings, deviceId = DEVICE) => ({
  version: 1,
  origin: SERVICE,
  deviceId,
  revision,
  settings,
});

describe("settings sync on a new pairing", () => {
  it("seeds a service that has never stored settings from this device", async () => {
    const local = settingsOf({
      connections: [localConnection],
      excludedSites: [site("intranet.example")],
      siteDefaults: [
        account("https://bank.example"),
        { origin: "https://legacy.example", connectionId: "connection-1", itemId: "item-2" },
      ],
      bindings: [binding("https://bank.example")],
    });
    const { sync, service, base, local: after, applied } = setup({ local });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    // Connections and legacy defaults name device-local IDs; they never leave the device.
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

  it("takes the service's settings over this device's when the service has some", async () => {
    const local = settingsOf({
      connections: [localConnection],
      excludedSites: [site("local-only.example")],
      siteDefaults: [
        account("https://bank.example", "item-local"),
        { origin: "https://legacy.example", connectionId: "connection-1", itemId: "item-2" },
        { origin: "https://shop.example", connectionId: "connection-1", itemId: "item-3" },
      ],
    });
    const remote = settingsOf({
      excludedSites: [site("intranet.example")],
      siteDefaults: [account("https://bank.example"), account("https://shop.example")],
      bindings: [binding("https://bank.example")],
    });
    const {
      sync,
      transport,
      local: after,
      applied,
    } = setup({
      local,
      service: state(3, remote),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    expect(transport.saveSettings).not.toHaveBeenCalled();
    expect(after()?.revision).toBe(8);
    expect(after()?.settings).toEqual({
      connections: [localConnection],
      excludedSites: [site("intranet.example")],
      // A legacy default stays unless the service now names an account for its origin.
      siteDefaults: [
        { origin: "https://legacy.example", connectionId: "connection-1", itemId: "item-2" },
        account("https://bank.example"),
        account("https://shop.example"),
      ],
      bindings: [binding("https://bank.example")],
    });
    expect(applied).toHaveBeenCalledOnce();
  });

  it("ignores the base of another pairing", async () => {
    const remote = settingsOf({ excludedSites: [site("intranet.example")] });
    const { sync, local: after } = setup({
      local: settingsOf({ excludedSites: [site("local-only.example")] }),
      service: state(3, remote),
      base: baseOf(3, settingsOf(), OTHER_DEVICE),
    });
    await sync.run(CONNECTION, never);
    expect(after()?.settings.excludedSites).toEqual([site("intranet.example")]);
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
        bindings: [...(agreed.bindings ?? []), binding("https://shop.example")],
      }),
      base: baseOf(4, agreed),
    });
    expect(await sync.run(CONNECTION, never)).toBe("synced");
    const merged = settingsOf({
      excludedSites: [],
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
    expect(mergeSyncedSettings(base, local, service)).toEqual({
      excludedSites: [site("intranet.example")],
      siteDefaults: [account("https://bank.example", "item-service")],
      bindings: [binding("https://bank.example", "totp")],
    });
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
    expect(service()).toEqual(state(6, { ...agreed, excludedSites: [], bindings: [] }));
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
      await store.update(undefined, (snapshot) => ({
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

  it("forgets the base on disconnect", async () => {
    const { sync, base } = setup({ base: baseOf(4, agreed) });
    await sync.clear();
    expect(base()).toBeUndefined();
  });
});
