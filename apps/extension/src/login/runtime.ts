import * as v from "valibot";
import {
  createAttemptMetadata,
  defaultLoginBinding,
  findLoginBinding,
  isSiteExcluded,
  nextLoginOperation,
  loginStepEffect,
  parseAttemptMetadata,
  recoverLoginAttempt,
  resolveBindingFields,
  resolveLoginPlan,
  sameLoginDocument,
  saveLoginChoice,
  siteDefaultConnection,
  transitionLoginAttempt,
  validateLoginOperation,
  type LoginAttemptEvent,
  type LoginAccountBinding,
  type LoginAttemptMetadata,
  type LoginDocument,
  type LoginOperation,
  type LoginRecipe,
  type LoginStep,
  type LoginTarget,
  type SavedLoginBinding,
  type SettingsResponse,
  type SettingsSnapshot,
  type VaultCatalog,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { browser, type Browser } from "wxt/browser";
import {
  authorizeSchema,
  awaitResultSchema,
  cancelSchema,
  configureSchema,
  executionResultSchema,
  helloSchema,
  observationSchema,
  statusSchema,
  probeControlSchema,
  loginReadiness,
  LOGIN_STEP_WAIT_MS,
  type LoginReadiness,
  type LoginSecretKind,
} from "./wire";
import {
  DEFAULT_PROBE_ORIGIN,
  DEMO_PROBE_ACCOUNT,
  grantProbeOrigin,
  probeBinding,
  probeFirstSteps,
  probeRecipe,
  type ProbeAccount,
} from "./dummy";
import { findLiveSiteCandidates, type LiveUriMatcher } from "../vault/site-candidates";
import type { LoginSites } from "./sites";
import { loginSecretKind, type LoginFieldSource } from "./vault";

const STORAGE_KEY = "pateat.login-attempts.v1";
const CONFIG_KEY = "pateat.login-probe-origin.v1";
type Sender = Browser.runtime.MessageSender;
type SettingsRuntime = {
  handle(value: unknown): Promise<SettingsResponse>;
  /** Trusted background mutation; saves an automatic account choice after `authenticated`. */
  update?(
    expectedRevision: number | undefined,
    mutate: (snapshot: SettingsSnapshot) => SettingsSnapshot,
  ): Promise<SettingsSnapshot>;
};
/** An account choice used by an attempt but not saved yet (ADR 0013). */
type UnsavedChoice = { binding: SavedLoginBinding; connectionId: string };
/** Settings with the choice added where missing; the same object when nothing changes. */
const withChoice = (value: SettingsSnapshot["settings"], choice: UnsavedChoice) =>
  saveLoginChoice(value, choice.binding, choice.connectionId);
type LiveDocument = {
  document: LoginDocument;
  token: string;
  /**
   * The document's browser-provided URL: the tab's committed URL for a same-origin top
   * document (it follows history.pushState), else `sender.url`. Provider URI rules match it.
   */
  url: string;
  path: string;
  /**
   * For a document in a frame inside the page: the tab's URL. The account must match it
   * as well as the frame's own URL (ADR 0017).
   */
  topUrl?: string;
  state?: string;
  reason?: string;
  /** A provider URI match for this document only, valid while its snapshot is unchanged. */
  uriMatch?: { connectionId: string; itemId: string; snapshotId: string };
  /** A single-match account choice, valid while every connection's snapshot is unchanged. */
  autoChoice?: { snapshots: string; connectionId: string; itemId: string };
  /** A provider URI match for `topUrl`, valid while its snapshot is unchanged. */
  topMatch?: { connectionId: string; itemId: string; snapshotId: string };
};
/** Documents are tracked per frame; a tab still runs at most one attempt. */
const frameKey = (document: { tabId: number; frameId: number }) =>
  `${document.tabId}:${document.frameId}`;
type Execution = {
  metadata: LoginAttemptMetadata;
  recipe: LoginRecipe;
  live: LiveDocument;
  running: boolean;
  operation?: LoginOperation;
  /** Saved only once this attempt reaches `authenticated`. */
  choice?: UnsavedChoice;
};
/** An in-memory catalog copy in which one item covers `origin`; never persisted. */
function withItemOrigin(
  catalog: VaultCatalog,
  account: { connectionId: string; itemId: string },
  origin: string,
): VaultCatalog {
  const granted = structuredClone(catalog);
  const item = granted.connections
    .find((entry) => entry.id === account.connectionId)
    ?.items.find((entry) => entry.id === account.itemId);
  if (item && !item.allowedOrigins.includes(origin)) item.allowedOrigins.push(origin);
  return granted;
}
const terminal = (metadata: LoginAttemptMetadata) =>
  ["authenticated", "blocked"].includes(metadata.state);

/**
 * Cached recipes. Account bindings come from synced settings (`settings.bindings`,
 * ADR 0013); neither carries values.
 */
export interface LoginRecipes {
  /** The recipe for a document, or an attempt's own recipe by ID after navigation. */
  recipe(origin: string, path: string, recipeId?: string): Promise<LoginRecipe | undefined>;
  /** The first step of every recipe for the origin; a document watches for them to appear. */
  firstSteps(origin: string): Promise<LoginStep[]>;
}
export const noLoginRecipes: LoginRecipes = {
  recipe: async () => undefined,
  firstSteps: async () => [],
};
const probeMode = import.meta.env.MODE === "probe";

/**
 * Coordinator is packaged production code. Production admits only `sites` documents and
 * uses `recipes`; the loopback probe adapter and its controls exist only in the probe build.
 * Account metadata comes from each live settings read; values come from `fields` per fill.
 */
export function createLoginRuntime(
  settings: SettingsRuntime,
  options: {
    fields: LoginFieldSource;
    sites?: LoginSites;
    recipes?: LoginRecipes;
    /** Live provider URI matching; without it only static `allowedOrigins` apply. */
    uris?: LiveUriMatcher;
  },
) {
  const { fields, sites, recipes = noLoginRecipes, uris } = options;
  let origin = DEFAULT_PROBE_ORIGIN;
  let account: ProbeAccount = DEMO_PROBE_ACCOUNT;
  const documents = new Map<string, LiveDocument>();
  const attempts = new Map<number, Execution>();
  const persisted = new Map<number, LoginAttemptMetadata>();
  let storageQueue: Promise<void> = Promise.resolve();
  let storageHealthy = true;
  let checkpoint: "before-delivery" | "before-ack" | undefined;
  let armed: "before-delivery" | "before-ack" | "intent-write-failure" | undefined;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseCheckpoint: (() => void) | undefined;
  async function pause(at: "before-delivery" | "before-ack"): Promise<void> {
    if (import.meta.env.MODE !== "probe" || armed !== at) return;
    clearTimeout(armTimer);
    armed = undefined;
    checkpoint = at;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        releaseCheckpoint = undefined;
        checkpoint = undefined;
        reject(new Error("Synthetic checkpoint expired"));
      }, 5000);
      releaseCheckpoint = () => {
        clearTimeout(timer);
        checkpoint = undefined;
        releaseCheckpoint = undefined;
        resolve();
      };
    });
  }
  const loaded = (async () => {
    try {
      await browser.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      const storage = await browser.storage.local.get([STORAGE_KEY, CONFIG_KEY]);
      const config: unknown = storage[CONFIG_KEY];
      if (probeMode && config !== undefined) {
        const parsed = v.parse(configureSchema, {
          version: 1,
          type: "login.probe.configure",
          ...(typeof config === "string" ? { origin: config } : (config as object)),
        });
        origin = parsed.origin;
        account = parsed.account ?? DEMO_PROBE_ACCOUNT;
      }
      const stored = storage[STORAGE_KEY];
      if (stored === undefined) return;
      if (!Array.isArray(stored) || stored.length > 100) throw new Error("Invalid attempt store");
      for (const entry of stored) {
        const metadata = recoverLoginAttempt(parseAttemptMetadata(entry));
        if (persisted.has(metadata.document.tabId)) throw new Error("Duplicate attempt scope");
        persisted.set(metadata.document.tabId, metadata);
      }
      // Complete startup reconciliation before accepting any hello or checking
      // ownership. Closing a tab can wake a worker whose in-memory map is empty.
      const openTabs = await browser.tabs.query({});
      const liveIds = new Set(openTabs.map((tab) => tab.id));
      for (const tabId of persisted.keys()) if (!liveIds.has(tabId)) persisted.delete(tabId);
      await browser.storage.local.set({ [STORAGE_KEY]: [...persisted.values()] });
    } catch {
      storageHealthy = false;
    }
  })();
  const hellos = new Map<string, number>();
  const probeDocument = (url: URL) =>
    probeMode && url.origin === origin && url.protocol === "http:" && url.hostname === "127.0.0.1";
  // The synthetic fixture embeds its frames in a page on another loopback port to test refusal.
  const probeTop = (url: URL) =>
    probeMode && url.protocol === "http:" && url.hostname === "127.0.0.1";
  const admitted = async (url: URL) =>
    probeDocument(url) || Boolean(sites && (await sites.admits(url)));
  /**
   * The browser-identified document. A frame inside the page is admitted only when the
   * tab's page is admitted too; excluded sites stop it on either side (ADR 0017).
   */
  async function identify(sender: Sender): Promise<LoginDocument | undefined> {
    if (
      sender.id !== browser.runtime.id ||
      sender.tab?.id === undefined ||
      sender.frameId === undefined ||
      !sender.documentId ||
      // A prerendered page also has a nonzero frame ID; it is not a frame of the tab.
      (sender as { documentLifecycle?: string }).documentLifecycle === "prerender" ||
      !sender.url
    )
      return undefined;
    try {
      const url = new URL(sender.url);
      if (!(await admitted(url))) return undefined;
      if (sender.frameId !== 0) {
        const top = sender.tab.url ? new URL(sender.tab.url) : undefined;
        if (!top || !(probeTop(top) || (await admitted(top)))) return undefined;
      }
      return {
        origin: url.origin,
        tabId: sender.tab.id,
        frameId: sender.frameId,
        documentId: sender.documentId,
      };
    } catch {
      return undefined;
    }
  }
  const trusted = (sender: Sender) =>
    sender.id === browser.runtime.id &&
    sender.url === browser.runtime.getURL("/options.html") &&
    !sender.tab?.url?.startsWith("http:");
  function current(run: Execution): boolean {
    return (
      attempts.get(run.live.document.tabId) === run &&
      documents.get(frameKey(run.live.document)) === run.live
    );
  }
  async function save(run: Execution): Promise<void> {
    await keep(run.metadata);
  }
  async function keep(metadata: LoginAttemptMetadata): Promise<void> {
    persisted.set(metadata.document.tabId, parseAttemptMetadata(metadata));
    const snapshot = [...persisted.values()];
    storageQueue = storageQueue.then(async () => {
      if (!storageHealthy) throw new Error("Attempt storage unavailable");
      await browser.storage.local.set({ [STORAGE_KEY]: snapshot });
      return undefined;
    });
    try {
      await storageQueue;
    } catch {
      storageHealthy = false;
      throw new Error("Attempt storage unavailable");
    }
  }
  async function change(run: Execution, event: LoginAttemptEvent): Promise<void> {
    if (!current(run)) return;
    run.metadata = transitionLoginAttempt(run.metadata, event);
    if (
      import.meta.env.MODE === "probe" &&
      armed === "intent-write-failure" &&
      (event.type === "MUTATION_INTENT" || event.type === "SUBMIT_INTENT")
    ) {
      armed = undefined;
      clearTimeout(armTimer);
      storageHealthy = false;
      throw new Error("Synthetic intent write failed");
    }
    await save(run);
    await publish(run.live, run.metadata);
    if (run.metadata.state === "authenticated" && run.choice) await remember(run);
  }
  /**
   * Saves an automatic account choice after `authenticated` (ADR 0013). The settings must
   * still be the revision the attempt was authorized under; otherwise nothing is saved and
   * the next login chooses again.
   */
  async function remember(run: Execution): Promise<void> {
    const choice = run.choice;
    delete run.choice;
    const { account: used } = run.metadata;
    if (
      !choice ||
      !settings.update ||
      // Only the account this attempt authenticated with may be saved.
      choice.connectionId !== used.connectionId ||
      choice.binding.itemId !== used.itemId ||
      choice.binding.origin !== used.origin ||
      // Saving bumps the revision every attempt checks; never stop another login with it.
      [...attempts.values()].some(
        (other) => other !== run && current(other) && !terminal(other.metadata),
      )
    )
      return;
    // Writing bumps the policy revision for every attempt, so skip a choice already saved.
    const latest = await settings.handle({ version: 1, type: "settings.get" });
    if (!latest.ok || withChoice(latest.snapshot.settings, choice) === latest.snapshot.settings)
      return;
    await settings
      .update(run.metadata.policyRevision, (snapshot) => ({
        ...snapshot,
        settings: withChoice(snapshot.settings, choice),
      }))
      .catch(() => undefined);
  }
  async function send(live: LiveDocument, message: Record<string, unknown>): Promise<unknown> {
    return browser.tabs.sendMessage(
      live.document.tabId,
      { version: 1, token: live.token, ...message },
      { documentId: live.document.documentId, frameId: live.document.frameId },
    );
  }
  async function publish(live: LiveDocument, metadata?: LoginAttemptMetadata): Promise<void> {
    if (documents.get(frameKey(live.document)) !== live) return;
    await send(live, {
      type: "login.status",
      state: metadata?.state ?? live.state ?? "denied",
      stepIndex: metadata?.stepIndex ?? 0,
      ...(metadata?.outcome || live.reason ? { outcome: metadata?.outcome ?? live.reason } : {}),
    }).catch(() => undefined);
  }
  type Choice = { connectionId: string; itemId: string; saved: boolean };
  type Refusal = { reason: string };
  /**
   * The account for this document. A saved site default wins. Without one, a single
   * eligible provider URI match across all enabled connections is used for this attempt
   * only (ADR 0013); none, several, or any connection or item that could not be evaluated
   * refuses rather than guessing.
   */
  async function choose(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
  ): Promise<Choice | Refusal> {
    const saved = snapshot.snapshot.settings.siteDefaults.find(
      (entry) => entry.origin === live.document.origin,
    );
    if (saved) {
      const connection = siteDefaultConnection(saved, snapshot.catalog);
      return connection.ok
        ? { connectionId: connection.connectionId, itemId: saved.itemId, saved: true }
        : { reason: connection.reason };
    }
    if (!uris) return { reason: "default-not-set" };
    // Any sync replaces a snapshot ID, so a new match from a later sync is still noticed.
    const snapshots = JSON.stringify(
      snapshot.catalog.connections.map((entry) => [entry.id, entry.snapshotId, entry.state]),
    );
    const cached = live.autoChoice;
    if (cached?.snapshots === snapshots)
      return { connectionId: cached.connectionId, itemId: cached.itemId, saved: false };
    delete live.autoChoice;
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: snapshot.catalog,
      url: live.url,
      match: uris,
    });
    if (!scope.ok) return { reason: scope.reason };
    if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
    if (scope.incompleteItems.length > 0) return { reason: "item-uri-unevaluated" };
    let candidates = scope.candidates;
    if (live.topUrl) {
      // In a frame, only items that also match the tab's URL are eligible (ADR 0017).
      const top = await findLiveSiteCandidates({
        settings: snapshot.snapshot.settings,
        catalog: snapshot.catalog,
        url: live.topUrl,
        match: uris,
      });
      if (!top.ok) return { reason: top.reason };
      if (top.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
      if (top.incompleteItems.length > 0) return { reason: "item-uri-unevaluated" };
      candidates = candidates.filter((entry) =>
        top.candidates.some(
          (other) => other.connectionId === entry.connectionId && other.itemId === entry.itemId,
        ),
      );
    }
    if (candidates.length > 1) return { reason: "account-ambiguous" };
    const [only] = candidates;
    if (!only) return { reason: "default-not-set" };
    // The same answer covers the item origin check below; no second query is needed.
    live.uriMatch = {
      connectionId: only.connectionId,
      itemId: only.itemId,
      snapshotId: only.snapshotId,
    };
    live.autoChoice = { snapshots, connectionId: only.connectionId, itemId: only.itemId };
    return { connectionId: only.connectionId, itemId: only.itemId, saved: false };
  }
  /**
   * Origin scope for the chosen account of this document. A live provider URI match for
   * the document's own URL satisfies the item origin check for that document only; it is
   * never saved as `allowedOrigins`. Only the chosen account's connection is asked, and a
   * match is reused while that connection's snapshot is unchanged.
   */
  async function liveScope(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    selected: { connectionId: string; itemId: string },
  ): Promise<{ catalog: VaultCatalog } | { reason: "vault-unavailable" | "item-uri-unevaluated" }> {
    const { catalog } = snapshot;
    const connection = catalog.connections.find((entry) => entry.id === selected.connectionId);
    const item = connection?.items.find((entry) => entry.id === selected.itemId);
    if (!uris || !connection?.snapshotId || connection.provider !== "bitwarden") return { catalog };
    if (!item || item.allowedOrigins.includes(live.document.origin)) return { catalog };
    // An item awaiting field review is unavailable; do not report it as a URI mismatch.
    if (connection.quarantinedItemIds?.includes(item.id)) return { reason: "vault-unavailable" };
    const cached = live.uriMatch;
    if (
      !cached ||
      cached.connectionId !== selected.connectionId ||
      cached.itemId !== selected.itemId ||
      cached.snapshotId !== connection.snapshotId
    ) {
      delete live.uriMatch;
      const scope = await findLiveSiteCandidates({
        settings: snapshot.snapshot.settings,
        catalog: { connections: [connection] },
        url: live.url,
        match: uris,
      });
      if (!scope.ok) return { catalog };
      const matched = scope.candidates.some(
        (entry) => entry.itemId === selected.itemId && entry.snapshotId === connection.snapshotId,
      );
      if (!matched) {
        // Unevaluated rules may still cover this page; never treat them as a mismatch.
        if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
        return scope.incompleteItems.some((entry) => entry.itemId === selected.itemId)
          ? { reason: "item-uri-unevaluated" }
          : { catalog };
      }
      live.uriMatch = {
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        snapshotId: connection.snapshotId,
      };
    }
    return { catalog: withItemOrigin(catalog, selected, live.document.origin) };
  }
  /**
   * For a document in a frame inside the page, the chosen item must also match the tab's
   * URL, as the official Bitwarden client requires before it fills a frame (ADR 0017).
   * `granted` is the catalog whose static `allowedOrigins` count; a live provider URI
   * match is reused while that connection's snapshot is unchanged.
   */
  async function topScope(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    selected: { connectionId: string; itemId: string },
    granted: VaultCatalog,
  ): Promise<{ reason: string } | undefined> {
    if (!live.topUrl) return undefined;
    const top = new URL(live.topUrl).origin;
    if (isSiteExcluded(snapshot.snapshot.settings, top)) return { reason: "site-excluded" };
    const item = granted.connections
      .find((entry) => entry.id === selected.connectionId)
      ?.items.find((entry) => entry.id === selected.itemId);
    if (item?.allowedOrigins.includes(top)) return undefined;
    const connection = snapshot.catalog.connections.find(
      (entry) => entry.id === selected.connectionId,
    );
    if (!uris || !connection?.snapshotId || connection.provider !== "bitwarden")
      return { reason: "frame-top-mismatch" };
    const cached = live.topMatch;
    if (
      cached?.connectionId === selected.connectionId &&
      cached.itemId === selected.itemId &&
      cached.snapshotId === connection.snapshotId
    )
      return undefined;
    delete live.topMatch;
    const scope = await findLiveSiteCandidates({
      settings: snapshot.snapshot.settings,
      catalog: { connections: [connection] },
      url: live.topUrl,
      match: uris,
    });
    if (!scope.ok) return { reason: scope.reason };
    if (
      scope.candidates.some(
        (entry) => entry.itemId === selected.itemId && entry.snapshotId === connection.snapshotId,
      )
    ) {
      live.topMatch = {
        connectionId: selected.connectionId,
        itemId: selected.itemId,
        snapshotId: connection.snapshotId,
      };
      return undefined;
    }
    if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
    if (scope.incompleteItems.some((entry) => entry.itemId === selected.itemId))
      return { reason: "item-uri-unevaluated" };
    return { reason: "frame-top-mismatch" };
  }
  /**
   * The synced binding of the chosen item, or the automatic one for built-in slots, mapped
   * to this device's field IDs by the catalog's raw field names.
   */
  function bindingFor(
    catalog: VaultCatalog,
    settingsValue: SettingsSnapshot["settings"],
    recipe: LoginRecipe,
    choice: Choice,
    documentOrigin: string,
  ):
    | { ok: true; binding: LoginAccountBinding; synced: SavedLoginBinding; saved: boolean }
    | { ok: false; reason: string } {
    const connection = catalog.connections.find((entry) => entry.id === choice.connectionId);
    const item = connection?.items.find((entry) => entry.id === choice.itemId);
    if (!connection?.userId || !item) return { ok: false, reason: "vault-unavailable" };
    const owner = { provider: connection.provider, userId: connection.userId, itemId: item.id };
    const saved = findLoginBinding(settingsValue.bindings ?? [], recipe, owner);
    const binding = saved ?? defaultLoginBinding(recipe, { ...owner, itemName: item.label });
    if (!binding) return { ok: false, reason: "binding-not-found" };
    const resolved = resolveBindingFields(
      binding,
      recipe,
      item.fields.map((field) => ({ id: field.id, name: field.name })),
    );
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    return {
      ok: true,
      binding: {
        origin: documentOrigin,
        connectionId: connection.id,
        itemId: item.id,
        slots: resolved.slots,
      },
      synced: binding,
      saved: saved !== undefined,
    };
  }
  /** One account must resolve from a usable connection, and its item must not await review. */
  async function planFor(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    recipe: LoginRecipe,
  ) {
    let catalog: VaultCatalog;
    let policy = snapshot.snapshot;
    let binding: LoginAccountBinding | undefined;
    let choice: UnsavedChoice | undefined;
    if (probeMode && recipe.origin === origin) {
      catalog = grantProbeOrigin(snapshot.catalog, origin, account);
      binding = probeBinding(recipe, account);
      const top = await topScope(snapshot, live, account, catalog);
      if (top) return { ok: false as const, reason: top.reason };
    } else {
      const chosen = await choose(snapshot, live);
      if ("reason" in chosen) return { ok: false as const, reason: chosen.reason };
      const scope = await liveScope(snapshot, live, chosen);
      if ("reason" in scope) return { ok: false as const, reason: scope.reason };
      const top = await topScope(snapshot, live, chosen, snapshot.catalog);
      if (top) return { ok: false as const, reason: top.reason };
      catalog = scope.catalog;
      if (!chosen.saved) {
        // The automatic choice acts as this document's default in memory only; the
        // connection-ID form is fine here because this copy is never saved.
        policy = structuredClone(policy);
        policy.settings.siteDefaults.push({
          origin: live.document.origin,
          connectionId: chosen.connectionId,
          itemId: chosen.itemId,
        });
      }
      const bound = bindingFor(
        catalog,
        snapshot.snapshot.settings,
        recipe,
        chosen,
        live.document.origin,
      );
      if (!bound.ok) return { ok: false as const, reason: bound.reason };
      binding = bound.binding;
      if (!chosen.saved || !bound.saved)
        choice = { binding: bound.synced, connectionId: chosen.connectionId };
    }
    const plan = resolveLoginPlan(policy, catalog, live.url, recipe, binding);
    if (!plan.ok) return plan;
    const connection = catalog.connections.find((entry) => entry.id === plan.account.connectionId);
    if (
      !connection ||
      // Review blocks only the affected items; unrelated items in the connection stay usable.
      (connection.state !== undefined &&
        connection.state !== "ready" &&
        connection.state !== "review-required") ||
      connection.quarantinedItemIds?.includes(plan.account.itemId)
    )
      return { ok: false as const, reason: "vault-unavailable" as const };
    return { ...plan, connection, ...(choice ? { choice } : {}) };
  }
  type Authorized = { connection: VaultConnectionMetadata; binding: LoginAccountBinding };
  /** Resolve against a fresh live catalog; returns the authorizing metadata and binding. */
  async function allowed(run: Execution): Promise<Authorized | undefined> {
    if (!current(run) || !storageHealthy) return undefined;
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!current(run)) return undefined;
    if (!snapshot.ok || snapshot.snapshot.revision !== run.metadata.policyRevision) {
      await change(run, { type: "POLICY_CHANGED" });
      return undefined;
    }
    const plan = await planFor(snapshot, run.live, run.recipe);
    if (
      !plan.ok ||
      plan.account.connectionId !== run.metadata.account.connectionId ||
      plan.account.itemId !== run.metadata.account.itemId
    ) {
      await change(run, { type: "POLICY_CHANGED" });
      return undefined;
    }
    return { connection: plan.connection, binding: plan.binding };
  }
  async function observe(run: Execution, targets: LoginTarget[]) {
    // Exclusion/default/policy checks precede even metadata observation.
    if (!(await allowed(run))) return undefined;
    const response = await send(run.live, { type: "login.observe", path: run.live.path, targets });
    if (!current(run)) return undefined;
    const parsed = v.safeParse(observationSchema, response);
    return parsed.success ? parsed.output : undefined;
  }
  /**
   * Asks the document to wait for a step's elements. A document that went away or was
   * cancelled leaves the attempt as it is; its replacement document resumes it.
   */
  async function waitFor(
    run: Execution,
    readiness: LoginReadiness,
  ): Promise<"ready" | "timeout" | "gone"> {
    try {
      const response = await send(run.live, {
        type: "login.await",
        readiness,
        timeoutMs: LOGIN_STEP_WAIT_MS,
      });
      const parsed = v.safeParse(awaitResultSchema, response);
      if (!parsed.success) return "gone";
      return parsed.output.ok ? "ready" : parsed.output.reason === "timeout" ? "timeout" : "gone";
    } catch {
      return "gone";
    }
  }
  async function reconcile(run: Execution, settleUnknown = false): Promise<void> {
    const nextIndex =
      run.metadata.operationKind === "click" || run.metadata.operationEffect === "advance"
        ? run.metadata.stepIndex + 1
        : run.metadata.stepIndex;
    const next = run.recipe.steps[nextIndex];
    const nextTargets =
      next?.kind === "fill" ? next.fields.map((field) => field.target) : next ? [next.target] : [];
    const { completion, rejection } = run.recipe;
    const targets = [
      ...(completion ? [completion.target] : []),
      ...(rejection ? [rejection] : []),
      ...nextTargets,
    ];
    const observed = await observe(run, targets);
    if (!observed) return;
    // Without a completion target nothing proves a sign-in, so the attempt can settle
    // only as rejected, continued or unknown.
    if (completion && observed.path === completion.path && observed.targets[0] === "unique") {
      await change(run, { type: "OBSERVED", result: "authenticated", document: run.live.document });
      return;
    }
    const rejectionIndex = completion ? 1 : 0;
    if (rejection && observed.targets[rejectionIndex] === "unique") {
      await change(run, {
        type: "OBSERVED",
        result: "credential-rejected",
        document: run.live.document,
      });
      return;
    }
    const offset = rejectionIndex + (rejection ? 1 : 0);
    if (
      next &&
      observed.path === next.path &&
      nextTargets.length &&
      observed.targets.slice(offset).every((state) => state === "unique") &&
      // A pending click advances only after evidence of its configured next page.
      (!(run.metadata.operationKind === "click" || run.metadata.operationEffect === "advance") ||
        run.recipe.steps[run.metadata.stepIndex]?.path !== next.path)
    ) {
      const continuation: LoginAttemptEvent = {
        type: "OBSERVED",
        result: "continue",
        document: run.live.document,
      };
      // Remaining fields alone do not prove that an uncertain input effect finished.
      const candidate = transitionLoginAttempt(run.metadata, continuation);
      if (candidate.state === "ready" || candidate.state === "retryable") {
        await change(run, continuation);
        return;
      }
    }
    if (settleUnknown)
      await change(run, { type: "OBSERVED", result: "unknown", document: run.live.document });
  }
  // State transitions, journal writes and DOM effects form an ordered protocol.
  // Parallel execution would race policy checks or repeat submission side effects.
  /* eslint-disable no-await-in-loop */
  async function reconcileBounded(run: Execution): Promise<void> {
    // An advance is confirmed by the next step's elements, which get the same wait as any
    // fill or click; other results keep the shorter observation budget.
    const until =
      Date.now() + (run.metadata.operationEffect === "advance" ? LOGIN_STEP_WAIT_MS : 3000);
    const observing = () => ["awaiting-result", "reconciling"].includes(run.metadata.state);
    // Each round re-authorizes against settings, so the longer advance budget polls slower.
    const interval = run.metadata.operationEffect === "advance" ? 200 : 50;
    while (current(run) && observing() && Date.now() < until) {
      await reconcile(run);
      if (!observing()) return;
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
    if (current(run) && observing()) await reconcile(run, true);
  }
  async function drive(run: Execution): Promise<void> {
    if (run.running) return;
    run.running = true;
    try {
      if (run.metadata.state === "reconciling" || run.metadata.state === "awaiting-result")
        await reconcileBounded(run);
      while (current(run) && run.metadata.state === "ready") {
        if (!(await allowed(run))) return;
        // A fill or click waits for its elements before any intent, vault read or value
        // delivery; a slow render is not a failure until the owner-approved limit passes.
        const upcoming = run.recipe.steps[run.metadata.stepIndex];
        if (upcoming?.kind === "fill" || upcoming?.kind === "click") {
          const waited = await waitFor(run, loginReadiness(upcoming));
          if (!current(run) || run.metadata.state !== "ready") return;
          if (waited === "timeout") {
            await change(run, { type: "FAILED", reason: "structural-mismatch" });
            return;
          }
          if (waited !== "ready" || !(await allowed(run))) return;
        }
        const operation = nextLoginOperation(
          run.metadata,
          run.recipe,
          run.live.document,
          crypto.randomUUID(),
        );
        if (!operation) {
          await change(run, { type: "FAILED", reason: "structural-mismatch" });
          return;
        }
        await change(run, {
          type: "PREPARE",
          operationId: operation.operationId,
          kind: operation.step.kind,
          effect: loginStepEffect(operation.step),
        });
        if (operation.step.kind === "click")
          await change(run, { type: "SUBMIT_INTENT", operationId: operation.operationId });
        else if (operation.step.kind === "fill")
          await change(run, { type: "MUTATION_INTENT", operationId: operation.operationId });
        run.operation = operation;
        const authorized = await allowed(run);
        if (!authorized) return;
        if (
          !validateLoginOperation(
            operation,
            run.metadata,
            run.live.document,
            run.metadata.policyRevision,
          )
        ) {
          await change(run, { type: "FAILED", reason: "timeout" });
          return;
        }
        const values: { slot: string; value: string; secret?: LoginSecretKind }[] = [];
        let response: unknown;
        try {
          if (operation.step.kind === "fill") {
            for (const field of operation.step.fields) {
              const reference = authorized.binding.slots.find((entry) => entry.slot === field.slot);
              if (!reference) {
                await change(run, { type: "FAILED", reason: "structural-mismatch" });
                return;
              }
              // Vault reads are serial so a denial stops before any later field is released.
              let value: string | undefined;
              try {
                value = await fields({
                  account: run.metadata.account,
                  connection: authorized.connection,
                  fieldId: reference.fieldId,
                });
              } catch {
                // A failed read is not a page mutation; never reclassify it as uncertain.
                value = undefined;
              }
              if (!current(run)) return;
              // Locked, resynchronized or newly denied vault access withdraws this grant.
              if (value === undefined) {
                await change(run, { type: "POLICY_CHANGED" });
                return;
              }
              const secret = loginSecretKind(
                authorized.connection,
                run.metadata.account.itemId,
                reference.fieldId,
              );
              values.push({ slot: field.slot, value, ...(secret ? { secret } : {}) });
            }
          }
          if (operation.step.kind === "fill" || operation.step.kind === "click")
            await pause("before-delivery");
          if (!current(run)) return;
          const latest = await allowed(run);
          if (!latest) return;
          // Values belong to the snapshot that authorized them; a replacement withdraws them.
          if (latest.connection.snapshotId !== authorized.connection.snapshotId) {
            await change(run, { type: "POLICY_CHANGED" });
            return;
          }
          response = await send(run.live, { type: "login.execute", operation, values });
        } finally {
          for (const entry of values) entry.value = "";
        }
        if (!current(run)) return;
        if (operation.step.kind === "fill" || operation.step.kind === "click")
          await pause("before-ack");
        if (!current(run)) return;
        delete run.operation;
        const result = v.safeParse(executionResultSchema, response);
        const matchedResult =
          result.success &&
          result.output.operationId === operation.operationId &&
          result.output.documentId === run.live.document.documentId;
        if (!matchedResult || !result.output.ok) {
          await change(
            run,
            matchedResult && result.output.reason === "cancelled"
              ? { type: "CANCEL" }
              : {
                  type: "FAILED",
                  reason:
                    matchedResult && result.output.reason === "timeout"
                      ? "timeout"
                      : "structural-mismatch",
                  mutation: matchedResult ? result.output.mutation : "possible",
                  operationId: operation.operationId,
                  document: run.live.document,
                },
          );
          return;
        }
        if (
          operation.step.kind !== "click" &&
          !(operation.step.kind === "fill" && operation.step.effect !== "prepare")
        ) {
          await change(run, { type: "OPERATION_OK", operationId: operation.operationId });
          continue;
        }
        await change(run, { type: "SUBMITTED", operationId: operation.operationId });
        // DOM navigation can replace this document. A same-page result is observed with a finite budget.
        await reconcileBounded(run);
        if (run.metadata.state !== "ready") return;
      }
    } catch {
      if (current(run) && !terminal(run.metadata)) {
        run.metadata = recoverLoginAttempt(run.metadata);
        await save(run).catch(() => undefined);
        await publish(run.live, run.metadata);
      }
    } finally {
      run.running = false;
    }
  }
  /* eslint-enable no-await-in-loop */
  /**
   * First steps a document watches for; deduplicated and bounded for the wire. A path
   * where several recipes start is left out, because such a page cannot start (ADR 0013).
   */
  async function startsFor(documentOrigin: string): Promise<LoginReadiness[]> {
    const all =
      probeMode && documentOrigin === origin
        ? probeFirstSteps(origin)
        : await recipes.firstSteps(documentOrigin).catch(() => []);
    const steps = all.filter(
      (step) => all.filter((other) => other.path === step.path).length === 1,
    );
    const unique = new Map(
      steps.map((step) => {
        const readiness = loginReadiness(step);
        return [JSON.stringify(readiness), readiness];
      }),
    );
    return [...unique.values()].slice(0, 32);
  }
  async function ready(
    sender: Sender,
    token: string,
    start?: { path: string },
  ): Promise<{ ok: boolean; reason?: string; starts?: LoginReadiness[] }> {
    // Admission is async; a later hello from the same frame must not be overtaken by an older one.
    const helloKey = `${sender.tab?.id}:${sender.frameId}`;
    const sequence = (hellos.get(helloKey) ?? 0) + 1;
    hellos.set(helloKey, sequence);
    await loaded;
    const document = await identify(sender);
    if (!document || !sender.url) return { ok: false, reason: "unauthorized-document" };
    if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    const key = frameKey(document);
    // `sender.url` keeps the URL the document loaded with; a same-document URL change
    // (history.pushState) of the tab's page shows only in the tab's committed URL. A frame
    // inside the page keeps its load URL and records the tab's URL to match as well.
    let url = sender.url;
    let topUrl: string | undefined;
    try {
      const tab = await browser.tabs.get(document.tabId);
      if (document.frameId !== 0) {
        if (!tab.url) return { ok: false, reason: "stale-document" };
        topUrl = tab.url;
      } else if (tab.url && new URL(tab.url).origin === document.origin) url = tab.url;
    } catch {
      return { ok: false, reason: "closed-tab" };
    }
    if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    // A tab runs one attempt. Another frame of the tab, such as an embedded widget or the
    // page around a framed login, never takes it over or disturbs it. Only a new page in
    // the tab (another top document) ends an attempt held by a frame of the old page.
    let owner = attempts.get(document.tabId)?.metadata ?? persisted.get(document.tabId);
    const page = documents.get(frameKey({ tabId: document.tabId, frameId: 0 }));
    let newPage =
      document.frameId === 0 &&
      page !== undefined &&
      page.document.documentId !== document.documentId;
    if (newPage) {
      // Frames of this page may have announced before it did. Only documents that no
      // longer answer went away with the old page.
      // A frame that does not answer in time counts as still there.
      const frames = [...documents].filter(
        ([, entry]) => entry.document.tabId === document.tabId && entry.document.frameId !== 0,
      );
      const answers = await Promise.all(
        frames.map(([, entry]) =>
          Promise.race([
            send(entry, { type: "login.observe", path: entry.path, targets: [] }).then(
              () => true,
              () => false,
            ),
            new Promise<boolean>((resolve) => setTimeout(resolve, 1000, true)),
          ]),
        ),
      );
      for (const [index, [other]] of frames.entries()) if (!answers[index]) documents.delete(other);
      if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
      owner = attempts.get(document.tabId)?.metadata ?? persisted.get(document.tabId);
      const holder = owner && documents.get(frameKey(owner.document));
      if (owner && owner.document.frameId !== 0) {
        if (holder && sameLoginDocument(holder.document, owner.document)) {
          // The frame holding the attempt is still there, so this page is its parent.
          newPage = false;
        } else if (!terminal(owner)) {
          // The frame's page is gone: its attempt ends without resubmitting, whatever
          // origin the new page has.
          const run = attempts.get(document.tabId);
          const ended = transitionLoginAttempt(run?.metadata ?? recoverLoginAttempt(owner), {
            type: "NAVIGATED",
            document,
          });
          if (run) run.metadata = ended;
          try {
            await keep(ended);
          } catch {
            return { ok: false, reason: "storage-unavailable" };
          }
          if (hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
          owner = ended;
        }
      }
    }
    // A busy document is still recorded, so a later new page in the tab is recognized.
    const busy = owner !== undefined && owner.document.frameId !== document.frameId && !newPage;
    const oldLive = documents.get(key);
    const sameDocument = oldLive !== undefined && sameLoginDocument(oldLive.document, document);
    // A document may announce again when its form appears or its URL changes in place,
    // but never while it already carries an attempt, terminal or not.
    if (sameDocument && (oldLive.token !== token || attempts.get(document.tabId)?.live === oldLive))
      return { ok: false, reason: "duplicate-document" };
    if (oldLive && !sameDocument)
      await send(oldLive, { type: "login.cancel" }).catch(() => undefined);
    const live: LiveDocument = {
      document,
      token,
      url,
      path: new URL(url).pathname,
      ...(topUrl ? { topUrl } : {}),
    };
    documents.set(key, live);
    const refuse = async (reason: string) => {
      live.state = "denied";
      live.reason = reason;
      await publish(live);
      return { ok: false, reason };
    };
    if (busy) return refuse("tab-busy");
    if (!storageHealthy) return refuse("storage-unavailable");
    const previous = attempts.get(document.tabId)?.metadata ?? persisted.get(document.tabId);
    // Look up the recipe first: a page without one never opens the policy catalog or vault.
    const recipe =
      probeMode && document.origin === origin
        ? previous
          ? probeRecipe(origin, `/${previous.recipeId.replace(/^demo-/, "")}`)
          : probeRecipe(origin, live.path)
        : await recipes.recipe(document.origin, live.path, previous?.recipeId);
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // A new attempt starts only once the document reports its recipe's first step ready.
    // Until then it watches the first steps of every recipe for its origin; this reads
    // no settings, policy catalog or vault.
    if (
      !previous &&
      (!recipe || (loginReadiness(recipe.steps[0]!).targets.length && start?.path !== live.path))
    ) {
      const starts = await startsFor(document.origin);
      if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (!recipe && !starts.length) return refuse("recipe-not-found");
      live.state = "watching";
      delete live.reason;
      await publish(live);
      return { ok: false, reason: recipe ? "form-not-ready" : "recipe-not-found", starts };
    }
    // A resumed attempt keeps its own recipe revision; a replaced or different recipe never takes it over.
    if (
      !recipe ||
      recipe.origin !== document.origin ||
      (previous && (previous.recipeId !== recipe.id || previous.recipeRevision !== recipe.revision))
    )
      return refuse("recipe-not-found");
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!snapshot.ok) return refuse(snapshot.error.code);
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // A close/navigation can happen while settings storage was awaited.
    try {
      const tab = await browser.tabs.get(document.tabId);
      if (
        !tab.url ||
        documents.get(key) !== live ||
        (live.topUrl
          ? new URL(tab.url).origin !== new URL(live.topUrl).origin
          : new URL(tab.url).origin !== document.origin || new URL(tab.url).pathname !== live.path)
      )
        return refuse("stale-document");
    } catch {
      return refuse("closed-tab");
    }
    const plan = await planFor(snapshot, live, recipe);
    if (documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if (!plan.ok) return refuse(plan.reason);
    // Cookies can be shared across tabs. Preserve this conservative origin owner even at terminal state until tab closure.
    if (
      [...persisted.values()].some(
        (entry) =>
          entry.account.origin === document.origin && entry.document.tabId !== document.tabId,
      )
    )
      return refuse("origin-busy");
    if (!previous && persisted.size >= 100) return refuse("attempt-limit");
    // Another document of the tab, such as a frame, may have started an attempt while this
    // one was checked. Nothing below awaits until the attempt is registered.
    if (
      (attempts.get(document.tabId)?.metadata ?? persisted.get(document.tabId))?.id !== previous?.id
    )
      return refuse("tab-busy");
    let metadata: LoginAttemptMetadata;
    if (previous) {
      metadata = transitionLoginAttempt(recoverLoginAttempt(previous), {
        type: "NAVIGATED",
        document,
      });
      if (metadata.policyRevision !== snapshot.snapshot.revision)
        metadata = transitionLoginAttempt(metadata, { type: "POLICY_CHANGED" });
    } else {
      metadata = transitionLoginAttempt(
        createAttemptMetadata({
          id: crypto.randomUUID(),
          recipe,
          policyRevision: snapshot.snapshot.revision,
          account: {
            origin: document.origin,
            connectionId: plan.account.connectionId,
            itemId: plan.account.itemId,
          },
          document,
        }),
        { type: "RESOLVE" },
      );
    }
    const run: Execution = {
      metadata,
      recipe,
      live,
      running: false,
      // Each document re-derives the choice; every step still checks it is the attempt's account.
      ...(plan.choice &&
      !terminal(metadata) &&
      plan.account.connectionId === metadata.account.connectionId &&
      plan.account.itemId === metadata.account.itemId
        ? { choice: plan.choice }
        : {}),
    };
    attempts.set(document.tabId, run);
    await save(run);
    await publish(live, metadata);
    void drive(run);
    return { ok: true };
  }
  async function handle(message: unknown, sender: Sender): Promise<unknown> {
    // Probe controls are compiled into every build but answer only in the probe build.
    if (probeMode && trusted(sender)) {
      const control = v.safeParse(probeControlSchema, message);
      if (control.success) {
        if (control.output.action === "release") {
          if (!releaseCheckpoint) return { ok: false, reason: "checkpoint-not-paused" };
          releaseCheckpoint();
          return { ok: true };
        }
        if (armed || checkpoint) return { ok: false, reason: "checkpoint-busy" };
        armed = control.output.checkpoint;
        armTimer = setTimeout(() => {
          armed = undefined;
        }, 30000);
        return { ok: true };
      }
      const config = v.safeParse(configureSchema, message);
      if (config.success) {
        await loaded;
        if (persisted.size) return { ok: false, reason: "attempts-exist" };
        origin = config.output.origin;
        account = config.output.account ?? DEMO_PROBE_ACCOUNT;
        await browser.storage.local.set({
          [CONFIG_KEY]: { origin, ...(config.output.account ? { account } : {}) },
        });
        return { ok: true };
      }
      if (v.safeParse(statusSchema, message).success) {
        await loaded;
        return {
          version: 1,
          ok: true,
          ...(checkpoint ? { checkpoint } : {}),
          attempts: [...persisted.values()],
          documents: [...documents.values()].map((live) => ({
            ...live.document,
            ...(live.state ? { state: live.state } : {}),
            ...(live.reason ? { reason: live.reason } : {}),
          })),
        };
      }
      const cancel = v.safeParse(cancelSchema, message);
      if (cancel.success) {
        const run = attempts.get(cancel.output.tabId);
        if (!run) return { ok: false, reason: "attempt-not-found" };
        await change(run, { type: "CANCEL" });
        await send(run.live, { type: "login.cancel" }).catch(() => undefined);
        return { ok: true };
      }
      return undefined;
    }
    const hello = v.safeParse(helloSchema, message);
    if (hello.success) return ready(sender, hello.output.token, hello.output.start);
    const authorization = v.safeParse(authorizeSchema, message);
    if (!authorization.success) return undefined;
    const document = await identify(sender);
    if (!document) return false;
    const run = attempts.get(document.tabId);
    if (
      !run ||
      !current(run) ||
      run.live.token !== authorization.output.token ||
      run.metadata.id !== authorization.output.attemptId ||
      run.operation?.operationId !== authorization.output.operationId ||
      !sameLoginDocument(run.live.document, document) ||
      // A frame's attempt holds only while the tab still shows the page it matched.
      (run.live.topUrl !== undefined &&
        (!sender.tab?.url || new URL(sender.tab.url).origin !== new URL(run.live.topUrl).origin))
    )
      return false;
    if (!(await allowed(run))) return false;
    return validateLoginOperation(
      run.operation,
      run.metadata,
      document,
      run.metadata.policyRevision,
    );
  }
  function settingsChanged(): void {
    for (const run of attempts.values()) {
      if (!terminal(run.metadata)) {
        // Stop in-flight DOM waits promptly; the journal write may be slower.
        void send(run.live, { type: "login.cancel" }).catch(() => undefined);
        void change(run, { type: "POLICY_CHANGED" }).catch(() => undefined);
      }
    }
  }
  browser.tabs.onRemoved.addListener((tabId) => {
    for (const key of hellos.keys()) if (key.startsWith(`${tabId}:`)) hellos.delete(key);
    for (const [key, live] of documents) if (live.document.tabId === tabId) documents.delete(key);
    attempts.delete(tabId);
    storageQueue = storageQueue
      .then(async () => {
        await loaded;
        persisted.delete(tabId);
        await browser.storage.local.set({ [STORAGE_KEY]: [...persisted.values()] });
        return undefined;
      })
      .catch(() => {
        storageHealthy = false;
      });
  });
  // A worker restart does not reinstall content scripts. Rebind browser-provided
  // document identity before reconciling, without restoring pending side effects.
  void loaded
    .then(async () => {
      if (!storageHealthy) return undefined;
      const patterns = [
        ...(probeMode ? [`${origin}/*`] : []),
        ...(sites ? (await sites.origins()).map((entry) => `${entry}/*`) : []),
        // An automatically chosen account has no saved default until it authenticates.
        ...[...persisted.values()].map((entry) => `${entry.account.origin}/*`),
      ];
      const tabs = patterns.length ? await browser.tabs.query({ url: patterns }) : [];
      // A frame's attempt lives in a tab whose own URL may be on another origin.
      const tabIds = new Set([
        ...tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])),
        ...persisted.keys(),
      ]);
      for (const tabId of tabIds)
        void browser.tabs
          // Every frame announces again; a frame inside the page may hold the attempt.
          .sendMessage(tabId, { version: 1, type: "login.reconnect" })
          .catch(() => undefined);
      return undefined;
    })
    .catch(() => undefined);
  /**
   * Whether a login is in progress; a policy write now would stop it. An attempt between
   * pages has no current document, so its saved state counts too, once it is loaded.
   */
  async function active(): Promise<boolean> {
    await loaded;
    return (
      [...attempts.values()].some((run) => current(run) && !terminal(run.metadata)) ||
      [...persisted.values()].some((metadata) => !terminal(metadata))
    );
  }
  return { handle, settingsChanged, active };
}
