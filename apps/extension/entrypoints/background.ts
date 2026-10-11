import { BITWARDEN_READ_PROTOCOL } from "@pateat/bitwarden";
import * as v from "valibot";
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { createProbeCatalog } from "../src/login/dummy";
import { createLoginRuntime } from "../src/login/runtime";
import { createLoginSites } from "../src/login/sites";
import {
  combineFieldSources,
  createVaultFieldSource,
  createVaultUriMatcher,
  dummyFieldSource,
} from "../src/login/vault";
import { createBrowserCryptoHost } from "../src/crypto/browser";
import { createCryptoProbe, createCryptoProbeControls } from "../src/crypto/probe";
import { createVaultProbe } from "../src/vault/probe";
import { createSiteAccountsHandler } from "../src/vault/site-accounts";
import { actionIconState, createActionIcon } from "../src/connections/action-icon";
import { createConnectionRuntime } from "../src/connections/runtime";
import { createConnectionProbeTransport } from "../src/connections/probe";
import { createProbePasskeySource } from "../src/passkeys/probe";
import { createPasskeyRuntime } from "../src/passkeys/runtime";
import { createVaultPasskeyFinder, createVaultPasskeySource } from "../src/passkeys/vault";
import { createLoginGeneration } from "../src/service/generation";
import { createRecipeSync } from "../src/service/recipes";
import { createServiceRuntime } from "../src/service/runtime";
import { createSettingsSync } from "../src/service/settings-sync";
import {
  createBrowserGenerationAttemptStorage,
  createBrowserRecipeCacheStorage,
  createBrowserRecipeScheduleStorage,
  createBrowserServiceStorage,
  createBrowserSettingsBaseStorage,
  createBrowserSettingsHoldStorage,
  createBrowserVaultSyncStorage,
} from "../src/service/storage";
import { createServiceTransport } from "../src/service/transport";
import { createDiagnosticsHandler } from "../src/diagnostics/status";
import { diagnosticsRequestSchema } from "../src/diagnostics/wire";
import { createDiagnosticsLog } from "../src/diagnostics/background";
import {
  VAULT_SYNC_ALARM,
  VAULT_SYNC_ALARM_MINUTES,
  createVaultAutoSync,
  createVaultSyncRecords,
} from "../src/connections/auto-sync";

export default defineBackground(() => {
  // First, so the logger sees errors from everything set up below.
  const diagnosticsLog = createDiagnosticsLog({
    build: { version: browser.runtime.getManifest().version, revision: PATEAT_BUILD_REVISION },
    settings: async () => (await settings.read()).settings,
    recipeCache: () => recipeCacheStorage.read(),
    connections: () => connections.service.status(),
  });
  const { logger } = diagnosticsLog;
  const catalog = import.meta.env.MODE === "probe" ? createProbeCatalog() : undefined;
  const cryptoControls = import.meta.env.MODE === "probe" ? createCryptoProbeControls() : undefined;
  const cryptoHost = createBrowserCryptoHost(
    cryptoControls
      ? { checkpoint: cryptoControls.checkpoint, requestTimeoutMs: cryptoControls.requestTimeoutMs }
      : {},
  );
  const cryptoProbe = cryptoControls ? createCryptoProbe(cryptoHost, cryptoControls) : undefined;
  const vaultProbe = import.meta.env.MODE === "probe" ? createVaultProbe(cryptoHost) : undefined;
  const syntheticSetup =
    import.meta.env.MODE === "probe" ? createConnectionProbeTransport() : undefined;
  const vaultSyncRecords = createVaultSyncRecords(createBrowserVaultSyncStorage());
  const connections = createConnectionRuntime(cryptoHost, {
    revisions: vaultSyncRecords,
    ...(catalog ? { baseCatalog: catalog } : {}),
    ...(syntheticSetup
      ? {
          transportOptions: syntheticSetup.transportOptions,
          containsPermission: syntheticSetup.containsPermission,
        }
      : {}),
    onVaultStateMayChange: () => {
      void actionIcon.refresh();
      diagnosticsLog.vaultStateMayChange();
    },
  });
  // The manifest default is the locked icon; a running worker switches it.
  const actionIcon = createActionIcon({
    states: () => connections.vaultStates(),
    setIcon: (path) => browser.action.setIcon({ path }),
  });
  void actionIcon.refresh();
  // A badge counts the accounts a refused login could use (ADR 0021).
  void browser.action.setBadgeBackgroundColor({ color: "#115e59" }).catch(() => undefined);
  const settings = connections.settings;
  const serviceTransport = createServiceTransport();
  const service = createServiceRuntime({
    storage: createBrowserServiceStorage(),
    transport: serviceTransport,
    // Chrome match patterns do not carry ports; site access is granted per host.
    hasSiteAccess: (origin) =>
      browser.permissions.contains({ origins: [`https://${new URL(origin).hostname}/*`] }),
  });
  const settingsBaseStorage = createBrowserSettingsBaseStorage();
  const settingsHoldStorage = createBrowserSettingsHoldStorage();
  const settingsSync = createSettingsSync({
    transport: serviceTransport,
    settings,
    storage: settingsBaseStorage,
    hold: settingsHoldStorage,
    // Synced changes replace the policy that running attempts were authorized under.
    applied: () => {
      login.settingsChanged();
      passkeys.cancelAll();
    },
    deferred: () => login.active(),
    catalog: async () => {
      const current = await settings.handle({ version: 1, type: "settings.get" });
      return current.ok ? current.catalog : undefined;
    },
  });
  const recipeCacheStorage = createBrowserRecipeCacheStorage();
  const recipeScheduleStorage = createBrowserRecipeScheduleStorage();
  const recipeSync = createRecipeSync({
    service,
    transport: serviceTransport,
    storage: recipeCacheStorage,
    schedule: recipeScheduleStorage,
    settings: settingsSync,
    report: diagnosticsLog.recipeSync,
  });
  // Workers stop when idle, so the persisted schedule, not each start, paces syncs.
  recipeSync.refreshIfStale();
  // A saved account choice is uploaded at once instead of waiting for the next sync.
  const loginSettings: typeof settings = {
    ...settings,
    update: (expectedRevision, mutate) =>
      settings.update(expectedRevision, mutate).then((snapshot) => {
        void recipeSync.sync();
        return snapshot;
      }),
  };
  // A model call can outlast the worker's 30-second idle timeout; an extension API call
  // resets it, so the answer is not lost with a stopped worker.
  const keepAlive = <T>(work: Promise<T>): Promise<T> => {
    const timer = setInterval(() => void browser.runtime.getPlatformInfo(), 20_000);
    return work.finally(() => clearInterval(timer));
  };
  const vaultUris = createVaultUriMatcher(connections);
  const vaultFields = createVaultFieldSource(connections);
  // Automatic vault sync (ADR 0025): a revision check on page events and every five
  // minutes; the full sync and its replacement wait for logins and passkey requests.
  const vaultSync = createVaultAutoSync({
    records: vaultSyncRecords,
    async connections() {
      const [configurations, snapshot] = await Promise.all([
        connections.registry.list(),
        settings.read(),
      ]);
      return configurations
        .map((configuration) => configuration.profile.connectionId)
        .filter(
          (id) => snapshot.settings.connections.find((entry) => entry.connectionId === id)?.enabled,
        );
    },
    run: (connectionId, hold) => connections.service.autoSync(connectionId, hold),
    loginActive: () => login.active(),
  });
  const login = createLoginRuntime(loginSettings, {
    vault: vaultSync,
    fields: combineFieldSources({
      bitwarden: vaultFields,
      ...(catalog ? { dummy: dummyFieldSource } : {}),
    }),
    sites: createLoginSites(settings),
    recipes: recipeSync.recipes,
    uris: vaultUris,
    generation: createLoginGeneration({
      service,
      transport: {
        generateRecipe: (...request) => keepAlive(serviceTransport.generateRecipe(...request)),
        judgeCompletion: (...request) => keepAlive(serviceTransport.judgeCompletion(...request)),
      },
      storage: createBrowserGenerationAttemptStorage(),
      sync: () => recipeSync.sync(),
    }),
    report: diagnosticsLog.login,
  });
  const setupProbe = syntheticSetup?.handler(connections);
  const vaultPasskeys = createVaultPasskeySource(connections);
  const siteAccounts = createSiteAccountsHandler({
    settings,
    matchUris: vaultUris,
    findPasskeys: createVaultPasskeyFinder(connections),
    readField: vaultFields,
  });
  const passkeyProbe =
    import.meta.env.MODE === "probe" ? createProbePasskeySource(vaultPasskeys) : undefined;
  const passkeys = passkeyProbe
    ? createPasskeyRuntime(passkeyProbe.source, {
        extensionId: browser.runtime.id,
        timeoutMs: passkeyProbe.timeoutMs,
        policy: passkeyProbe.policy,
      })
    : createPasskeyRuntime(vaultPasskeys, {
        extensionId: browser.runtime.id,
        // Only the local log keeps it; the page never learns why.
        report: diagnosticsLog.passkey,
      });

  // Value-free per-device state for bug reports (ADR 0019).
  const diagnostics = createDiagnosticsHandler({
    build: {
      version: browser.runtime.getManifest().version,
      revision: PATEAT_BUILD_REVISION,
      mode: import.meta.env.MODE,
      bitwardenSdk: PATEAT_BITWARDEN_SDK_VERSION,
      bitwardenProtocol: `client ${BITWARDEN_READ_PROTOCOL.clientVersion}, Device-Type ${BITWARDEN_READ_PROTOCOL.deviceType}`,
    },
    pseudonym: diagnosticsLog.pseudonyms,
    platform: async () => {
      const { os, arch } = await browser.runtime.getPlatformInfo();
      return { os, arch };
    },
    permissions: () => browser.permissions.getAll(),
    declaredOrigins: browser.runtime.getManifest().host_permissions ?? [],
    hasAllSiteAccess: () => browser.permissions.contains({ origins: ["https://*/*"] }),
    connections: {
      status: () => connections.service.status(),
      check: async (connectionId) => (await vaultSyncRecords.read()).connections[connectionId],
      async read(connectionId) {
        const configuration = await connections.registry.get(connectionId);
        return configuration ? connections.vaultFor(configuration.profile).store.read() : undefined;
      },
      server: (connectionId) => connections.serverConfig(connectionId),
    },
    cryptoHost: () => cryptoHost.status(),
    actionIcon: async () => actionIconState(await connections.vaultStates()),
    async serviceState() {
      const response = await service.handle({ version: 1, type: "service.get" });
      if (!response.ok) throw new Error(response.error);
      return response.state;
    },
    serviceOrigin: async () => (await service.connection())?.origin,
    hasSiteAccess: (origin) =>
      browser.permissions.contains({ origins: [`https://${new URL(origin).hostname}/*`] }),
    fetch: (input, init) => fetch(input, init),
    settings: async () => (await settings.read()).settings,
    logs: () => logger.summary(),
    storage: {
      localBytes: () => browser.storage.local.getBytesInUse(null),
      recipeCache: () => recipeCacheStorage.read(),
      recipeSchedule: () => recipeScheduleStorage.read(),
      settingsBase: () => settingsBaseStorage.read(),
      settingsHold: () => settingsHoldStorage.read(),
    },
  });

  browser.runtime.onConnect.addListener((port) => {
    connections.attach(port);
  });
  browser.permissions.onRemoved.addListener(() => {
    void connections.service.permissionsRemoved().catch(() => undefined);
  });
  // Wakes the worker at browser start so automatic unlock shows the unlocked icon.
  // Chrome may drop alarms on restart or update, so each worker start re-creates it.
  void browser.alarms
    .get(VAULT_SYNC_ALARM)
    .then((alarm) =>
      alarm
        ? undefined
        : browser.alarms.create(VAULT_SYNC_ALARM, { periodInMinutes: VAULT_SYNC_ALARM_MINUTES }),
    )
    .catch(() => undefined);
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === VAULT_SYNC_ALARM) vaultSync.refreshIfStale();
  });
  browser.runtime.onStartup.addListener(() => {
    void actionIcon.refresh();
  });
  // The settings page and the toolbar popup edit settings through the same store (ADR 0021).
  const settingsPages = new Set([
    browser.runtime.getURL("/options.html"),
    browser.runtime.getURL("/popup.html"),
  ]);
  const fromSettingsPage = (sender: { id?: string; url?: string }) =>
    sender.id === browser.runtime.id && settingsPages.has(sender.url ?? "");

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (
      setupProbe &&
      sender.id === browser.runtime.id &&
      sender.url === new URL("crypto-probe.html", browser.runtime.getURL("/options.html")).href &&
      message !== null &&
      typeof message === "object" &&
      message.type === "setup.probe"
    ) {
      void setupProbe(message).then(sendResponse, () =>
        sendResponse({ ok: false, error: { code: "setup-unavailable" } }),
      );
      return true;
    }
    if (
      vaultProbe &&
      sender.id === browser.runtime.id &&
      sender.url === new URL("crypto-probe.html", browser.runtime.getURL("/options.html")).href &&
      message !== null &&
      typeof message === "object" &&
      message.type === "vault.probe"
    ) {
      void vaultProbe(message).then(sendResponse);
      return true;
    }
    if (
      cryptoProbe &&
      sender.id === browser.runtime.id &&
      sender.url === new URL("crypto-probe.html", browser.runtime.getURL("/options.html")).href &&
      message !== null &&
      typeof message === "object" &&
      message.type === "crypto.probe"
    ) {
      void cryptoProbe(message).then(sendResponse);
      return true;
    }
    if (
      fromSettingsPage(sender) &&
      message !== null &&
      typeof message === "object" &&
      (message.type === "settings.get" || message.type === "settings.save")
    ) {
      void settings.handle(message).then((response) => {
        if (message.type === "settings.save" && response.ok) {
          login.settingsChanged();
          passkeys.cancelAll();
          void recipeSync.sync();
        }
        return sendResponse(response);
      });
      return true;
    }
    if (
      fromSettingsPage(sender) &&
      message !== null &&
      typeof message === "object" &&
      message.type === "settings.site-accounts"
    ) {
      void siteAccounts(message).then(sendResponse, () =>
        sendResponse({ version: 1, ok: false, reason: "unavailable" }),
      );
      return true;
    }
    if (
      sender.id === browser.runtime.id &&
      sender.url === browser.runtime.getURL("/options.html") &&
      message !== null &&
      typeof message === "object" &&
      typeof message.type === "string" &&
      message.type.startsWith("service.")
    ) {
      void service.handle(message).then(
        (response) => {
          // A completed pairing syncs at once; an open settings page keeps a stale cache moving.
          if (response.ok && response.state.kind === "connected") {
            if (message.type === "service.pair.check") void recipeSync.sync();
            else recipeSync.refreshIfStale();
          }
          // The previous owner's recipes are not kept once their device is gone.
          if (
            (message.type === "service.disconnect" || message.type === "service.forget") &&
            response.ok
          )
            void recipeSync.clear();
          return sendResponse(response);
        },
        () => sendResponse({ ok: false, error: "storage-unavailable" }),
      );
      return true;
    }
    if (
      sender.id === browser.runtime.id &&
      sender.url === browser.runtime.getURL("/diagnostics.html") &&
      v.is(diagnosticsRequestSchema, message)
    ) {
      void (
        message.type === "diagnostics.status" ? diagnostics() : diagnosticsLog.handle(message)
      ).then(sendResponse);
      return true;
    }

    if (
      message !== null &&
      typeof message === "object" &&
      typeof message.type === "string" &&
      message.type.startsWith("login.")
    ) {
      void login
        .handle(message, sender)
        .then(sendResponse, () => sendResponse({ ok: false, reason: "runtime-unavailable" }));
      return true;
    }

    if (
      passkeyProbe &&
      sender.id === browser.runtime.id &&
      sender.url === browser.runtime.getURL("/options.html") &&
      message !== null &&
      typeof message === "object" &&
      typeof message.type === "string" &&
      message.type.startsWith("passkey.probe.")
    ) {
      sendResponse(passkeyProbe.control(message));
      return false;
    }
    if (
      message !== null &&
      typeof message === "object" &&
      typeof message.type === "string" &&
      message.type.startsWith("passkey.")
    ) {
      vaultSync.refreshIfStale();
      // The open vault is not replaced while a passkey request is answered.
      void vaultSync
        .enter(false)
        .then((leave) => passkeys.handle(message, sender).finally(leave))
        .then(sendResponse, () =>
          sendResponse({ kind: "delegate", reason: "runtime-unavailable" }),
        );
      return true;
    }

    if (
      import.meta.env.MODE === "probe" &&
      sender.id === browser.runtime.id &&
      sender.tab?.id !== undefined &&
      sender.url?.startsWith("http://127.0.0.1:") &&
      message?.type === "pateat.test.document"
    ) {
      sendResponse({
        tabId: sender.tab.id,
        frameId: sender.frameId,
        documentId: sender.documentId,
        active: sender.tab.active,
      });
    }
    return false;
  });
});
