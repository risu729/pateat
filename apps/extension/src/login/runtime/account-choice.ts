import * as v from "valibot";
import {
  defaultLoginBinding,
  findLoginBinding,
  isSiteExcluded,
  loginFieldFacts,
  loginDisplayNames,
  resolveBindingFields,
  sameLoginDocument,
  siteDefaultConnection,
  templateLoginBinding,
  type LoginBindingTemplate,
  type LoginAccountBinding,
  type LoginChoiceAccount,
  type LoginDocument,
  type LoginItemFacts,
  type LoginRecipe,
  type SavedLoginBinding,
  type SettingsResponse,
  type SettingsSnapshot,
  type VaultCatalog,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { findLiveSiteCandidates } from "../../vault/site-candidates";
import {
  pickRequestSchema,
  type ChoiceResponse,
  type LogoutReason,
  type PickResponse,
  type StatusResponse,
} from "../choice-wire";
import {
  type Choice,
  choiceBadge,
  choiceKey,
  clipCodes,
  type Execution,
  frameKey,
  type LiveDocument,
  type PendingChoice,
  type PickedAccount,
  probeMode,
  recordKey,
  type Sender,
  withChoice,
  withItemOrigin,
} from "./model";
import type { LoginReport } from "./reports";
import type { RuntimeContext } from "./context";
import type { RuntimeState } from "./state";

/**
 * The account a page logs in with: a saved site default, the only provider URI match or a
 * pick in the popup (ADR 0013, ADR 0021), what the popup shows, and remembering the choice
 * once a login succeeds.
 */
export function createAccountChoice(shared: RuntimeState) {
  const runtime = shared as RuntimeContext;
  const {
    logouts,
    rejectedAsks,
    stoppedAsks,
    pending,
    quietly,
    badge,
    documents,
    settings,
    report,
    recipes,
    picked,
    parkedRequests,
    attempts,
    savingChoices,
    uris,
    options,
    choicePasskeys,
  } = shared;
  /**
   * Why a tab asks after a logout, for the log: which tab logged out, or `rejected` when
   * the site rejected this tab's login (ADR 0021 D).
   */
  function logoutDetail(key: string): LogoutReason {
    if (logouts.has(key)) return rejectedAsks.has(key) ? "rejected" : "this-tab";
    return stoppedAsks.has(key) ? "stopped-login" : "other-tab";
  }
  /** Badges the tab and records the refused document for the popup (ADR 0021). */
  function offerChoice(
    document: LoginDocument,
    candidates: PendingChoice["candidates"],
    logout?: LogoutReason,
  ): void {
    pending.set(document.tabId, { document, candidates, ...(logout ? { logout } : {}) });
    void quietly(runtime.saveSession);
    badge.choice(document.tabId, choiceBadge(candidates, logout));
  }
  function clearChoice(tabId: number): void {
    if (!pending.delete(tabId)) return;
    void quietly(runtime.saveSession);
    badge.choice(tabId, undefined);
    badge.note(tabId, undefined);
  }
  /** Whether another tab asks for an account after a logout of the origin (ADR 0021 D). */
  function askedElsewhere(tabId: number, siteOrigin: string): boolean {
    return [...logouts].some(
      (key) => key !== recordKey(tabId, siteOrigin) && key.endsWith(` ${siteOrigin}`),
    );
  }
  /** Whether another tab still asks after the site rejected its login (ADR 0021). */
  function rejectedElsewhere(tabId: number, siteOrigin: string): boolean {
    return [...rejectedAsks].some(
      (key) =>
        key !== recordKey(tabId, siteOrigin) && key.endsWith(` ${siteOrigin}`) && logouts.has(key),
    );
  }
  /** Tells the tab why it does not log in while another tab's login holds the site. */
  function showHeld(tabId: number): void {
    badge.note(
      tabId,
      "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait 5 minutes and reload this page, to log in here.",
    );
  }
  const fromPopup = (sender: Sender) =>
    sender.id === browser.runtime.id && sender.url === browser.runtime.getURL("/popup.html");
  const reviving = new Map<number, Promise<void>>();
  /**
   * Asks a refused document that a restarted worker knows only from session storage to
   * announce again; that offers its choice again, or clears it once the document is gone.
   */
  function revive(waiting: PendingChoice): Promise<void> {
    const { tabId, frameId, documentId } = waiting.document;
    let running = reviving.get(tabId);
    if (!running) {
      running = browser.tabs
        .sendMessage(tabId, { version: 1, type: "login.reconnect" }, { frameId, documentId })
        .then(
          () => undefined,
          () => {
            if (pending.get(tabId) === waiting) clearChoice(tabId);
          },
        )
        .finally(() => reviving.delete(tabId));
      reviving.set(tabId, running);
    }
    return running;
  }
  /** The refused document of a tab and the accounts it could use, for the popup. */
  async function choiceFor(tabId: number): Promise<ChoiceResponse> {
    // The attempt records decide whether another tab holds the site.
    await runtime.loaded;
    await runtime.sessionLoaded;
    let waiting = pending.get(tabId);
    if (waiting && !documents.has(frameKey(waiting.document))) {
      await revive(waiting);
      // The document may have answered as stale because another announcement of it, such
      // as one asked for by the restarted worker's reconnect of every tab, overtook it.
      await runtime.admitting.get(`${tabId}:${waiting.document.frameId}`)?.catch(() => undefined);
      // A document that answered but could not be admitted again, for example after its
      // site access was withdrawn, offers nothing; asking again would only repeat that.
      if (pending.get(tabId) === waiting && !documents.has(frameKey(waiting.document)))
        clearChoice(tabId);
      waiting = pending.get(tabId);
    }
    const live = waiting && documents.get(frameKey(waiting.document));
    if (
      !waiting ||
      !live ||
      !sameLoginDocument(live.document, waiting.document) ||
      runtime.recordFor(tabId, waiting.document.origin) !== undefined
    ) {
      // The document announced again without being refused for several accounts.
      if (waiting && live) clearChoice(tabId);
      return { ok: false, reason: "no-choice" };
    }
    const held = runtime.heldElsewhere(tabId, waiting.document.origin)
      ? { held: true as const }
      : {};
    if (waiting.logout)
      return {
        ok: true,
        origin: waiting.document.origin,
        documentId: waiting.document.documentId,
        candidates: waiting.candidates,
        logout: waiting.logout,
        ...held,
        ...(waiting.logout !== "rejected" && rejectedElsewhere(tabId, waiting.document.origin)
          ? { rejectedElsewhere: true as const }
          : {}),
      };
    // A default saved since the refusal decides the page's next login instead.
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (pending.get(tabId) !== waiting) return { ok: false, reason: "no-choice" };
    if (
      !snapshot.ok ||
      snapshot.snapshot.settings.siteDefaults.some(
        (entry) => entry.origin === waiting.document.origin,
      )
    ) {
      if (snapshot.ok) clearChoice(tabId);
      return { ok: false, reason: "no-choice" };
    }
    return {
      ok: true,
      origin: waiting.document.origin,
      documentId: waiting.document.documentId,
      candidates: waiting.candidates,
      ...held,
      ...(rejectedElsewhere(tabId, waiting.document.origin)
        ? { rejectedElsewhere: true as const }
        : {}),
    };
  }
  /** By tab: the popup's last logged answer, so an open popup asking each second logs once. */
  const popupAnswers = new Map<number, string>();
  /** Answers the popup and logs, value-free, what it was told when that changes (ADR 0019). */
  async function popupChoice(tabId: number): Promise<ChoiceResponse> {
    const answer = await choiceFor(tabId);
    const page = documents.get(frameKey({ tabId, frameId: 0 }));
    const pageOrigin = answer.ok ? answer.origin : page?.document.origin;
    if (pageOrigin === undefined) return answer;
    const record = runtime.recordFor(tabId, pageOrigin);
    const entry: LoginReport = {
      type: "popup",
      tabId,
      origin: pageOrigin,
      choice: answer.ok ? "offered" : "none",
      ...(answer.ok
        ? {
            candidates: answer.candidates.length,
            ...(answer.logout ? { logout: answer.logout } : {}),
            ...(answer.held ? { held: true as const } : {}),
            ...(answer.rejectedElsewhere ? { rejectedElsewhere: true as const } : {}),
          }
        : {}),
      ...(record
        ? {
            recordState: record.state,
            ...(record.outcome ? { recordOutcome: record.outcome } : {}),
          }
        : {}),
      ...(page?.reason ? { pageReason: page.reason } : {}),
    };
    const key = JSON.stringify(entry);
    if (popupAnswers.get(tabId) !== key) {
      popupAnswers.set(tabId, key);
      report({ frameId: 0 }, entry);
    }
    return answer;
  }
  /**
   * What the popup's page section shows for a tab (ADR 0038): whether the top page's origin
   * has a recipe, and for which path; the page's state as this worker last saw it; and the
   * tab's last login and model request on that origin. Never a value, recipe step or query.
   */
  async function popupStatus(tabId: number): Promise<StatusResponse> {
    const live = documents.get(frameKey({ tabId, frameId: 0 }));
    // The tab's own URL, since its page may not have announced yet.
    const url = (await browser.tabs.get(tabId).catch(() => undefined))?.url ?? live?.url;
    let page: URL | undefined;
    try {
      page = url ? new URL(url) : undefined;
    } catch {
      page = undefined;
    }
    // The popup shows its page section only on HTTPS pages.
    if (page?.protocol !== "https:") return { ok: false, reason: "no-page" };
    const { origin: pageOrigin, pathname: path } = page;
    const [starts, entries] = await Promise.all([
      recipes.starts(pageOrigin).catch(() => []),
      recipes.entries(pageOrigin).catch(() => []),
    ]);
    const paths = [
      ...starts.map((start) => start.path),
      ...entries.map((entry) => entry.entry.path),
    ];
    const status = badge.status(tabId);
    const known = status?.origin === pageOrigin ? status : undefined;
    // The worker's view of the page holds only while the tab still shows its path.
    const shown = live?.document.origin === pageOrigin && live.path === path ? live : undefined;
    const pageState = shown && {
      ...(shown.state ? { state: shown.state } : {}),
      ...(shown.reason ? { reason: shown.reason } : {}),
      ...(shown.notStarted ? { notStarted: shown.notStarted } : {}),
      ...(shown.generationSkip ? { generationSkip: shown.generationSkip } : {}),
    };
    return {
      ok: true,
      origin: pageOrigin,
      recipe: paths.includes(path) ? "page" : paths.length ? "other-paths" : "none",
      ...(badge.asking(tabId) ? { asking: true as const } : {}),
      ...(pageState ? { page: clipCodes(pageState) } : {}),
      ...(known?.login ? { login: clipCodes(known.login) } : {}),
      ...(known?.refused ? { refused: clipCodes(known.refused) } : {}),
      ...(known?.generation ? { generation: clipCodes(known.generation) } : {}),
    };
  }
  /**
   * Restarts the refused document's login with the picked account: the document announces
   * again and a new attempt starts from the recipe's first step, if that step still shows.
   */
  async function pickFor(request: v.InferOutput<typeof pickRequestSchema>): Promise<PickResponse> {
    const offered = await choiceFor(request.tabId);
    const waiting = pending.get(request.tabId);
    if (!offered.ok || !waiting || offered.documentId !== request.documentId)
      return { ok: false, reason: "no-choice" };
    if (
      !offered.candidates.some(
        (entry) => entry.connectionId === request.connectionId && entry.itemId === request.itemId,
      )
    )
      return { ok: false, reason: "not-a-candidate" };
    // The pick would be refused as the page announces; the choice stays for a later pick.
    if (offered.held) return { ok: false, reason: "origin-busy" };
    const pick: PickedAccount = {
      tabId: request.tabId,
      origin: waiting.document.origin,
      documentId: waiting.document.documentId,
      connectionId: request.connectionId,
      itemId: request.itemId,
      makeDefault: request.makeDefault,
    };
    picked.set(request.tabId, pick);
    clearChoice(request.tabId);
    let gone = false;
    try {
      await runtime.saveSession();
      // The document answers once its new announce is handled, started or refused.
      await browser.tabs.sendMessage(
        request.tabId,
        { version: 1, type: "login.reconnect" },
        { frameId: waiting.document.frameId, documentId: waiting.document.documentId },
      );
      // Another announcement of the document may have overtaken this one and take the pick.
      await runtime.admitting
        .get(`${request.tabId}:${waiting.document.frameId}`)
        ?.catch(() => undefined);
    } catch {
      gone = true;
    }
    if (pick.attemptId !== undefined) return { ok: true };
    // A pick that started nothing is dropped; the form's next appearance asks again.
    if (picked.get(request.tabId) === pick) {
      picked.delete(request.tabId);
      await quietly(runtime.saveSession);
    }
    // Nothing answers the document's passkey request then, unless its choice is offered
    // again soon, as when the document announces again (ADR 0034).
    for (const parked of parkedRequests)
      if (parked.tabId === request.tabId && parked.documentId === waiting.document.documentId)
        parked.dropped = Date.now();
    if (gone) return { ok: false, reason: "document-gone" };
    // Another tab's login started holding the site after the choice was offered. The page
    // does not announce again once that hold ends, so its choice waits for a later pick.
    const live = documents.get(frameKey(waiting.document));
    if (
      live?.reason === "origin-busy" &&
      live.document.documentId === waiting.document.documentId &&
      !pending.has(request.tabId)
    ) {
      offerChoice(waiting.document, waiting.candidates, waiting.logout);
      return { ok: false, reason: "origin-busy" };
    }
    return { ok: false, reason: "not-started" };
  }
  /**
   * Saves an automatic account choice after `authenticated` (ADR 0013). The settings must
   * still be the revision the attempt was authorized under, or the newer one a watch took
   * over after checking its account; otherwise nothing is saved and the next login chooses
   * again.
   */
  async function remember(run: Execution): Promise<void> {
    const choice = run.choice;
    delete run.choice;
    const { account: used } = run.metadata;
    if (!choice || !settings.update) return;
    const outcome = (value: Extract<LoginReport, { type: "choice" }>["outcome"]) =>
      report(run.metadata.document, {
        type: "choice",
        tabId: run.metadata.document.tabId,
        origin: run.metadata.document.origin,
        outcome: value,
      });
    // Only the account this attempt authenticated with may be saved.
    if (
      choice.connectionId !== used.connectionId ||
      choice.binding.itemId !== used.itemId ||
      choice.binding.origin !== used.origin
    ) {
      outcome("account-changed");
      return;
    }
    // Saving bumps the revision every attempt checks; never stop another login with it.
    if ([...attempts.values()].some((other) => other !== run && runtime.inProgress(other))) {
      outcome("login-in-progress");
      return;
    }
    // A login another tab is admitting waits for this save, which no in-progress check above
    // can see yet (see `admit`).
    let finish!: () => void;
    const saving = new Promise<void>((resolve) => (finish = resolve));
    savingChoices.add(saving);
    let writing = false;
    try {
      // Writing bumps the policy revision for every attempt, so skip a choice already saved.
      const latest = await settings
        .handle({ version: 1, type: "settings.get" })
        .catch((error: unknown) => {
          outcome("settings-unavailable");
          throw error;
        });
      if (!latest.ok) {
        outcome("settings-unavailable");
        return;
      }
      if (withChoice(latest.snapshot.settings, choice) === latest.snapshot.settings) {
        outcome("already-saved");
        return;
      }
      writing = true;
      const written = await settings
        .update(run.metadata.policyRevision, (snapshot) => ({
          ...snapshot,
          settings: withChoice(snapshot.settings, choice),
        }))
        .then(
          () => "saved" as const,
          () => "write-failed" as const,
        );
      outcome(written);
      // The saved default ends another tab's choice of the same origin (ADR 0034).
      if (written === "saved") void choiceDefaults();
    } finally {
      if (writing) runtime.remembered += 1;
      savingChoices.delete(saving);
      finish();
    }
  }
  /**
   * Every eligible provider URI match for the document across all enabled connections;
   * in a frame, only items that also match the tab's URL (ADR 0017). Any connection or
   * item that could not be evaluated refuses rather than listing part of them.
   */
  async function siteCandidates(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
  ) {
    const find = (url: string) =>
      findLiveSiteCandidates({
        settings: snapshot.snapshot.settings,
        catalog: snapshot.catalog,
        url,
        match: uris!,
      });
    const scope = await find(live.url);
    if (!scope.ok) return { reason: scope.reason };
    if (scope.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
    if (scope.incompleteItems.length > 0) return { reason: "item-uri-unevaluated" };
    if (!live.topUrl) return { candidates: scope.candidates };
    const top = await find(live.topUrl);
    if (!top.ok) return { reason: top.reason };
    if (top.unavailableConnections.length > 0) return { reason: "vault-unavailable" };
    if (top.incompleteItems.length > 0) return { reason: "item-uri-unevaluated" };
    return {
      candidates: scope.candidates.filter((entry) =>
        top.candidates.some(
          (other) => other.connectionId === entry.connectionId && other.itemId === entry.itemId,
        ),
      ),
    };
  }
  /** `noUriMatch` marks a refusal because no vault item matches the page, or the saved
   * default's item no longer does, which a vault sync may change; it is logged as the
   * refusal's `no-uri-match` detail and never answered to the page. */
  type Refusal = {
    reason: string;
    candidates?: PendingChoice["candidates"];
    logout?: true;
    noUriMatch?: true;
  };
  /**
   * The account for this document. A saved site default wins. Without one, a single
   * eligible provider URI match across all enabled connections is used for this attempt
   * only (ADR 0013); none, several, or any connection or item that could not be evaluated
   * refuses rather than guessing.
   */
  async function choose(
    snapshot: Extract<SettingsResponse, { ok: true }>,
    live: LiveDocument,
    asking = false,
    fill = false,
  ): Promise<Choice | Refusal> {
    // An account picked in the popup wins for the document it restarted and the attempt that
    // document started; its item must still match the page and pass every check below.
    await runtime.sessionLoaded;
    const pick = picked.get(live.document.tabId);
    const owner = runtime.recordFor(live.document.tabId, live.document.origin);
    if (
      pick?.origin === live.document.origin &&
      (pick.attemptId === undefined
        ? pick.documentId === live.document.documentId
        : owner?.id === pick.attemptId)
    )
      return {
        connectionId: pick.connectionId,
        itemId: pick.itemId,
        saved: false,
        source: "pick",
        pick,
      };
    const saved = snapshot.snapshot.settings.siteDefaults.find(
      (entry) => entry.origin === live.document.origin,
    );
    if (asking) {
      // After a logout the tab asks, with the saved default first (ADR 0021 D).
      const listed: PendingChoice["candidates"] = [];
      const mapped = saved && siteDefaultConnection(saved, snapshot.catalog);
      if (saved && mapped?.ok)
        listed.push({ connectionId: mapped.connectionId, itemId: saved.itemId });
      if (uris) {
        const found = await siteCandidates(snapshot, live);
        // Without the matches, the saved default alone is still offered.
        if ("reason" in found && !listed.length) return { reason: found.reason };
        for (const entry of "reason" in found ? [] : found.candidates)
          if (
            !listed.some(
              (other) => other.connectionId === entry.connectionId && other.itemId === entry.itemId,
            )
          )
            listed.push({ connectionId: entry.connectionId, itemId: entry.itemId });
      }
      if (!listed.length) return { reason: saved ? "default-unavailable" : "default-not-set" };
      // With one account to use, the saved default or the only match, the page is filled
      // without any click or submitting fill; the tab still asks (ADR 0021 D).
      // A saved default that cannot be used fills nothing, as it would refuse a login.
      const only = saved
        ? mapped?.ok
          ? listed[0]
          : undefined
        : listed.length === 1
          ? listed[0]
          : undefined;
      if (fill && only)
        return {
          ...only,
          saved: Boolean(saved),
          source: saved ? "default" : "match",
          candidates: listed.length,
          fillOnly: true,
          asked: listed.slice(0, 100),
        };
      return { reason: "logged-out", candidates: listed.slice(0, 100), logout: true };
    }
    if (saved) {
      const connection = siteDefaultConnection(saved, snapshot.catalog);
      return connection.ok
        ? {
            connectionId: connection.connectionId,
            itemId: saved.itemId,
            saved: true,
            source: "default",
          }
        : { reason: connection.reason };
    }
    if (!uris) return { reason: "default-not-set" };
    // Any sync replaces a snapshot ID, so a new match from a later sync is still noticed.
    const snapshots = JSON.stringify(
      snapshot.catalog.connections.map((entry) => [entry.id, entry.snapshotId, entry.state]),
    );
    const cached = live.autoChoice;
    if (cached?.snapshots === snapshots)
      return {
        connectionId: cached.connectionId,
        itemId: cached.itemId,
        saved: false,
        source: "match",
        candidates: 1,
      };
    delete live.autoChoice;
    const found = await siteCandidates(snapshot, live);
    if ("reason" in found) return { reason: found.reason };
    const { candidates } = found;
    if (candidates.length > 1)
      return {
        reason: "account-ambiguous",
        candidates: candidates.map((entry) => ({
          connectionId: entry.connectionId,
          itemId: entry.itemId,
        })),
      };
    const [only] = candidates;
    if (!only) return { reason: "default-not-set", noUriMatch: true };
    // The same answer covers the item origin check below; no second query is needed.
    live.uriMatch = {
      connectionId: only.connectionId,
      itemId: only.itemId,
      snapshotId: only.snapshotId,
    };
    live.autoChoice = { snapshots, connectionId: only.connectionId, itemId: only.itemId };
    return {
      connectionId: only.connectionId,
      itemId: only.itemId,
      saved: false,
      source: "match",
      candidates: candidates.length,
    };
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
   * The chosen item's binding for one route's `slots` (ADR 0027): the synced binding, else
   * the automatic one for built-in slots, else one built from a template: another item's
   * saved binding of the recipe, then the slot map of a recipe generated from this device.
   * A synced binding is never bypassed: it must hold every one of `slots` itself, and its
   * entries for other slots are ignored. It is mapped to this device's field IDs by the
   * catalog's raw field names.
   */
  async function bindingFor(
    catalog: VaultCatalog,
    settingsValue: SettingsSnapshot["settings"],
    recipe: LoginRecipe,
    choice: Choice,
    documentOrigin: string,
    slots: readonly string[],
    slotMap: () => Promise<LoginBindingTemplate | undefined>,
  ): Promise<
    | { ok: true; binding: LoginAccountBinding; synced: SavedLoginBinding; saved: boolean }
    | { ok: false; reason: string }
  > {
    const connection = catalog.connections.find((entry) => entry.id === choice.connectionId);
    const item = connection?.items.find((entry) => entry.id === choice.itemId);
    if (!connection?.userId || !item) return { ok: false, reason: "vault-unavailable" };
    const owner = { provider: connection.provider, userId: connection.userId, itemId: item.id };
    const named = { ...owner, itemName: item.label, accountName: connection.label };
    const fieldNames = item.fields.map((field) => ({ id: field.id, name: field.name }));
    const saved = findLoginBinding(settingsValue.bindings, recipe, owner);
    let binding = saved ?? defaultLoginBinding(slots, recipe, named);
    if (!binding) {
      // Sibling bindings were proven by an authenticated login, so they go first.
      const templates: LoginBindingTemplate[] = settingsValue.bindings
        .filter((entry) => entry.recipeId === recipe.id && entry.origin === recipe.origin)
        .map((entry) => entry.slots);
      const generated = await slotMap();
      if (generated) templates.push(generated);
      const built = templateLoginBinding(slots, recipe, named, templates, fieldNames);
      if (!built.ok) return { ok: false, reason: built.reason };
      binding = built.binding;
    }
    const resolved = resolveBindingFields(binding, slots, fieldNames);
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    return {
      ok: true,
      binding: {
        origin: documentOrigin,
        connectionId: connection.id,
        itemId: item.id,
        slots: resolved.slots,
      },
      // A default saved from a stored binding is named after this device's connection
      // too; the stored binding itself is never rewritten.
      synced: saved ? { ...saved, accountName: connection.label } : binding,
      saved: saved !== undefined,
    };
  }
  /**
   * The item's facts for a new login (ADR 0027): its password and TOTP fields from the
   * catalog's value-free flags and the account's allowed fields, and its passkeys from one
   * vault search. Read once per login; never sent anywhere.
   */
  async function itemFacts(
    connection: VaultConnectionMetadata,
    owner: { origin: string; connectionId: string; itemId: string; fieldIds: string[] },
  ): Promise<LoginItemFacts> {
    const item = connection.items.find((entry) => entry.id === owner.itemId);
    const fieldFacts = item
      ? loginFieldFacts(item, owner.fieldIds)
      : { password: false, totp: false };
    // The synthetic probe item names its password field `password`; it holds a value.
    if (probeMode && owner.origin === runtime.origin && owner.fieldIds.includes("password"))
      fieldFacts.password = true;
    // Its synthetic `totp` field counts as a TOTP secret only when the probe says so.
    if (
      probeMode &&
      owner.origin === runtime.origin &&
      runtime.probeTotp &&
      owner.fieldIds.includes("totp")
    )
      fieldFacts.totp = true;
    // The synthetic item's configured passkey stands in for the vault search.
    if (probeMode && owner.origin === runtime.origin && runtime.probePasskey)
      return {
        ...fieldFacts,
        passkey: true,
        discoverablePasskey: runtime.probePasskey === "discoverable",
      };
    const held = await Promise.resolve(
      options.passkeys?.({
        origin: owner.origin,
        connectionId: owner.connectionId,
        itemId: owner.itemId,
      }),
    ).catch(() => undefined);
    return {
      ...fieldFacts,
      passkey: held?.passkey === true,
      discoverablePasskey: held?.passkey === true && held.discoverable,
    };
  }
  /** Reasons a password variant does not fit the item; any other refusal stops the plan. */
  const variantRefusals = new Set([
    "binding-not-found",
    "binding-slots-mismatch",
    "binding-field-excluded",
    "field-missing",
    "field-ambiguous",
    "field-count-changed",
    "no-route",
  ]);
  /**
   * The chosen item named as a saved default names it, for a login whose route fills
   * nothing (ADR 0027); undefined when its connection or item cannot name it.
   */
  function choiceAccount(
    catalog: VaultCatalog,
    choice: Choice,
    documentOrigin: string,
  ): LoginChoiceAccount | undefined {
    const connection = catalog.connections.find((entry) => entry.id === choice.connectionId);
    const item = connection?.items.find((entry) => entry.id === choice.itemId);
    if (!connection?.userId || !item) return undefined;
    return {
      origin: documentOrigin,
      provider: connection.provider,
      userId: connection.userId,
      itemId: item.id,
      // Named as a binding built for the item is.
      ...loginDisplayNames(item.id, item.label, connection.label),
    };
  }
  /**
   * Ends each popup choice whose origin has a site default by now, so the page's own
   * conditional request no longer waits for a pick (ADR 0034): after settings are saved or
   * synced, after a pick saves its account, and before a choice is checked.
   */
  async function choiceDefaults(): Promise<void> {
    if (!choicePasskeys.size) return;
    const snapshot = await settings
      .handle({ version: 1, type: "settings.get" })
      .catch(() => undefined);
    if (!snapshot?.ok) return;
    let ended = false;
    for (const [tabId, entry] of choicePasskeys) {
      const waiting = pending.get(tabId);
      if (
        waiting &&
        !entry.defaulted &&
        entry.key === choiceKey(waiting) &&
        snapshot.snapshot.settings.siteDefaults.some(
          (saved) => saved.origin === waiting.document.origin,
        )
      ) {
        entry.defaulted = true;
        ended = true;
      }
    }
    if (ended) runtime.reviewRequests();
  }
  return {
    remember,
    offerChoice,
    logoutDetail,
    topScope,
    choose,
    liveScope,
    choiceAccount,
    bindingFor,
    itemFacts,
    variantRefusals,
    siteCandidates,
    clearChoice,
    askedElsewhere,
    showHeld,
    fromPopup,
    popupChoice,
    popupStatus,
    pickFor,
    choiceDefaults,
    popupAnswers,
    revive,
  };
}
