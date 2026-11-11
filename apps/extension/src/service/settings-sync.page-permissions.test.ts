import {
  createDefaultSettings,
  createSettingsStore,
  DEFAULT_PAGE_PERMISSIONS,
  type LocalSettings,
  type SettingsSnapshot,
  type SitePagePermissions,
  type SyncSettingsState,
} from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { createSettingsSync, mergeSyncedSettings, syncedSettings } from "./settings-sync";
import type { ServiceTransport } from "./transport";

const SERVICE = "https://pateat.example.com";
const DEVICE = "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41";
const PROFILE = "00000000-0000-4000-8000-000000000010";
const connection = {
  origin: SERVICE,
  deviceId: DEVICE,
  credential: `pateat_device_${"C".repeat(43)}`,
  rejected: false,
};
const settingsOf = (parts: Partial<LocalSettings> = {}): LocalSettings => ({
  ...createDefaultSettings(),
  ...parts,
});
const row = (
  hostname: string,
  permissions: SitePagePermissions["permissions"],
): SitePagePermissions => ({ hostname, includeSubdomains: false, permissions });
const defaults = { "sign-in": "fill", confirm: "off", "personal-details": "off" } as const;
const state = (revision: number, settings: LocalSettings | null): SyncSettingsState => ({
  version: 1,
  profileId: PROFILE,
  revision,
  settings,
});

function setup(local: LocalSettings, initial: SyncSettingsState, agreed?: LocalSettings) {
  let snapshot: SettingsSnapshot = { version: 1, revision: 3, settings: local };
  let remote = initial;
  let base: unknown = agreed
    ? {
        version: 1,
        origin: SERVICE,
        deviceId: DEVICE,
        profileId: PROFILE,
        revision: 1,
        settings: agreed,
        local: agreed,
      }
    : undefined;
  const store = createSettingsStore(
    {
      read: async () => structuredClone(snapshot),
      write: async (value) => {
        snapshot = structuredClone(value) as SettingsSnapshot;
      },
    },
    { connections: [] },
  );
  const transport = {
    settings: vi.fn<ServiceTransport["settings"]>(async () => ({
      kind: "state",
      state: structuredClone(remote),
    })),
    saveSettings: vi.fn<ServiceTransport["saveSettings"]>(async (_, __, write) => {
      if (write.expectedRevision !== remote.revision)
        return { kind: "conflict", current: structuredClone(remote) };
      remote = state(remote.revision + 1, write.settings);
      return { kind: "state", state: structuredClone(remote) };
    }),
  };
  const sync = createSettingsSync({
    transport,
    settings: store,
    storage: {
      read: async () => structuredClone(base),
      write: async (value) => {
        base = structuredClone(value);
      },
      clear: async () => {
        base = undefined;
      },
    },
  });
  return {
    sync,
    transport,
    local: () => snapshot,
    remote: () => remote,
    setRemote: (value: SyncSettingsState) => {
      remote = value;
    },
  };
}

const merge = (base: LocalSettings, local: LocalSettings, service: LocalSettings) =>
  mergeSyncedSettings(
    { service: syncedSettings(base), local: syncedSettings(base) },
    syncedSettings(local),
    syncedSettings(service),
  );

describe("profile page permission synchronization", () => {
  it("merges defaults by kind and conflicts by whole hostname row", () => {
    const base = settingsOf({
      sitePagePermissions: [
        row("bank.example", { confirm: "off" }),
        row("removed.example", { "sign-in": "fill" }),
      ],
    });
    const local = settingsOf({
      pagePermissionDefaults: { ...DEFAULT_PAGE_PERMISSIONS, "sign-in": "fill" },
      sitePagePermissions: [
        row("bank.example", { confirm: "fill" }),
        row("local.example", { confirm: "off" }),
      ],
    });
    const service = settingsOf({
      pagePermissionDefaults: { ...DEFAULT_PAGE_PERMISSIONS, confirm: "off" },
      sitePagePermissions: [
        row("bank.example", { "sign-in": "fill" }),
        row("removed.example", { "sign-in": "fill" }),
        row("service.example", { confirm: "off" }),
      ],
    });
    const result = merge(base, local, service);
    expect(result.pagePermissionDefaults).toEqual({
      "sign-in": "fill",
      confirm: "off",
      "personal-details": "fill",
    });
    expect(result.sitePagePermissions).toEqual([
      row("bank.example", { "sign-in": "fill" }),
      row("service.example", { confirm: "off" }),
      row("local.example", { confirm: "off" }),
    ]);
    expect(
      merge(
        settingsOf({ pagePermissionDefaults: defaults }),
        settingsOf({ pagePermissionDefaults: { ...defaults, confirm: "fill" } }),
        settingsOf({
          pagePermissionDefaults: { ...defaults, confirm: "fill", "personal-details": "fill" },
        }),
      ).pagePermissionDefaults,
    ).toEqual({ "sign-in": "fill", confirm: "fill", "personal-details": "fill" });
  });

  it("canonicalizes a reset to defaults and removes a deleted service row despite a local edit", () => {
    const base = settingsOf({
      pagePermissionDefaults: defaults,
      sitePagePermissions: [row("bank.example", { confirm: "off" })],
    });
    const local = settingsOf({
      pagePermissionDefaults: defaults,
      sitePagePermissions: [row("bank.example", { confirm: "fill" })],
    });
    const result = merge(base, local, settingsOf());
    expect(result).not.toHaveProperty("pagePermissionDefaults");
    expect(result).not.toHaveProperty("sitePagePermissions");
    expect(
      merge(
        settingsOf(),
        settingsOf({
          pagePermissionDefaults: { ...DEFAULT_PAGE_PERMISSIONS },
          sitePagePermissions: [],
        }),
        settingsOf(),
      ),
    ).toEqual(syncedSettings(settingsOf()));
  });

  it("adopts an existing profile, removes stale local permissions and preserves device connections", async () => {
    const deviceConnections = [{ connectionId: "synthetic-local", enabled: true }];
    const test = setup(
      settingsOf({
        connections: deviceConnections,
        pagePermissionDefaults: defaults,
        sitePagePermissions: [row("old.example", { confirm: "off" })],
      }),
      state(5, settingsOf()),
    );
    expect(await test.sync.run(connection, () => false)).toBe("synced");
    expect(test.local().settings).not.toHaveProperty("pagePermissionDefaults");
    expect(test.local().settings).not.toHaveProperty("sitePagePermissions");
    expect(test.local().settings.connections).toEqual(deviceConnections);
    expect(test.transport.saveSettings).not.toHaveBeenCalled();
  });

  it("uploads first-pairing permissions and avoids a write for explicit decided defaults", async () => {
    const changed = settingsOf({
      pagePermissionDefaults: defaults,
      sitePagePermissions: [row("bank.example", { confirm: "off" })],
    });
    const test = setup(changed, state(0, null));
    expect(await test.sync.run(connection, () => false)).toBe("synced");
    expect(test.remote().settings).toMatchObject({
      pagePermissionDefaults: defaults,
      sitePagePermissions: changed.sitePagePermissions,
    });
    const canonical = setup(
      settingsOf({
        pagePermissionDefaults: { ...DEFAULT_PAGE_PERMISSIONS },
        sitePagePermissions: [],
      }),
      state(2, settingsOf()),
      settingsOf(),
    );
    expect(await canonical.sync.run(connection, () => false)).toBe("synced");
    expect(canonical.transport.saveSettings).not.toHaveBeenCalled();
  });

  it("remerges page policy after a service compare-and-set conflict", async () => {
    const base = settingsOf();
    const local = settingsOf({
      pagePermissionDefaults: { ...DEFAULT_PAGE_PERMISSIONS, "sign-in": "fill" },
      sitePagePermissions: [row("bank.example", { confirm: "off" })],
    });
    const test = setup(local, state(1, base), base);
    const conflict = state(
      2,
      settingsOf({
        pagePermissionDefaults: { ...DEFAULT_PAGE_PERMISSIONS, confirm: "off" },
        sitePagePermissions: [row("bank.example", { "sign-in": "fill" })],
      }),
    );
    test.transport.saveSettings.mockImplementationOnce(async () => {
      test.setRemote(conflict);
      return { kind: "conflict", current: conflict };
    });
    expect(await test.sync.run(connection, () => false)).toBe("synced");
    expect(test.transport.saveSettings).toHaveBeenCalledTimes(2);
    const retry = test.transport.saveSettings.mock.calls[1]![2];
    expect(retry.expectedRevision).toBe(2);
    expect(retry.settings.pagePermissionDefaults).toEqual({
      "sign-in": "fill",
      confirm: "off",
      "personal-details": "fill",
    });
    expect(retry.settings.sitePagePermissions).toEqual([
      row("bank.example", { "sign-in": "fill" }),
    ]);
    expect(test.local().settings.sitePagePermissions).toEqual(retry.settings.sitePagePermissions);
  });
  it("applies and uploads concurrent independent changes through the real sync loop", async () => {
    const base = settingsOf();
    const test = setup(
      settingsOf({
        pagePermissionDefaults: { ...DEFAULT_PAGE_PERMISSIONS, "sign-in": "fill" },
        sitePagePermissions: [row("local.example", { confirm: "off" })],
      }),
      state(
        2,
        settingsOf({
          pagePermissionDefaults: { ...DEFAULT_PAGE_PERMISSIONS, confirm: "off" },
          sitePagePermissions: [row("service.example", { confirm: "off" })],
        }),
      ),
      base,
    );
    expect(await test.sync.run(connection, () => false)).toBe("synced");
    expect(test.remote().settings?.pagePermissionDefaults).toEqual({
      "sign-in": "fill",
      confirm: "off",
      "personal-details": "fill",
    });
    expect(test.local().settings.sitePagePermissions).toEqual(
      test.remote().settings?.sitePagePermissions,
    );
    expect(test.local().settings.pagePermissionDefaults).toEqual(
      test.remote().settings?.pagePermissionDefaults,
    );
  });
});
