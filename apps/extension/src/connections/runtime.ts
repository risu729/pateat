import * as v from "valibot";
import {
  createBitwardenTransport,
  type BitwardenProfile,
  type BitwardenTransportOptions,
  type LocalFieldReference,
} from "@pateat/bitwarden";
import { getItemEligibility, type SettingsSnapshot, type VaultCatalog } from "@pateat/contracts";
import { browser } from "wxt/browser";
import type { CryptoHost } from "../crypto/host";
import { boundedMessage } from "../crypto/wire";
import { createLocalSettingsRuntime } from "../settings";
import { createIndexedDbVaultStore } from "../vault/storage";
import { createLocalVaultManager } from "../vault/manager";
import { vaultFailure } from "../vault/record";
import { createBrowserConnectionRegistry } from "./registry";
import { createConnectionPolicy, quarantinedItems } from "./policy";
import { providerPermissionOrigins } from "./permissions";
import { createConnectionSetupService } from "./setup";
import { createIndexedDbProviderSessionStore } from "./session-store";
import { createProviderSessions } from "./sessions";
import { SETUP_PORT, setupRequestSchema } from "./wire";
import type { ConnectionRegistry, SetupReply } from "./types";

export function createConnectionRuntime(
  host: CryptoHost,
  options: {
    registry?: ConnectionRegistry;
    transportOptions?: BitwardenTransportOptions;
    containsPermission?: (profile: BitwardenProfile) => Promise<boolean>;
    baseCatalog?: VaultCatalog;
  } = {},
) {
  const registry = options.registry ?? createBrowserConnectionRegistry();
  const vaults = new Map<string, ReturnType<typeof vaultFor>>();
  const sessionStores = new Map<string, ReturnType<typeof createIndexedDbProviderSessionStore>>();
  const sessions = createProviderSessions({
    storeFor(profile) {
      let store = sessionStores.get(profile.connectionId);
      if (!store) {
        store = createIndexedDbProviderSessionStore({ profile });
        sessionStores.set(profile.connectionId, store);
      }
      return store;
    },
  });
  function vaultFor(profile: BitwardenProfile): {
    store: ReturnType<typeof createIndexedDbVaultStore>;
    manager: ReturnType<typeof createLocalVaultManager>;
  } {
    const prior = vaults.get(profile.connectionId);
    if (prior) return prior;
    const store = createIndexedDbVaultStore({ profile });
    const manager = createLocalVaultManager({ profile, host, store });
    const value = { store, manager };
    vaults.set(profile.connectionId, value);
    return value;
  }
  async function current(connectionId: string) {
    const configuration = await registry.get(connectionId);
    if (!configuration) throw new Error("invalid-configuration");
    const vault = vaultFor(configuration.profile);
    const record = await vault.store.read();
    if (!record.ok || record.data?.state !== "active") throw new Error("vault-unavailable");
    let handle = vault.manager.status().handle;
    if (!handle) {
      const restored = await vault.manager.restore();
      if (!restored.ok) throw new Error("vault-unavailable");
      handle = restored.data.handle;
    }
    const projected = await vault.manager.catalog(handle);
    if (!projected.ok || projected.data.snapshotId !== record.data.accepted.snapshotId)
      throw new Error("vault-unavailable");
    return {
      entry: record.data,
      catalog: {
        id: connectionId,
        label: configuration.label,
        provider: "bitwarden",
        snapshotId: record.data.accepted.snapshotId,
        groups: projected.data.groups,
        items: projected.data.items.map((item) => ({
          id: item.id,
          label: item.label,
          allowedOrigins: [],
          groupIds: item.groupIds,
          fields: item.fields.map(({ id, label, name, kind, linkedFieldId }) => ({
            id,
            label,
            name,
            kind,
            ...(linkedFieldId ? { linkedFieldId } : {}),
          })),
        })),
      } satisfies VaultCatalog["connections"][number],
    };
  }
  async function catalog(snapshot: SettingsSnapshot): Promise<VaultCatalog> {
    const connections = [...(options.baseCatalog?.connections ?? [])];
    for (const configuration of await registry.list()) {
      try {
        // Native sessions are limited. A failure is visible, never a fabricated ready catalog.
        // eslint-disable-next-line no-await-in-loop
        const value = await current(configuration.profile.connectionId);
        const quarantine = quarantinedItems(
          snapshot,
          configuration.profile.connectionId,
          value.entry.accepted.snapshotId,
        );
        connections.push({
          ...value.catalog,
          quarantinedItemIds: quarantine,
          state: quarantine.length ? "review-required" : "ready",
        });
      } catch {
        connections.push({
          id: configuration.profile.connectionId,
          label: configuration.label,
          provider: "bitwarden",
          groups: [],
          items: [],
          state: "unavailable",
        });
      }
    }
    return { connections };
  }
  const settings = createLocalSettingsRuntime({
    catalog,
    ...(options.baseCatalog ? { initialCatalog: options.baseCatalog } : {}),
  });
  const policy = createConnectionPolicy({ settings, current });
  const service = createConnectionSetupService({
    host,
    registry,
    vaultFor,
    policy,
    sessions,
    transportFor: (profile) => createBitwardenTransport(profile, options.transportOptions),
    permissions: {
      contains:
        options.containsPermission ??
        (async (profile) => {
          const origins = providerPermissionOrigins(profile.environment);
          return origins.ok && browser.permissions.contains({ origins: origins.data });
        }),
    },
  });
  function attach(port: Browser.runtime.Port) {
    if (port.name !== SETUP_PORT) return false;
    if (
      port.sender?.id !== browser.runtime.id ||
      port.sender.url !== browser.runtime.getURL("/options.html") ||
      port.sender.nativeApplication
    ) {
      port.disconnect();
      return true;
    }
    const caller = service.createCaller();
    let connected = true;
    let pending = 0;
    const used = new Set<string>();
    port.onDisconnect.addListener(() => {
      connected = false;
      caller.dispose();
    });
    port.onMessage.addListener((input: unknown) => {
      if (!connected) return;
      if (!boundedMessage(input)) {
        caller.dispose();
        port.disconnect();
        return;
      }
      const checked = v.safeParse(setupRequestSchema, input);
      if (!checked.success || used.size >= 512 || used.has(checked.output.requestId)) {
        caller.dispose();
        port.disconnect();
        return;
      }
      const request = checked.output;
      used.add(request.requestId);
      if (pending >= 4) {
        port.postMessage({
          requestId: request.requestId,
          result: { ok: false, error: { code: "resource-limit" } },
        });
        return;
      }
      pending += 1;
      let result: Promise<SetupReply>;
      switch (request.type) {
        case "connection.begin":
          result = caller.begin(request.input);
          break;
        case "connection.continue":
          result = caller.continue(request.input);
          break;
        case "connection.cancel":
          result = caller.cancel(request.flowId);
          break;
        case "connection.sync":
          result = caller.sync(request.connectionId);
          break;
        case "connection.disable":
          result = caller.disable(request.connectionId);
          break;
        case "connection.forget":
          result = caller.forget(request.connectionId);
          break;
        case "connection.review":
          result = caller.review(request.input);
          break;
        case "connection.status":
          result = caller.status();
          break;
      }
      void result
        .catch(() => ({ ok: false as const, error: { code: "setup-unavailable" as const } }))
        .then((reply) => {
          pending -= 1;
          if (connected) {
            try {
              port.postMessage({ requestId: request.requestId, result: reply });
            } catch {
              connected = false;
              caller.dispose();
            }
          }
          return undefined;
        });
    });
    return true;
  }
  return {
    settings,
    service,
    registry,
    vaultFor,
    current,
    attach,
    /** Internal only. No page/options API returns vault field values. */
    async resolveField(connectionId: string, ref: LocalFieldReference) {
      let captured: LocalFieldReference;
      try {
        captured = structuredClone(ref);
      } catch {
        return vaultFailure("invalid-request");
      }
      const saved = await settings.handle({ version: 1, type: "settings.get" });
      if (!saved.ok) return vaultFailure("storage-uncertain");
      const connection = saved.catalog.connections.find((entry) => entry.id === connectionId);
      const item = connection?.items.find((entry) => entry.id === captured.itemId);
      if (
        !item ||
        connection?.snapshotId !== captured.snapshotId ||
        connection.quarantinedItemIds?.includes(captured.itemId) ||
        !getItemEligibility(saved.snapshot.settings, saved.catalog, connectionId, captured.itemId)
          .eligible
      )
        return vaultFailure("field-denied");
      const configuration = await registry.get(connectionId);
      if (!configuration) return vaultFailure("invalid-request");
      const vault = vaultFor(configuration.profile);
      const handle = vault.manager.status().handle;
      if (!handle) return vaultFailure("crypto-locked");
      const denied =
        saved.snapshot.settings.connections
          .find((entry) => entry.connectionId === connectionId)
          ?.excludedFields.filter((entry) => entry.itemId === captured.itemId)
          .map((entry) => entry.fieldId) ?? [];
      const resolved = await vault.manager.resolveField(handle, captured, {
        snapshotId: captured.snapshotId,
        allowedFieldIds: item.fields.map((entry) => entry.id).filter((id) => !denied.includes(id)),
      });
      const latest = await settings.handle({ version: 1, type: "settings.get" });
      return latest.ok && latest.snapshot.revision === saved.snapshot.revision
        ? resolved
        : vaultFailure("field-denied");
    },
  };
}
export type ConnectionRuntime = ReturnType<typeof createConnectionRuntime>;
