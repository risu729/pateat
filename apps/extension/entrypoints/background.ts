import { BITWARDEN_READ_PROTOCOL } from "@pateat/bitwarden";
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
import { CHOOSER_PAGE, createPasskeyChooser } from "../src/passkeys/chooser";
import { createPasskeyCreateHandler } from "../src/passkeys/create";
import { createProbePasskeySource } from "../src/passkeys/probe";
import { createPasskeyRuntime } from "../src/passkeys/runtime";
import { createSignIns, SIGN_INS_KEY } from "../src/passkeys/sign-ins";
import { createSignedTabs, SIGNED_TABS_KEY } from "../src/passkeys/signed-tabs";
import { sessionValue } from "../src/storage";
import { createLoginBadge, LOGIN_BADGE_KEY, setActionBadge } from "../src/login/badge";
import {
  createVaultPasskeyFinder,
  createVaultPasskeySource,
  itemPasskeyFacts,
  originPasskeyItems,
  rememberVaultPasskey,
  type VaultPasskeyCandidate,
} from "../src/passkeys/vault";
import { createLoginGeneration } from "../src/service/generation";
import { createLocalRecipes } from "../src/service/local-recipes";
import { createRecipeSync } from "../src/service/recipes";
import { createServiceRuntime } from "../src/service/runtime";
import { createSettingsSync } from "../src/service/settings-sync";
import {
  createBrowserGeneratedSlotStorage,
  createBrowserGenerationAttemptStorage,
  createBrowserLocalRecipeStorage,
  createBrowserRecipeCacheStorage,
  createBrowserRecipeScheduleStorage,
  createBrowserServiceStorage,
  createBrowserSettingsBaseStorage,
  createBrowserSettingsHoldStorage,
  createBrowserVaultSyncStorage,
} from "../src/service/storage";
import { createServiceTransport } from "../src/service/transport";
import { createDiagnosticsHandler } from "../src/diagnostics/status";
import { createDiagnosticsLog } from "../src/diagnostics/background";
import { listenForBackgroundMessages, requestType } from "../src/messaging/background";
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
    settings: () => settings.read(),
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
    onSync: diagnosticsLog.vaultSync,
    onRefresh: diagnosticsLog.vaultRefresh,
  });
  // The manifest default is the locked icon; a running worker switches it.
  const actionIcon = createActionIcon({
    states: () => connections.vaultStates(),
    setIcon: (path) => browser.action.setIcon({ path }),
  });
  void actionIcon.refresh();
  // The toolbar badge (ADR 0038): a waiting account choice, a model request in flight, and
  // how the tab's last login ended.
  const loginBadge = createLoginBadge({
    setBadge: setActionBadge,
    storage: sessionValue(LOGIN_BADGE_KEY),
  });
  void loginBadge.restore();
  // Chrome resets a tab's badge when its page commits a navigation, which a url change
  // marks; the url shows only on pages Pateat can read.
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url !== undefined || change.status === "loading" || change.status === "complete")
      loginBadge.loaded(tabId, tab.url);
  });
  browser.tabs.onRemoved.addListener((tabId) => loginBadge.removed(tabId));
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
      login.settingsChanged("synced");
      passkeys.settingsChanged();
      diagnosticsLog.settingsChanged("synced");
    },
    deferred: () => login.active(),
    catalog: async () => {
      const current = await settings.handle({ version: 1, type: "settings.get" });
      return current.ok ? current.catalog : undefined;
    },
  });
  const recipeCacheStorage = createBrowserRecipeCacheStorage();
  const recipeScheduleStorage = createBrowserRecipeScheduleStorage();
  // Recipes kept here while no service is paired (ADR 0040); they read the synced cache
  // through `recipeSync`, which is created below with them and only calls them later.
  const localRecipes = createLocalRecipes({
    storage: createBrowserLocalRecipeStorage(),
    service,
    synced: () => recipeSync.cached(),
    transport: serviceTransport,
  });
  const recipeSync = createRecipeSync({
    service,
    transport: serviceTransport,
    storage: recipeCacheStorage,
    schedule: recipeScheduleStorage,
    settings: settingsSync,
    local: localRecipes,
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
  const vaultPasskeys = createVaultPasskeySource(connections);
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
    // A stopped worker would leave a refresh claimed and require password sign-in (ADR 0008).
    run: (connectionId, hold) => keepAlive(connections.service.autoSync(connectionId, hold)),
    loginActive: () => login.active(),
    report: diagnosticsLog.vaultCheck,
  });
  // ADR 0007: Pateat's own sign-ins per tab, which a site's passkey registration may follow.
  const signIns = createSignIns(sessionValue(SIGN_INS_KEY), (listener) =>
    browser.tabs.onRemoved.addListener(listener),
  );
  const noteSignIn = (tabId: number, origin: string, rpId?: string) =>
    void signIns.add(tabId, { origin, ...(rpId === undefined ? {} : { rpId }) }).catch(() => {});
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
        generateEntry: (...request) => keepAlive(serviceTransport.generateEntry(...request)),
        judgeCompletion: (...request) => keepAlive(serviceTransport.judgeCompletion(...request)),
      },
      storage: createBrowserGenerationAttemptStorage(),
      slotStorage: createBrowserGeneratedSlotStorage(),
      sync: () => recipeSync.sync(),
      refresh: () => recipeSync.sync({ settings: false }),
    }),
    // ADR 0027: a passkey handler runs only for an item Pateat can sign with.
    passkeys: (account) => itemPasskeyFacts(vaultPasskeys, account),
    // ADR 0034: a popup choice keeps the page's request only when an item holds a passkey.
    passkeyItems: (origin) => originPasskeyItems(vaultPasskeys, origin),
    report: (report) => {
      diagnosticsLog.login(report);
      loginBadge.observe(report);
    },
    signedIn: (tabId, origin) => noteSignIn(tabId, origin),
    badge: loginBadge,
  });
  const setupProbe = syntheticSetup?.handler(connections);
  const siteAccounts = createSiteAccountsHandler({
    settings,
    matchUris: vaultUris,
    findPasskeys: createVaultPasskeyFinder(connections),
    readField: vaultFields,
  });
  // ADR 0021: one Pateat window to choose among several matching passkeys.
  const passkeyChooser = createPasskeyChooser({
    pageUrl: browser.runtime.getURL(CHOOSER_PAGE),
    createWindow: (options) => browser.windows.create(options),
    removeWindow: (windowId) => browser.windows.remove(windowId),
    async tabWindowBounds(tabId) {
      const tab = await browser.tabs.get(tabId);
      return browser.windows.get(tab.windowId);
    },
    async focusTab(tabId) {
      const tab = await browser.tabs.get(tabId);
      await browser.windows.update(tab.windowId, { focused: true });
    },
    onWindowRemoved: (listener) => browser.windows.onRemoved.addListener(listener),
    onTabRemoved: (listener) => browser.tabs.onRemoved.addListener(listener),
    keepAlive,
  });
  // ADR 0021 D: after Pateat signed in a tab, a username-less request there asks again.
  const signedTabs = createSignedTabs(sessionValue(SIGNED_TABS_KEY), (listener) =>
    browser.tabs.onRemoved.addListener(listener),
  );

  // A tab Chrome discards to save memory gets a new ID; its sign-ins and badge stay with it.
  browser.tabs.onReplaced.addListener((added, removed) => {
    loginBadge.replaced(added, removed);
    void signIns.replaced(added, removed).catch(() => {});
    void signedTabs.replaced(added, removed).catch(() => {});
  });
  // Saving bumps the revision every login attempt checks; never stop a running login with it.
  const rememberPasskey = async (origin: string, candidate: VaultPasskeyCandidate) => {
    if (await login.active()) return;
    await rememberVaultPasskey({ settings: loginSettings, origin, candidate });
    // ADR 0034: the saved default ends a popup choice of that origin in another tab.
    login.siteDefaultSaved();
  };
  const passkeyProbe =
    import.meta.env.MODE === "probe"
      ? createProbePasskeySource(vaultPasskeys, rememberPasskey)
      : undefined;
  // ADR 0022 and ADR 0007: a returned assertion may complete a login and is a sign-in. The
  // vault item that signed it lets a login whose tab moved to the page that asked complete.
  const passkeyAnswered = (tabId: number, origin: string, rpId: string, signed: object) => {
    noteSignIn(tabId, origin, rpId);
    login.passkeyAnswered(
      tabId,
      origin,
      rpId,
      "connectionId" in signed &&
        typeof signed.connectionId === "string" &&
        "itemId" in signed &&
        typeof signed.itemId === "string"
        ? { connectionId: signed.connectionId, itemId: signed.itemId }
        : undefined,
    );
  };
  const passkeys = passkeyProbe
    ? createPasskeyRuntime(passkeyProbe.source, {
        extensionId: browser.runtime.id,
        timeoutMs: passkeyProbe.timeoutMs,
        policy: passkeyProbe.policy,
        chooser: passkeyChooser,
        remember: passkeyProbe.remember,
        loginAccount: login.loginAccount,
        requested: login.passkeyRequested,
        answered: passkeyAnswered,
        signedTabs,
        // ADR 0021 D: so does one after a control that logs out was clicked in the tab.
        logoutClicked: login.logoutClicked,
        conditional: login.conditionalRequest,
        hold: () => vaultSync.enter(false),
      })
    : createPasskeyRuntime(vaultPasskeys, {
        extensionId: browser.runtime.id,
        // Only the local log keeps it; the page never learns why.
        report: diagnosticsLog.passkey,
        chooser: passkeyChooser,
        remember: rememberPasskey,
        // ADR 0027: a running login's passkey request is answered with its own item.
        loginAccount: login.loginAccount,
        // ADR 0029: the login logs whether the page asked for a passkey after a step.
        requested: login.passkeyRequested,
        // ADR 0022: a login that moves on to the passkey's site after an answer completes.
        answered: passkeyAnswered,
        signedTabs,
        // ADR 0021 D: so does one after a control that logs out was clicked in the tab.
        logoutClicked: login.logoutClicked,
        // ADR 0034: the page's own conditional request waits for the login of its page.
        conditional: login.conditionalRequest,
        // The open vault is not replaced while a passkey request is looked up or signed.
        hold: () => vaultSync.enter(false),
      });
  // ADR 0007: a registration listing the vault's passkey right after a Pateat sign-in in the
  // tab is refused; every other one goes to the browser. It only reads the vault.
  const passkeyCreate = createPasskeyCreateHandler(passkeyProbe?.source ?? vaultPasskeys, {
    extensionId: browser.runtime.id,
    signIns,
    ...(passkeyProbe
      ? { timeoutMs: passkeyProbe.timeoutMs }
      : { report: diagnosticsLog.passkeyCreate }),
    hold: () => vaultSync.enter(false),
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
    async serviceDevice(origin) {
      const connection = await service.connection();
      // Paired again meanwhile, or rejected by a sync since the page's own read.
      return connection?.origin === origin && !connection.rejected
        ? serviceTransport.device(connection.origin, connection.credential)
        : undefined;
    },
    fetch: (input, init) => fetch(input, init),
    settings: async () => (await settings.read()).settings,
    logs: () => logger.summary(),
    recentLog: () => logger.recent(),
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
  // Wakes the worker at browser start so automatic unlock shows the unlocked icon.
  browser.runtime.onStartup.addListener(() => {
    void actionIcon.refresh();
  });
  listenForBackgroundMessages({
    settings: (request) =>
      settings.handle(request).then((response) => {
        if (requestType(request) === "settings.save" && response.ok) {
          login.settingsChanged("saved");
          passkeys.settingsChanged();
          diagnosticsLog.settingsChanged("saved");
          void recipeSync.sync();
        }
        return response;
      }),
    siteAccounts: (request) =>
      siteAccounts(request).catch(() => ({ version: 1, ok: false, reason: "unavailable" })),
    service: (request) => {
      const type = requestType(request);
      return service.handle(request).then(
        (response) => {
          // A completed pairing syncs at once; an open settings page keeps a stale cache moving.
          if (response.ok && response.state.kind === "connected") {
            if (type === "service.pair") void recipeSync.sync();
            else recipeSync.refreshIfStale();
          }
          // The previous owner's recipes are not kept once their device is gone.
          if ((type === "service.disconnect" || type === "service.forget") && response.ok)
            void recipeSync.clear();
          return response;
        },
        () => ({ ok: false, error: "storage-unavailable" }),
      );
    },
    recipes: (request) =>
      localRecipes
        .handle(request)
        .catch(() => ({ version: 1, ok: false, error: "storage-unavailable" })),
    diagnostics: (request) =>
      request.type === "diagnostics.status" ? diagnostics() : diagnosticsLog.handle(request),
    chooser: (request, sender) =>
      passkeyChooser.handle(request, sender)?.catch(() => ({ ok: false })),
    login: (request, sender) =>
      login.handle(request, sender).catch(() => ({ ok: false, reason: "runtime-unavailable" })),
    passkeyCreate: (request, sender) =>
      passkeyCreate
        .handle(request, sender)
        .catch(() => ({ kind: "delegate", reason: "runtime-unavailable" })),
    passkeys: (request, sender) => {
      // The runtime holds the open vault while it reads it for a request, but not while a
      // conditional request waits for a login (ADR 0034); a cancel never waits.
      if (requestType(request) === "passkey.get") vaultSync.refreshIfStale();
      return passkeys
        .handle(request, sender)
        .catch(() => ({ kind: "delegate", reason: "runtime-unavailable" }));
    },
    setupProbe:
      setupProbe &&
      ((request) =>
        setupProbe(request).catch(() => ({ ok: false, error: { code: "setup-unavailable" } }))),
    vaultProbe,
    cryptoProbe,
    passkeyProbe: passkeyProbe?.control,
    // Logged as the unhandled rejection it was before the library caught it.
    failed: diagnosticsLog.rejection,
  });
});
