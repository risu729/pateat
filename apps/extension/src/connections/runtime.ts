import * as v from "valibot";
import {
  createBitwardenTransport,
  type BitwardenProfile,
  type BitwardenResult,
  type BitwardenServerConfig,
  type BitwardenTransportOptions,
  type LocalFieldReference,
} from "@pateat/bitwarden";
import {
  getItemEligibility,
  type SettingsSnapshot,
  type VaultAccount,
  type VaultCatalog,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import type { CryptoHost } from "../crypto/host";
import { boundedMessage } from "../crypto/wire";
import { createLocalSettingsRuntime } from "../settings";
import { createIndexedDbVaultStore } from "../vault/storage";
import { createLocalVaultManager } from "../vault/manager";
import { vaultFailure } from "../vault/record";
import { notifyingVaultStore, vaultRecordState, type VaultRecordState } from "./action-icon";
import { createBrowserConnectionRegistry } from "./registry";
import {
  createConnectionPolicy,
  itemEvidence,
  profileServer,
  reviewBlockedItems,
  withEvidence,
} from "./policy";
import { providerPermissionOrigins } from "./permissions";
import { createConnectionSetupService } from "./setup";
import { createIndexedDbProviderSessionStore } from "./session-store";
import { createProviderSessions, type RefreshReport } from "./sessions";
import { SETUP_PORT, setupRequestSchema } from "./wire";
import type { ConnectionRegistry, ConnectionSetupDependencies, SetupReply } from "./types";

/** A diagnostics read must not hold the page as long as a sync may take. */
const SERVER_CONFIG_TIMEOUT_MS = 5_000;

export function createConnectionRuntime(
  host: CryptoHost,
  options: {
    registry?: ConnectionRegistry;
    transportOptions?: BitwardenTransportOptions;
    containsPermission?: (profile: BitwardenProfile) => Promise<boolean>;
    baseCatalog?: VaultCatalog;
    /** Revision dates of applied syncs, read by automatic checks (ADR 0025). */
    revisions?: ConnectionSetupDependencies["revisions"];
    /**
     * Called after each vault record write and each setup request settles, since
     * either can change which connections unlock automatically.
     */
    onVaultStateMayChange?: () => void;
    /** Called with each settings-page Sync result, for the local log. */
    onSync?: (connectionId: string, reply: SetupReply) => void;
    /** Called with each Bitwarden refresh result, for the local log. */
    onRefresh?: (event: RefreshReport) => void;
    /**
     * Whether this device waits for its first settings sync since pairing; the catalog then
     * says so and no vault item is eligible (ADR 0023).
     */
    settingsSyncPending?: () => Promise<boolean>;
  } = {},
) {
  const registry = options.registry ?? createBrowserConnectionRegistry();
  const vaults = new Map<string, ReturnType<typeof vaultFor>>();
  const sessionStores = new Map<string, ReturnType<typeof createIndexedDbProviderSessionStore>>();
  const sessions = createProviderSessions({
    ...(options.onRefresh ? { report: options.onRefresh } : {}),
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
    const store = notifyingVaultStore(createIndexedDbVaultStore({ profile }), () =>
      options.onVaultStateMayChange?.(),
    );
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
        server: profileServer(configuration.profile),
        userId: projected.data.userId,
        snapshotId: record.data.accepted.snapshotId,
        groups: projected.data.groups,
        items: projected.data.items.map((item) => ({
          id: item.id,
          label: item.label,
          allowedOrigins: [],
          groupIds: item.groupIds,
          fields: item.fields.map(({ id, label, name, kind, linkedFieldId, empty }) => ({
            id,
            label,
            name,
            kind,
            ...(linkedFieldId ? { linkedFieldId } : {}),
            ...(empty ? { empty } : {}),
          })),
        })),
      } satisfies VaultCatalog["connections"][number],
    };
  }
  /** The provider account of a connection's accepted snapshot, read without unlocking it. */
  async function account(connectionId: string): Promise<VaultAccount | undefined> {
    const configuration = await registry.get(connectionId);
    if (!configuration) return undefined;
    const record = await vaultFor(configuration.profile).store.read();
    const accepted = record.ok ? record.data?.accepted : undefined;
    return accepted
      ? {
          provider: "bitwarden",
          server: profileServer(configuration.profile),
          userId: accepted.userId,
        }
      : undefined;
  }
  async function catalog(snapshot: SettingsSnapshot): Promise<VaultCatalog> {
    const connections = [...(options.baseCatalog?.connections ?? [])];
    for (const configuration of await registry.list()) {
      try {
        // Native sessions are limited. A failure is visible, never a fabricated ready catalog.
        // eslint-disable-next-line no-await-in-loop
        const value = await current(configuration.profile.connectionId);
        // eslint-disable-next-line no-await-in-loop
        const connection = withEvidence(value.catalog, await itemEvidence(value.entry));
        const review = reviewBlockedItems(snapshot, connection);
        connections.push({
          ...connection,
          quarantinedItemIds: review.blocked,
          ...(review.stale.length ? { staleItemIds: review.stale } : {}),
          state: review.blocked.length ? "review-required" : "ready",
        });
      } catch {
        // eslint-disable-next-line no-await-in-loop
        const known = await account(configuration.profile.connectionId).catch(() => undefined);
        connections.push({
          id: configuration.profile.connectionId,
          label: configuration.label,
          provider: "bitwarden",
          server: profileServer(configuration.profile),
          ...(known ? { lockedUserId: known.userId } : {}),
          groups: [],
          items: [],
          state: "unavailable",
        });
      }
    }
    const pending = await options.settingsSyncPending?.().catch(() => true);
    return pending ? { settingsSyncPending: true, connections } : { connections };
  }
  const settings = createLocalSettingsRuntime({
    catalog,
    ...(options.baseCatalog ? { initialCatalog: options.baseCatalog } : {}),
  });
  const policy = createConnectionPolicy({ settings, current, account });
  const containsPermission =
    options.containsPermission ??
    (async (profile: BitwardenProfile) => {
      const origins = providerPermissionOrigins(profile.environment);
      return origins.ok && browser.permissions.contains({ origins: origins.data });
    });
  const service = createConnectionSetupService({
    host,
    registry,
    vaultFor,
    policy,
    sessions,
    transportFor: (profile) => createBitwardenTransport(profile, options.transportOptions),
    ...(options.revisions ? { revisions: options.revisions } : {}),
    permissions: { contains: containsPermission },
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
    // A reply that cannot be sent ends the Port, so the page fails its requests at once
    // instead of waiting out its timeout.
    function send(message: { requestId: string; result: SetupReply }) {
      if (!connected) return;
      try {
        port.postMessage(message);
      } catch {
        connected = false;
        caller.dispose();
        port.disconnect();
      }
    }
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
        send({
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
        case "connection.delete":
          result = caller.remove(request.connectionId);
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
          options.onVaultStateMayChange?.();
          if (request.type === "connection.sync") {
            try {
              options.onSync?.(request.connectionId, reply);
            } catch {
              // Logging never holds back the reply.
            }
          }
          send({ requestId: request.requestId, result: reply });
          return undefined;
        });
    });
    return true;
  }
  async function vaultStates(): Promise<VaultRecordState[]> {
    const configurations = await registry.list();
    return Promise.all(
      configurations.map(async (configuration) =>
        vaultRecordState(await vaultFor(configuration.profile).store.read()),
      ),
    );
  }
  return {
    settings,
    service,
    registry,
    vaultFor,
    vaultStates,
    current,
    account,
    attach,
    /** Diagnostics only: the public `GET {api}/config`, behind the permission sync uses. */
    async serverConfig(
      connectionId: string,
    ): Promise<
      | BitwardenResult<BitwardenServerConfig>
      | { ok: false; error: { code: "provider-permission-required" } }
      | undefined
    > {
      const configuration = await registry.get(connectionId);
      if (!configuration) return undefined;
      if (!(await containsPermission(configuration.profile)))
        return { ok: false, error: { code: "provider-permission-required" } };
      const transport = createBitwardenTransport(configuration.profile, {
        ...options.transportOptions,
        timeoutMs: SERVER_CONFIG_TIMEOUT_MS,
      });
      return transport.ok
        ? transport.data.config({ connectionId: configuration.profile.connectionId })
        : transport;
    },
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
      const eligibility = getItemEligibility(
        saved.snapshot.settings,
        saved.catalog,
        connectionId,
        captured.itemId,
      );
      if (
        !eligibility.eligible ||
        connection?.snapshotId !== captured.snapshotId ||
        connection.quarantinedItemIds?.includes(captured.itemId)
      )
        return vaultFailure("field-denied");
      const configuration = await registry.get(connectionId);
      if (!configuration) return vaultFailure("invalid-request");
      const vault = vaultFor(configuration.profile);
      const handle = vault.manager.status().handle;
      if (!handle) return vaultFailure("crypto-locked");
      const resolved = await vault.manager.resolveField(handle, captured, {
        snapshotId: captured.snapshotId,
        allowedFieldIds: eligibility.fieldIds,
      });
      const latest = await settings.handle({ version: 1, type: "settings.get" });
      return latest.ok && latest.snapshot.revision === saved.snapshot.revision
        ? resolved
        : vaultFailure("field-denied");
    },
  };
}
export type ConnectionRuntime = ReturnType<typeof createConnectionRuntime>;
