import * as v from "valibot";
import {
  createBitwardenTransport,
  type BitwardenProfile,
  type BitwardenResult,
  type BitwardenServerConfig,
  type BitwardenTransportOptions,
  type LocalFieldReference,
} from "@pateat/bitwarden";
import { getItemEligibility, type SettingsSnapshot, type VaultCatalog } from "@pateat/contracts";
import { browser } from "wxt/browser";
import type { CryptoHost } from "../crypto/host";
import { boundedMessage } from "../crypto/wire";
import { createLocalSettingsRuntime } from "../settings";
import { createIndexedDbVaultStore } from "../vault/storage";
import {
  createLocalVaultManager,
  type KeyRetention,
  type LocalVaultManager,
} from "../vault/manager";
import { createSessionKeyStore } from "../vault/session-key";
import { vaultFailure } from "../vault/record";
import {
  notifyingVaultManager,
  notifyingVaultStore,
  vaultRecordState,
  type VaultRecordState,
} from "./action-icon";
import { catalogEntry } from "./catalog";
import { createBrowserConnectionRegistry } from "./registry";
import { createConnectionPolicy, quarantinedItems } from "./policy";
import { providerPermissionOrigins } from "./permissions";
import { createConnectionSetupService } from "./setup";
import { createIndexedDbProviderSessionStore } from "./session-store";
import { createProviderSessions, type RefreshReport } from "./sessions";
import { SETUP_PORT, setupRequestSchema } from "./wire";
import { senderPageUrl } from "../messaging/sender";
import type { ConnectionRegistry, ConnectionSetupDependencies, SetupReply } from "./types";

/** A diagnostics read must not hold the page as long as a sync may take. */
const SERVER_CONFIG_TIMEOUT_MS = 5_000;

export type SignInStep = "begin" | "continue" | "send-email-code" | "keep-alive";
const signInSteps: Partial<Record<v.InferOutput<typeof setupRequestSchema>["type"], SignInStep>> = {
  "connection.begin": "begin",
  "connection.continue": "continue",
  "connection.send-email-code": "send-email-code",
  "connection.keep-alive": "keep-alive",
};

/**
 * A vault manager that reports each field read and passkey signature as use of the vault
 * timeout, and an unlock as the vault serving its snapshot again.
 */
function usedVaultManager(
  manager: LocalVaultManager,
  used: () => void,
  opened: () => void,
): LocalVaultManager {
  return {
    ...manager,
    async resolveField(...args: Parameters<LocalVaultManager["resolveField"]>) {
      const result = await manager.resolveField(...args);
      if (result.ok) used();
      return result;
    },
    async signPasskey(...args: Parameters<LocalVaultManager["signPasskey"]>) {
      const result = await manager.signPasskey(...args);
      if (result.ok) used();
      return result;
    },
    async unlock(...args: Parameters<LocalVaultManager["unlock"]>) {
      const result = await manager.unlock(...args);
      if (result.ok) opened();
      return result;
    },
  };
}

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
    /** Called once a vault serves a new snapshot after an accepted sync or a restore. */
    onVaultOpened?: () => void;
    /** Called with each settings-page Sync result, for the local log. */
    onSync?: (connectionId: string, reply: SetupReply) => void;
    /**
     * Called with each settings-page sign-in step's result, for the local log: the password,
     * the code, an email code send, and a heartbeat that found the sign-in gone.
     */
    onSignIn?: (step: SignInStep, reply: SetupReply) => void;
    /** Called with each Bitwarden refresh result, for the local log. */
    onRefresh?: (event: RefreshReport) => void;
    /** Where an unlocked vault's key is kept, from the vault timeout (ADR 0075). */
    retention?: () => Promise<KeyRetention>;
    /**
     * The vault timeout (ADR 0075): `check` runs before each vault use and locks the
     * vaults once the timeout has passed; `used` is told of each field read, passkey
     * signature, unlock and sign-in.
     */
    vaultTimeout?: {
      check(): Promise<void>;
      used(opened?: string): Promise<void>;
      unclosed(connectionId: string): Promise<boolean>;
    };
  } = {},
) {
  const registry = options.registry ?? createBrowserConnectionRegistry();
  const vaults = new Map<string, ReturnType<typeof vaultFor>>();
  const sessionStores = new Map<string, ReturnType<typeof createIndexedDbProviderSessionStore>>();
  const sessions = createProviderSessions({
    ...(options.onRefresh ? { report: options.onRefresh } : {}),
    storeFor: (profile) =>
      sessionStores.getOrInsertComputed(profile.connectionId, () =>
        createIndexedDbProviderSessionStore({ profile }),
      ),
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
    const manager = usedVaultManager(
      notifyingVaultManager(
        createLocalVaultManager({
          profile,
          host,
          store,
          ...(options.retention ? { retention: options.retention } : {}),
          sessionKey: createSessionKeyStore(profile.connectionId),
        }),
        () => options.onVaultOpened?.(),
      ),
      () => void options.vaultTimeout?.used().catch(() => undefined),
      () => options.onVaultOpened?.(),
    );
    const value = { store, manager };
    vaults.set(profile.connectionId, value);
    return value;
  }
  /** Vaults with an unlock or a sign-in running, by how many. */
  const opening = new Map<string, number>();
  /** The vault each sign-in waiting for a code signs in to. */
  const flows = new Map<string, string>();
  async function current(connectionId: string) {
    // A check that cannot tell whether the timeout passed keeps the vault closed.
    await options.vaultTimeout?.check().catch(() => {
      throw new Error("vault-unavailable");
    });
    // A vault the timeout could not close stays refused until it closes or is reopened.
    if (await options.vaultTimeout?.unclosed(connectionId).catch(() => true))
      throw new Error("vault-unavailable");
    const configuration = await registry.get(connectionId);
    if (!configuration) throw new Error("invalid-configuration");
    const vault = vaultFor(configuration.profile);
    const record = await vault.store.read();
    if (!record.ok || !record.data || record.data.state === "disabled")
      throw new Error("vault-unavailable");
    let handle = vault.manager.status().handle;
    if (!handle) {
      const restored = await vault.manager.restore();
      if (!restored.ok)
        throw new Error(
          restored.error.code === "vault-locked" ? "vault-locked" : "vault-unavailable",
        );
      handle = restored.data.handle;
    }
    const projected = await vault.manager.catalog(handle);
    if (!projected.ok || projected.data.snapshotId !== record.data.accepted.snapshotId)
      throw new Error("vault-unavailable");
    return {
      entry: record.data,
      catalog: catalogEntry(connectionId, configuration.label, projected.data),
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
      } catch (error) {
        connections.push({
          id: configuration.profile.connectionId,
          label: configuration.label,
          provider: "bitwarden",
          groups: [],
          items: [],
          state:
            error instanceof Error && error.message === "vault-locked" ? "locked" : "unavailable",
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
  // Drops settings a delete could not remove: its best-effort step failed or the worker
  // stopped first. Older deletes, which left them all, are cleared the same way.
  void registry
    .list()
    .then((configurations) =>
      policy.prune([
        ...(options.baseCatalog?.connections.map((connection) => connection.id) ?? []),
        ...configurations.map((configuration) => configuration.profile.connectionId),
      ]),
    )
    .catch(() => undefined);
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
      senderPageUrl(port.sender) !== browser.runtime.getURL("/options.html") ||
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
      // The vault this request may open, which the timeout's retries leave alone meanwhile.
      const opens =
        request.type === "connection.unlock"
          ? request.input.connectionId
          : request.type === "connection.begin" && request.input.kind === "existing"
            ? request.input.connectionId
            : request.type === "connection.continue"
              ? flows.get(request.input.flowId)
              : undefined;
      if (opens) opening.set(opens, (opening.get(opens) ?? 0) + 1);
      switch (request.type) {
        case "connection.begin":
          // A vault whose time already passed locks first; then the sign-in starts the time
          // again, so a check while it runs cannot lock the vault it unlocks.
          result = timeoutChecked()
            .then(() => options.vaultTimeout?.used())
            .then(() => caller.begin(request.input));
          break;
        case "connection.continue":
          // A second step can take a while; it starts the time again too.
          result = Promise.resolve(options.vaultTimeout?.used()).then(() =>
            caller.continue(request.input),
          );
          break;
        case "connection.unlock":
          result = timeoutChecked()
            .then(() => options.vaultTimeout?.used())
            .then(() => caller.unlock(request.input));
          break;
        case "connection.lock":
          result = caller.lock(request.connectionId);
          break;
        case "connection.cancel":
          result = caller.cancel(request.flowId);
          break;
        case "connection.send-email-code":
          result = caller.sendEmailCode(request.flowId);
          break;
        case "connection.keep-alive":
          result = caller.keepAlive(request.flowId);
          break;
        case "connection.sync":
          // A sync opens the next snapshot with the vault's key, so it waits for the check,
          // and a vault the timeout could not close stays refused.
          result = (options.vaultTimeout?.check() ?? Promise.resolve())
            .then(() => options.vaultTimeout?.unclosed(request.connectionId))
            .then(
              (unclosed): Promise<SetupReply> | SetupReply =>
                unclosed
                  ? { ok: false, error: { code: "setup-unavailable" } }
                  : caller.sync(request.connectionId),
              () => ({ ok: false as const, error: { code: "setup-unavailable" as const } }),
            );
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
          // A sign-in or an unlock opens the vault, so the vault timeout counts from it. The
          // vault stays out of the timeout's retries until that is recorded.
          const counted =
            reply.ok &&
            (request.type === "connection.begin" ||
              request.type === "connection.continue" ||
              request.type === "connection.unlock")
              ? options.vaultTimeout?.used(
                  reply.kind === "ready" || reply.kind === "unlocked"
                    ? reply.connectionId
                    : undefined,
                )
              : undefined;
          // A sign-in that waits for a code keeps its vault for the step that finishes it.
          if (request.type === "connection.continue") flows.delete(request.input.flowId);
          if (opens && reply.ok && "flowId" in reply && typeof reply.flowId === "string") {
            flows.set(reply.flowId, opens);
            if (flows.size > 16) flows.delete(flows.keys().next().value!);
          }
          void Promise.resolve(counted)
            .catch(() => undefined)
            .finally(() => {
              if (!opens) return;
              const left = (opening.get(opens) ?? 1) - 1;
              if (left > 0) opening.set(opens, left);
              else opening.delete(opens);
            });
          // A heartbeat changes no vault state.
          if (request.type !== "connection.keep-alive") options.onVaultStateMayChange?.();
          try {
            if (request.type === "connection.sync") options.onSync?.(request.connectionId, reply);
            const step = signInSteps[request.type];
            // A heartbeat is logged only when it found the sign-in gone.
            if (step && (step !== "keep-alive" || !reply.ok)) options.onSignIn?.(step, reply);
          } catch {
            // Logging never holds back the reply.
          }
          send({ requestId: request.requestId, result: reply });
          return undefined;
        });
    });
    return true;
  }
  /** A failed check still lets a sign-in or an unlock run; it starts the time again. */
  function timeoutChecked(): Promise<void> {
    return (options.vaultTimeout?.check() ?? Promise.resolve()).catch(() => undefined);
  }
  async function vaultStates(): Promise<VaultRecordState[]> {
    const configurations = await registry.list();
    return Promise.all(
      configurations.map(async (configuration) => {
        const vault = vaultFor(configuration.profile);
        const record = await vault.store.read();
        // A locked record unlocked in this browser session is as usable as an active one.
        if (record.ok && record.data?.state === "locked")
          return (await vault.manager.keyFor(record.data)) ? "active" : "locked";
        return vaultRecordState(record);
      }),
    );
  }
  /**
   * The vault timeout's action on every vault of this device, or on `only` (ADR 0075):
   * `lock` keeps the sync sign-in, `log-out` also forgets it, as the settings page's Log
   * out does. Every vault is tried; answers how many open vaults it closed and which it
   * could not close.
   */
  async function timeOut(
    action: "lock" | "log-out",
    only?: string[],
    retry?: { except?: string[] },
  ): Promise<{ closed: number; failed: string[] }> {
    const caller = service.createCaller();
    let closed = 0;
    const failed: string[] = [];
    try {
      for (const configuration of await registry.list()) {
        const { connectionId } = configuration.profile;
        if (only && !only.includes(connectionId)) continue;
        if (retry?.except?.includes(connectionId)) continue;
        // The person is unlocking or signing in to it; that answer decides, not a retry.
        if (retry && opening.has(connectionId)) {
          failed.push(connectionId);
          continue;
        }
        try {
          const vault = vaultFor(configuration.profile);
          // oxlint-disable-next-line no-await-in-loop -- one connection at a time
          const record = await vault.store.read();
          if (record.ok && (!record.data || record.data.state === "disabled")) continue;
          // Locking a locked vault changes nothing; a log out still forgets its sign-in. A
          // record that no longer parses has nothing open.
          const open =
            (!record.ok && record.error.code !== "invalid-cache-record") ||
            (record.ok && action === "log-out") ||
            // oxlint-disable-next-line no-await-in-loop -- one connection at a time
            (record.ok && Boolean(await vault.manager.keyFor(record.data)));
          const reply =
            action === "lock"
              ? // oxlint-disable-next-line no-await-in-loop -- one connection at a time
                await caller.lock(connectionId)
              : // oxlint-disable-next-line no-await-in-loop -- one connection at a time
                await caller.disable(connectionId);
          if (!reply.ok) failed.push(connectionId);
          else if (open) closed += 1;
        } catch {
          failed.push(connectionId);
        }
      }
      return { closed, failed };
    } finally {
      caller.dispose();
      options.onVaultStateMayChange?.();
    }
  }
  /** Moves each unlocked vault's key to where the vault timeout now keeps it. */
  async function keepKeys(retention: KeyRetention): Promise<boolean> {
    let moved = true;
    for (const configuration of await registry.list()) {
      // oxlint-disable-next-line no-await-in-loop -- one connection at a time
      const kept = await vaultFor(configuration.profile)
        .manager.keepKey(retention)
        .catch(() => ({ ok: false }));
      if (!kept.ok) moved = false;
    }
    options.onVaultStateMayChange?.();
    return moved;
  }
  return {
    settings,
    service,
    registry,
    vaultFor,
    vaultStates,
    current,
    attach,
    timeOut,
    keepKeys,
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
    /**
     * Internal only. No page/options API returns vault field values. `code` resolves the
     * field as a TOTP code and never returns its raw value.
     */
    async resolveField(
      connectionId: string,
      ref: LocalFieldReference,
      grant: { code?: true } = {},
    ) {
      const code = grant.code === true;
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
        ...(code ? { code: true as const } : {}),
      });
      const latest = await settings.handle({ version: 1, type: "settings.get" });
      return latest.ok && latest.snapshot.revision === saved.snapshot.revision
        ? resolved
        : vaultFailure("field-denied");
    },
  };
}
export type ConnectionRuntime = ReturnType<typeof createConnectionRuntime>;
