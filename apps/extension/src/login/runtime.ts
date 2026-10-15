import * as v from "valibot";
import { sameLoginDocument, validateLoginOperation, type LoginAccount } from "@pateat/contracts";
import { browser } from "wxt/browser";
import type { LoginBadge } from "./badge";
import {
  authorizeSchema,
  cancelSchema,
  configureSchema,
  helloSchema,
  statusSchema,
  submittedSchema,
  probeControlSchema,
} from "./wire";
import { DEMO_PROBE_ACCOUNT } from "./dummy";
import type { LiveUriMatcher } from "../vault/site-candidates";
import { choiceRequestSchema, pickRequestSchema, statusRequestSchema } from "./choice-wire";
import type { LoginSites } from "./sites";
import type { PasskeyItem } from "../passkeys/runtime";
import type { LoginFieldSource } from "./vault";
import {
  frameKey,
  idle,
  probeMode,
  recordKey,
  type Sender,
  type SettingsRuntime,
  terminal,
} from "./runtime/model";
import type { LoginGeneration, LoginRecipes } from "./runtime/recipes";
import type { LoginReport } from "./runtime/reports";
import { createRuntimeState } from "./runtime/state";
import { createAttemptStore } from "./runtime/attempt-store";
import { createAccountChoice } from "./runtime/account-choice";
import { createAdmission } from "./runtime/admission";
import { createLoginPlan } from "./runtime/login-plan";
import { createSignInCheck } from "./runtime/sign-in-check";
import { createContinuation } from "./runtime/continuation";
import { createSteps } from "./runtime/steps";
import { createRecipeGeneration } from "./runtime/recipe-generation";
import { createEntryPages } from "./runtime/entry-pages";
import { createSiteMoves } from "./runtime/site-moves";
import { createPagePasskeys } from "./runtime/page-passkeys";
import { createPasswordStop } from "./runtime/password-stop";
import type { RuntimeContext } from "./runtime/context";

export type LoginRuntimeOptions = {
  fields: LoginFieldSource;
  sites?: LoginSites;
  recipes?: LoginRecipes;
  /** Live provider URI matching; without it only static `allowedOrigins` apply. */
  uris?: LiveUriMatcher;
  /** Recipe generation for pages without a recipe; needs `uris` for the vault match. */
  generation?: LoginGeneration;
  /**
   * The account item's passkey facts, read once when a login starts (ADR 0027). Without
   * it the item counts as holding no passkey, so a `passkey` handler is never run.
   */
  passkeys?: (account: LoginAccount) => Promise<{ passkey: boolean; discoverable: boolean }>;
  /**
   * The items holding a discoverable, usable passkey for the origin, by the criterion of
   * `passkeys`, from one vault search per RP ID (ADR 0034). Without it no popup choice
   * keeps a page's own conditional request waiting.
   */
  passkeyItems?: (origin: string) => Promise<readonly PasskeyItem[]>;
  /** Receives each attempt state change, refusal and generation result. */
  report?: (report: LoginReport) => void;
  /**
   * The toolbar badge (ADR 0038): the account choice a tab waits on, a tooltip, and a
   * spin while a model request for its page is in flight, from the request's `sent` until
   * it returns; and the tab's last login and model request it read from the reports, for
   * the popup's page section. Without one the runtime writes `chrome.action` itself and
   * keeps nothing across worker restarts.
   */
  badge?: Pick<LoginBadge, "choice" | "note" | "spin" | "status" | "asking">;
  /**
   * Told of each origin of a login that reached signed in, on any route, so a site's
   * passkey registration right after it can be refused (ADR 0007). Never changes the login.
   */
  signedIn?: (tabId: number, origin: string) => void;
  /**
   * Automatic vault sync (ADR 0025). Each page announcement starts a due check and
   * holds vault replacement off while it is handled; a page that may start a login
   * first waits briefly for a running check.
   */
  vault?: {
    refreshIfStale(): void;
    enter(waitForCheck: boolean): Promise<() => void>;
    /**
     * Asked when a page with a recipe found no matching vault item: a check limited to
     * once every ten seconds. Answers true when a check applied a new snapshot within
     * ten seconds, after which the refused document is asked to announce again.
     */
    checkAfterMiss?(): Promise<boolean>;
  };
};

/**
 * Coordinator is packaged production code. Production admits only `sites` documents and
 * uses `recipes`; the loopback probe adapter and its controls exist only in the probe build.
 * Account metadata comes from each live settings read; values come from `fields` per fill.
 */
export function createLoginRuntime(settings: SettingsRuntime, options: LoginRuntimeOptions) {
  // Every part is in the runtime before any of its functions runs (`RuntimeContext`).
  const runtime = createRuntimeState(settings, options) as RuntimeContext;
  Object.assign(runtime, createAttemptStore(runtime));
  Object.assign(runtime, createAccountChoice(runtime));
  Object.assign(runtime, createAdmission(runtime));
  Object.assign(runtime, createLoginPlan(runtime));
  Object.assign(runtime, createSignInCheck(runtime));
  Object.assign(runtime, createContinuation(runtime));
  Object.assign(runtime, createSteps(runtime));
  Object.assign(runtime, createRecipeGeneration(runtime));
  Object.assign(runtime, createEntryPages(runtime));
  Object.assign(runtime, createSiteMoves(runtime));
  Object.assign(runtime, createPagePasskeys(runtime));
  Object.assign(runtime, createPasswordStop(runtime));
  const {
    persisted,
    logouts,
    rejectedAsks,
    documents,
    attempts,
    send,
    replacedTabs,
    stoppedAsks,
    entryPresses,
    picked,
    quietly,
    passwordFills,
    continuations,
    effects,
    passkeyPages,
    signInUrls,
    choicePasskeys,
    entryTimers,
    entryRefused,
    passkeyRequests,
    passkeyAnswers,
    pending,
    logoutFills,
    noted,
    sites,
  } = runtime;
  async function handle(message: unknown, sender: Sender): Promise<unknown> {
    // Probe controls are compiled into every build but answer only in the probe build.
    if (probeMode && runtime.trusted(sender)) {
      const control = v.safeParse(probeControlSchema, message);
      if (control.success) {
        if (control.output.action === "release") {
          if (!runtime.releaseCheckpoint) return { ok: false, reason: "checkpoint-not-paused" };
          runtime.releaseCheckpoint();
          return { ok: true };
        }
        if (runtime.armed || runtime.checkpoint) return { ok: false, reason: "checkpoint-busy" };
        runtime.armed = control.output.checkpoint;
        runtime.armTimer = setTimeout(() => {
          runtime.armed = undefined;
        }, 30000);
        return { ok: true };
      }
      const config = v.safeParse(configureSchema, message);
      if (config.success) {
        await runtime.loaded;
        if (persisted.size) return { ok: false, reason: "attempts-exist" };
        runtime.origin = config.output.origin;
        runtime.account = config.output.account ?? DEMO_PROBE_ACCOUNT;
        runtime.probePasskey = config.output.passkey;
        runtime.probeTotp = config.output.totp === true;
        await runtime.probeConfig.write({
          origin: runtime.origin,
          ...(config.output.account ? { account: runtime.account } : {}),
          ...(runtime.probePasskey ? { passkey: runtime.probePasskey } : {}),
          ...(runtime.probeTotp ? { totp: true } : {}),
        });
        return { ok: true };
      }
      if (v.safeParse(statusSchema, message).success) {
        await runtime.loaded;
        return {
          version: 1,
          ok: true,
          ...(runtime.checkpoint ? { checkpoint: runtime.checkpoint } : {}),
          attempts: [...persisted.values()],
          // Tabs that ask after a logout, and whether the site's rejection began it.
          asks: [...logouts].map((key) => (rejectedAsks.has(key) ? "rejected" : "logout")),
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
        await runtime.change(run, { type: "CANCEL" });
        await send(run.live, { type: "login.cancel" }).catch(() => undefined);
        return { ok: true };
      }
      return undefined;
    }
    if (runtime.fromPopup(sender)) {
      const ask = v.safeParse(choiceRequestSchema, message);
      if (ask.success) return runtime.popupChoice(ask.output.tabId);
      const asked = v.safeParse(statusRequestSchema, message);
      if (asked.success) return runtime.popupStatus(asked.output.tabId);
      const pick = v.safeParse(pickRequestSchema, message);
      if (pick.success) return runtime.pickFor(pick.output);
      return undefined;
    }
    if (v.safeParse(submittedSchema, message).success) {
      const document = await runtime.identify(sender);
      // A sign-in in a frame counts for the tab's page, whose next page is skipped.
      const page =
        document && document.frameId !== 0
          ? documents.get(frameKey({ tabId: document.tabId, frameId: 0 }))?.document
          : document;
      if (page)
        runtime.passwordSubmits.set(page.tabId, {
          origin: page.origin,
          documentId: page.documentId,
          at: Date.now(),
        });
      return undefined;
    }
    const hello = v.safeParse(helloSchema, message);
    if (hello.success) {
      options.vault?.refreshIfStale();
      return runtime.ready(
        sender,
        hello.output.token,
        hello.output.start,
        hello.output.signIn,
        hello.output.shown,
        hello.output.list,
        hello.output.entry,
        hello.output.unoffered,
      );
    }
    const authorization = v.safeParse(authorizeSchema, message);
    if (!authorization.success) return undefined;
    const document = await runtime.identify(sender);
    if (!document) return false;
    const run = attempts.get(document.tabId);
    if (
      !run ||
      !runtime.current(run) ||
      run.live.token !== authorization.output.token ||
      run.metadata.id !== authorization.output.attemptId ||
      run.operation?.operationId !== authorization.output.operationId ||
      !sameLoginDocument(run.live.document, document) ||
      // A frame's attempt holds only while the tab still shows the page it matched.
      (run.live.topUrl !== undefined &&
        (!sender.tab?.url || new URL(sender.tab.url).origin !== new URL(run.live.topUrl).origin))
    )
      return false;
    if (!(await runtime.allowed(run))) return false;
    return validateLoginOperation(
      run.operation,
      run.metadata,
      document,
      run.metadata.policyRevision,
    );
  }
  /**
   * Settings were synced from the service or saved locally: stops every running login but
   * a watched one, which only reads, so it is checked against the new settings instead and
   * stops only when they no longer plan its account (ADR 0027).
   */
  function settingsChanged(source: "synced" | "saved"): void {
    for (const run of attempts.values()) {
      if (terminal(run.metadata)) continue;
      if (run.metadata.watch !== undefined) {
        void runtime.allowed(run).catch(() => undefined);
        continue;
      }
      // Stop in-flight DOM waits promptly; the journal write may be slower.
      void send(run.live, { type: "login.cancel" }).catch(() => undefined);
      void runtime
        .change(
          run,
          { type: "POLICY_CHANGED" },
          { cause: source === "synced" ? "settings-synced" : "settings-saved" },
        )
        .catch(() => undefined);
    }
    // A site default saved for a page's origin ends its popup choice (ADR 0034).
    void runtime.choiceDefaults();
  }
  browser.tabs.onRemoved.addListener((tabId) => forgetTab(tabId));
  // Chrome gives a tab a new ID when it discards it to save memory. It is the same tab to
  // the user: what the tab did moves to the new ID, and the gone page is forgotten as on
  // a close (ADR 0021). The event may be what starts the worker.
  browser.tabs.onReplaced.addListener((added, removed) => {
    if (added === removed) return;
    replacedTabs.add(removed);
    const moved = (key: string) =>
      key.startsWith(`${removed} `) ? `${added}${key.slice(String(removed).length)}` : key;
    void runtime.sessionLoaded.then(async () => {
      let changed = false;
      for (const keys of [logouts, stoppedAsks, rejectedAsks])
        for (const key of [...keys])
          if (moved(key) !== key) {
            keys.delete(key);
            keys.add(moved(key));
            changed = true;
          }
      const press = entryPresses.get(removed);
      if (press) {
        const kept = { ...press, tabId: added };
        entryPresses.delete(removed);
        entryPresses.set(added, kept);
        if (!kept.checked) runtime.armEntryTimer(kept);
        changed = true;
      }
      // A pick that started its login stays with that login; one for the gone page does not.
      const pick = picked.get(removed);
      if (pick?.attemptId !== undefined) {
        picked.delete(removed);
        picked.set(added, { ...pick, tabId: added });
        changed = true;
      }
      if (changed) await quietly(runtime.saveSession);
      return undefined;
    });
    runtime.storageQueue = runtime.storageQueue
      .then(async () => {
        await runtime.loaded;
        let changed = false;
        for (const [key, metadata] of [...persisted])
          if (metadata.document.tabId === removed) {
            persisted.delete(key);
            persisted.set(recordKey(added, metadata.account.origin), {
              ...metadata,
              document: { ...metadata.document, tabId: added },
            });
            changed = true;
          }
        replacedTabs.delete(removed);
        if (changed) await runtime.attemptRecords.write([...persisted.values()]);
        return undefined;
      })
      .catch(() => {
        runtime.storageHealthy = false;
      });
    forgetTab(removed);
  });
  /** Forgets a closed tab, or the gone page of a replaced one. */
  function forgetTab(tabId: number): void {
    runtime.passwordSubmits.delete(tabId);
    passwordFills.delete(tabId);
    runtime.afterSignIn.delete(tabId);
    for (const key of runtime.hellos.keys())
      if (key.startsWith(`${tabId}:`)) runtime.hellos.delete(key);
    for (const [key, live] of documents) if (live.document.tabId === tabId) documents.delete(key);
    const closed = attempts.get(tabId);
    if (closed) continuations.delete(closed.metadata.id);
    attempts.delete(tabId);
    effects.delete(tabId);
    passkeyPages.delete(tabId);
    signInUrls.delete(tabId);
    choicePasskeys.delete(tabId);
    runtime.popupAnswers.delete(tabId);
    clearTimeout(entryTimers.get(tabId));
    entryTimers.delete(tabId);
    for (const key of entryRefused) if (key.startsWith(`${tabId} `)) entryRefused.delete(key);
    for (const map of [passkeyRequests, passkeyAnswers])
      for (const key of map.keys()) if (key.startsWith(`${tabId} `)) map.delete(key);
    void runtime.sessionLoaded.then(async () => {
      let changed = pending.delete(tabId);
      if (picked.delete(tabId)) changed = true;
      for (const keys of [logouts, stoppedAsks, rejectedAsks])
        for (const key of keys)
          if (key.startsWith(`${tabId} `)) changed = keys.delete(key) || changed;
      for (const key of logoutFills)
        if (key.startsWith(`${tabId} `)) changed = logoutFills.delete(key) || changed;
      if (entryPresses.delete(tabId)) changed = true;
      for (const key of noted.keys())
        if (key.startsWith(`${tabId} `)) changed = noted.delete(key) || changed;
      if (changed) await quietly(runtime.saveSession);
      return undefined;
    });
    runtime.storageQueue = runtime.storageQueue
      .then(async () => {
        await runtime.loaded;
        for (const [key, metadata] of persisted)
          if (metadata.document.tabId === tabId) persisted.delete(key);
        await runtime.attemptRecords.write([...persisted.values()]);
        return undefined;
      })
      .catch(() => {
        runtime.storageHealthy = false;
      });
  }
  // A worker restart does not reinstall content scripts. Rebind browser-provided
  // document identity before reconciling, without restoring pending side effects.
  void runtime.loaded
    .then(async () => {
      if (!runtime.storageHealthy) return undefined;
      const patterns = [
        ...(probeMode ? [`${runtime.origin}/*`] : []),
        ...(sites ? (await sites.origins()).map((entry) => `${entry}/*`) : []),
        // An automatically chosen account has no saved default until it authenticates.
        ...[...persisted.values()].map((entry) => `${entry.account.origin}/*`),
      ];
      const tabs = patterns.length ? await browser.tabs.query({ url: patterns }) : [];
      // A frame's attempt lives in a tab whose own URL may be on another origin.
      const tabIds = new Set([
        ...tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])),
        ...[...persisted.values()].map((entry) => entry.document.tabId),
      ]);
      for (const tabId of tabIds)
        void browser.tabs
          // Every frame announces again; a frame inside the page may hold the attempt.
          .sendMessage(tabId, { version: 1, type: "login.reconnect" })
          .catch(() => undefined);
      await runtime.sessionLoaded;
      for (const waiting of pending.values())
        if (!tabIds.has(waiting.document.tabId)) void runtime.revive(waiting);
      return undefined;
    })
    .catch(() => undefined);
  /**
   * Whether a login is in progress; a policy write now would stop it. An attempt between
   * pages has no current document, so its saved state counts too, once it is loaded;
   * a settled one counts only as `inProgress` says.
   */
  async function active(): Promise<boolean> {
    await runtime.loaded;
    return (
      [...attempts.values()].some(runtime.inProgress) ||
      [...persisted.values()].some((metadata) => !terminal(metadata) && !idle(metadata))
    );
  }
  /**
   * The vault item of the login a tab is running on an origin. The passkey bridge answers
   * that login's requests with this item only (ADR 0027). A login runs while its record,
   * in memory or read back from storage after a worker restart, is neither authenticated
   * nor blocked, its result has not settled as unknown since it last moved on, and it is
   * not watched (ADR 0027).
   */
  async function loginAccount(
    tabId: number,
    siteOrigin: string,
  ): Promise<{ connectionId: string; itemId: string } | undefined> {
    await runtime.loaded;
    const metadata = runtime.recordFor(tabId, siteOrigin);
    return metadata && !terminal(metadata) && !idle(metadata)
      ? { connectionId: metadata.account.connectionId, itemId: metadata.account.itemId }
      : undefined;
  }
  return {
    handle,
    settingsChanged,
    /** A site default was saved outside the settings page, as by the passkey chooser. */
    siteDefaultSaved: () => void runtime.choiceDefaults(),
    active,
    loginAccount,
    passkeyRequested: runtime.passkeyRequested,
    passkeyAnswered: runtime.passkeyAnswered,
    conditionalRequest: runtime.conditionalRequest,
  };
}
