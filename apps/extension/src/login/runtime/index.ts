import * as v from "valibot";
import {
  attemptRouteChoice,
  continuesRecipe,
  createAttemptMetadata,
  extendsRecipe,
  isGeneratedRecipeId,
  parseAttemptMetadata,
  passkeyAnswersRequest,
  passwordVariants,
  languageDecides,
  layoutFirstSteps,
  rankLayouts,
  layoutStartTargets,
  recipeStartSteps,
  laterStartSteps,
  recoverLoginAttempt,
  followPage,
  personAnswered,
  routeSteps,
  sameLoginDocument,
  transitionLoginAttempt,
  type LoginAttemptMetadata,
  type LoginDocument,
  itemAsksForMasterPassword,
  chooserRoute,
  type ChooserClick,
  type LoginChooserRecipe,
  type LoginRecipe,
  type LocalSettings,
} from "@pateat/contracts";
import { browser, type Browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import {
  configureSchema,
  type ListMissReport as ListMiss,
  laterReadiness,
  loginReadiness,
} from "../wire";
import { DEMO_PROBE_ACCOUNT, probeRecipe } from "../dummy";
import { allowlistOf } from "../pause";
import { observedPath } from "../../observation/path";
import { namesReturnPath } from "../entry";
import { newId } from "@pateat/contracts/ids";
import { quietly, keep, forget } from "./session-store";
import {
  PICKS_KEY,
  CHOICES_KEY,
  STOPPED_ASKS_KEY,
  REJECTED_ASKS_KEY,
  ASK_FILLS_KEY,
  ENTRY_PRESSES_KEY,
  NOTED_KEY,
  RELOGINS_KEY,
  DETAIL_OFFERS_KEY,
  PENDING_DETAILS_KEY,
  REFUSED_DETAILS_KEY,
  pickedAccountSchema,
  pendingChoiceSchema,
  askSchema,
  reloginSchema,
  entryPressSchema,
  detailOfferSchema,
  pendingDetailSchema,
  refusedDetailSchema,
} from "./session-schemas";
import {
  choiceBadge,
  recordKey,
  reloginKey,
  frameKey,
  documentKey,
  sameSiteAs,
  rawPath,
  logCode,
  codeAwaitsClick,
  autoSubmitted,
} from "./steps";
import {
  armEntryTimer,
  checkAfterPress,
  pressEntry,
  refuseEntry,
  switchingTab,
  entryOfferRefusal,
  generateEntryFor,
  asksEveryTime,
} from "./entry-press";
import { refusalKey } from "./detail-fill";
import {
  probeMode,
  AFTER_SIGN_IN_MS,
  SITE_MOVE_MS,
  WATCH_MS,
  CHOICE_SAVED,
  REPROMPT_GRANT_MS,
  PASSKEY_SIGN_IN_MS,
  PASSKEY_SIGNED_IN,
} from "./constants";
import { pausingSettings, showTabPause, pauseOf, endPickedPause } from "./pause";
import {
  forgetTab,
  incognitoClosed,
  identify,
  active,
  handle,
  settingsChanged,
  choiceDefaults,
  loginAccount,
} from "./messages";
import {
  saveSession,
  send,
  reportAttempt,
  publish,
  report,
  noteSignedIn,
  startTiming,
  save,
} from "./attempt";
import { revive, clearChoice, askFor, offerChoice } from "./choice";
import {
  type Sender,
  type Shown,
  type ListOffer,
  type Announced,
  type Unoffered,
  type Readiness,
  type LiveDocument,
  type ConfirmVisit,
  type Execution,
  type LayoutChoice,
  type LaterStart,
  type GenerationMiss,
} from "./types";
import {
  leaveConfirm,
  previousPage,
  confirmSigns,
  confirmPage,
  rankedLayouts,
  listReadiness,
  showsNow,
  showsAnyMarker,
  observedLanguage,
  listedNames,
  listClick,
} from "./markers";
import {
  noteUnadmitted,
  note,
  loginRelated,
  skipGeneration,
  generateFor,
  recipeInUse,
  retryAfterSync,
  choicesSaved,
} from "./generation";
import { tabAttempt, recordFor, signedInElsewhere, heldElsewhere, showHeld } from "./hold";
import { terminal, finishedLogin, watchOver, stoppedByPateat, holdsSite } from "./attempt-state";
import { dropReprompt, askMasterPassword, holdPassword } from "./master-password";
import { type MoveMiss, type PolicyChange } from "./report";
import { countRelogin, signedInNow, addAskFill, reloginLimited } from "./relogin";
import { remember, noteChoice } from "./choice-save";
import {
  passkeyMoveFits,
  passwordMoveFits,
  passkeyPageFits,
  stillAsking,
  holdForPasskey,
} from "./moves";
import {
  signedInByPasskey,
  signedInByPassword,
  reviewRequests,
  parkedFor,
  restartForRequest,
  retryAfterPasskey,
  passkeyReverification,
  passkeyRequested,
  passkeyAnswered,
  conditionalRequest,
} from "./passkey";
import {
  confirmRecipeOn,
  startsFor,
  offersOther,
  generationSlotsFor,
  offersGeneration,
} from "./generation-scope";
import { repairStale, repairUnfit, repairChooser } from "./repair-run";
import { planFor } from "./plan";
import { drive } from "./run-steps";
import type { Runtime } from "./state";

import { createRuntimeState } from "./state";
import type { SettingsRuntime, LoginRuntimeOptions } from "./deps";

export function createLoginRuntime(settings: SettingsRuntime, options: LoginRuntimeOptions) {
  const rt = createRuntimeState(settings, options);
  startRuntime(rt);
  /**
   * The site count's way to the vault (ADR 0021): the same vault-replacement hold an
   * admission takes, and each crypto job run only while no login runs and no page is being
   * admitted, checked again before each job.
   */
  const siteCount = {
    hold: async (): Promise<() => void> =>
      (await rt.options.vault?.enter(false)) ?? (() => undefined),
    async step<T>(job: () => Promise<T>): Promise<{ value: T } | undefined> {
      if (rt.admitting.size > 0 || (await active(rt)) || rt.admitting.size > 0) return undefined;
      const run = job();
      rt.vars.counting = run;
      try {
        return { value: await run };
      } finally {
        if (rt.vars.counting === run) rt.vars.counting = undefined;
      }
    },
  };
  return {
    handle: (message: unknown, sender: Sender) => handle(rt, message, sender),
    settingsChanged: (source: "synced" | "saved") => settingsChanged(rt, source),
    siteCount,
    /** A site default was saved outside the settings page, as by the passkey chooser. */
    siteDefaultSaved: () => void choiceDefaults(rt),
    active: () => active(rt),
    loginAccount: (tabId: number, siteOrigin: string) => loginAccount(rt, tabId, siteOrigin),
    passkeyReverification: (tabId: number, siteOrigin: string) =>
      passkeyReverification(rt, tabId, siteOrigin),
    passkeyRequested: (tabId: number, siteOrigin: string) =>
      passkeyRequested(rt, tabId, siteOrigin),
    passkeyAnswered: (
      tabId: number,
      siteOrigin: string,
      rpId: string,
      item?: { connectionId: string; itemId: string },
      facts?: { silent?: true; incognito: boolean; documentId?: string },
    ) => passkeyAnswered(rt, tabId, siteOrigin, rpId, item, facts),
    conditionalRequest: (input: {
      tabId: number;
      origin: string;
      documentId: string;
      signal: AbortSignal;
      /** Whether the tab is incognito, as the request's sender says (ADR 0062). */
      incognito?: boolean;
    }) => conditionalRequest(rt, input),
    /**
     * Whether a passkey request of the origin treats the saved default as unset (ADR 0063):
     * `paused` while automatic login of its site is paused in the window kind of its tab
     * (ADR 0062), else true when Pateat logged in to its site twice in 10 minutes (the
     * relogin guard) or its site asks every time after a pick that did not make its account
     * the default. Automatic login being off in private windows does not count: the person's
     * own request there is answered as in any window (ADR 0062 E).
     */
    defaultUnset: async (
      pageOrigin: string,
      incognito: boolean,
      /**
       * The settings as the caller already read them, such as the passkey runtime's copy
       * read ahead of requests, so the request need not wait for the settings store.
       */
      readAhead?: Pick<
        LocalSettings,
        | "excludedSites"
        | "allowedSites"
        | "allowedSitesEnabled"
        | "loginInPrivateWindows"
        | "siteDefaults"
      >,
    ): Promise<boolean | "paused"> => {
      // Read at once, so a passkey request waits for the slowest read only.
      const [pausedBy, limited, asking] = await Promise.all([
        pauseOf(
          rt,
          { url: pageOrigin, incognito },
          {
            private: false,
            ...(readAhead
              ? {
                  policy: {
                    excludedSites: readAhead.excludedSites,
                    ...allowlistOf(readAhead),
                    ...(readAhead.loginInPrivateWindows ? { loginInPrivateWindows: true } : {}),
                  },
                }
              : {}),
          },
        ),
        rt.vars.sessionLoaded.then(() => reloginLimited(rt, pageOrigin, incognito)),
        asksEveryTime(rt, pageOrigin, incognito, undefined, readAhead?.siteDefaults),
      ]);
      if (pausedBy !== undefined) return "paused";
      return limited || asking;
    },
    /** A tab's page changed: a page of a paused site shows `II` on its badge (ADR 0062). */
    tabLoaded: (tab: Browser.tabs.Tab) => showTabPause(rt, tab).catch(() => undefined),
  };
}

function startRuntime(rt: Runtime) {
  // Picks and waiting choices outlive a worker restart, as the tab's badge does. Every
  // change to them happens after this load.
  rt.vars.sessionRead = quietly(rt, async () => {
    const items = await storage.getItems([
      PICKS_KEY,
      CHOICES_KEY,
      STOPPED_ASKS_KEY,
      REJECTED_ASKS_KEY,
      ASK_FILLS_KEY,
      ENTRY_PRESSES_KEY,
      NOTED_KEY,
      RELOGINS_KEY,
      DETAIL_OFFERS_KEY,
      PENDING_DETAILS_KEY,
      REFUSED_DETAILS_KEY,
    ]);
    const stored = Object.fromEntries(items.map(({ key, value }) => [key, value]));
    const picks = v.safeParse(v.array(pickedAccountSchema), stored[PICKS_KEY] ?? []);
    if (picks.success) for (const entry of picks.output) rt.picked.set(entry.tabId, entry);
    const choices = v.safeParse(v.array(pendingChoiceSchema), stored[CHOICES_KEY] ?? []);
    if (choices.success)
      for (const entry of choices.output) {
        rt.pending.set(entry.document.tabId, entry);
        // Chrome kept the tab's badge; the badge learns the choice it shows again.
        rt.badge.choice(
          entry.document.tabId,
          choiceBadge(entry.candidates, entry.ask, entry.paused),
        );
      }
    const stopped = v.safeParse(v.array(askSchema), stored[STOPPED_ASKS_KEY] ?? []);
    if (stopped.success)
      for (const entry of stopped.output) rt.stoppedAsks.add(recordKey(entry.tabId, entry.origin));
    const rejected = v.safeParse(v.array(askSchema), stored[REJECTED_ASKS_KEY] ?? []);
    if (rejected.success)
      for (const entry of rejected.output)
        rt.rejectedAsks.add(recordKey(entry.tabId, entry.origin));
    const filled = v.safeParse(
      v.pipe(v.array(v.string()), v.maxLength(256)),
      stored[ASK_FILLS_KEY] ?? [],
    );
    if (filled.success) for (const entry of filled.output) rt.askFills.add(entry);
    const counted = v.safeParse(
      v.pipe(v.array(reloginSchema), v.maxLength(256)),
      stored[RELOGINS_KEY] ?? [],
    );
    if (counted.success)
      for (const entry of counted.output)
        rt.relogins.set(reloginKey(entry.site, entry.incognito), entry);
    const logged = v.safeParse(
      v.pipe(v.array(v.tuple([v.string(), v.array(v.string())])), v.maxLength(256)),
      stored[NOTED_KEY] ?? [],
    );
    // Every note waits for this load.
    if (logged.success)
      for (const [key, reasons] of logged.output) rt.noted.set(key, new Set(reasons));
    const presses = v.safeParse(
      v.pipe(v.array(entryPressSchema), v.maxLength(256)),
      stored[ENTRY_PRESSES_KEY] ?? [],
    );
    if (presses.success)
      for (const entry of presses.output) {
        rt.entryPresses.set(entry.tabId, entry);
        // A press whose next page was not checked before a restart is checked in time.
        if (!entry.checked) armEntryTimer(rt, entry);
      }
    const offers = v.safeParse(
      v.pipe(v.array(detailOfferSchema), v.maxLength(256)),
      stored[DETAIL_OFFERS_KEY] ?? [],
    );
    if (offers.success)
      for (const entry of offers.output) rt.detailOffers.set(entry.document.tabId, entry);
    const kept = v.safeParse(
      v.pipe(v.array(pendingDetailSchema), v.maxLength(1024)),
      stored[PENDING_DETAILS_KEY] ?? [],
    );
    if (kept.success)
      for (const entry of kept.output)
        rt.pendingDetails.set(entry.tabId, [...(rt.pendingDetails.get(entry.tabId) ?? []), entry]);
    const refused = v.safeParse(
      v.pipe(v.array(refusedDetailSchema), v.maxLength(1000)),
      stored[REFUSED_DETAILS_KEY] ?? [],
    );
    if (refused.success)
      for (const entry of refused.output)
        rt.refusedDetails.set(refusalKey(rt, entry, entry.detail, entry.field), entry);
  });

  // An account switch whose worker stopped while it logged out ended with it: its pick is
  // dropped and the popup says so. One that had signed out still waits for the login page
  // (ADR 0063).
  rt.vars.sessionLoaded = rt.vars.sessionRead.then(() =>
    quietly(rt, async () => {
      const { interrupted, signedOut } = await rt.accountPicks.restored();
      for (const pick of interrupted)
        rt.switchStates.set(pick.tabId, {
          state: "failed",
          reason: "interrupted",
          connectionId: pick.connectionId,
          itemId: pick.itemId,
        });
      for (const pick of signedOut)
        rt.switchStates.set(pick.tabId, {
          state: "signed-out",
          connectionId: pick.connectionId,
          itemId: pick.itemId,
        });
    }),
  );

  rt.vars.loaded = (async () => {
    try {
      const [config, stored] = await Promise.all([rt.probeConfig.read(), rt.attemptRecords.read()]);
      if (probeMode && config !== undefined) {
        const parsed = v.parse(configureSchema, {
          version: 1,
          type: "login.probe.configure",
          ...(config as object),
        });
        rt.vars.origin = parsed.origin;
        rt.vars.account = parsed.account ?? DEMO_PROBE_ACCOUNT;
        rt.vars.probePasskey = parsed.passkey;
        rt.vars.probeTotp = parsed.totp === true;
        rt.vars.probeStepWaitMs = parsed.stepWaitMs;
      }
      if (stored === undefined) return;
      if (!Array.isArray(stored) || stored.length > 100) throw new Error("Invalid attempt store");
      for (const entry of stored) {
        const metadata = recoverLoginAttempt(parseAttemptMetadata(entry));
        const key = recordKey(metadata.document.tabId, metadata.account.origin);
        if (rt.persisted.has(key)) throw new Error("Duplicate attempt scope");
        rt.persisted.set(key, metadata);
      }
      // Complete startup reconciliation before accepting any hello or checking
      // ownership. Closing a tab can wake a worker whose in-memory map is empty.
      const openTabs = await browser.tabs.query({});
      for (const tab of openTabs)
        if (tab.id !== undefined && !rt.incognitoTabs.has(tab.id))
          rt.incognitoTabs.set(tab.id, tab.incognito);
      const liveIds = new Set(openTabs.map((tab) => tab.id));
      for (const [key, metadata] of rt.persisted)
        if (!liveIds.has(metadata.document.tabId) && !rt.replacedTabs.has(metadata.document.tabId))
          rt.persisted.delete(key);
      await rt.attemptRecords.write([...rt.persisted.values()]);
    } catch {
      rt.vars.storageHealthy = false;
    }
  })();

  rt.vars.policyRead = (async () => {
    rt.vars.appliedPolicy ??= await pausingSettings(rt);
  })();

  browser.tabs.onRemoved.addListener((tabId) => forgetTab(rt, tabId));

  browser.windows?.onRemoved?.addListener(() => void incognitoClosed(rt));

  // Chrome gives a tab a new ID when it discards it to save memory. It is the same tab to
  // the user: what the tab did moves to the new ID, and the gone page is forgotten as on
  // a close (ADR 0021). The event may be what starts the worker.
  browser.tabs.onReplaced.addListener((added, removed) => {
    if (added === removed) return;
    rt.replacedTabs.add(removed);
    // An account switch's pick and state go with the tab, as to a prerendered sign-in page
    // (ADR 0063); moved before `forgetTab` below ends the gone tab's.
    void rt.accountPicks.moveSwitch(removed, added).catch(() => undefined);
    const switching = rt.switchStates.get(removed);
    if (switching) rt.switchStates.set(added, switching);
    // A switch still logging out goes on in the new tab.
    const driven = rt.switchTabs.get(removed);
    if (driven) {
      driven.id = added;
      rt.switchTabs.delete(removed);
      rt.switchTabs.set(added, driven);
    }
    if (rt.switchesRunning.delete(removed)) rt.switchesRunning.add(added);
    const incognito = rt.incognitoTabs.get(removed);
    if (incognito !== undefined && !rt.incognitoTabs.has(added))
      rt.incognitoTabs.set(added, incognito);
    const moved = (key: string) =>
      key.startsWith(`${removed} `) ? `${added}${key.slice(String(removed).length)}` : key;
    void rt.vars.sessionLoaded.then(async () => {
      let changed = false;
      for (const keys of [rt.stoppedAsks, rt.rejectedAsks])
        for (const key of [...keys])
          if (moved(key) !== key) {
            keys.delete(key);
            keys.add(moved(key));
            changed = true;
          }
      const press = rt.entryPresses.get(removed);
      if (press) {
        const kept = { ...press, tabId: added };
        rt.entryPresses.delete(removed);
        rt.entryPresses.set(added, kept);
        if (!kept.checked) armEntryTimer(rt, kept);
        changed = true;
      }
      // A pick that started its login stays with that login; one for the gone page does not.
      const pick = rt.picked.get(removed);
      if (pick?.attemptId !== undefined) {
        rt.picked.delete(removed);
        rt.picked.set(added, { ...pick, tabId: added });
        changed = true;
      }
      if (changed) await quietly(rt, () => saveSession(rt));
      return undefined;
    });
    rt.vars.storageQueue = rt.vars.storageQueue
      .then(async () => {
        await rt.vars.loaded;
        let changed = false;
        for (const [key, metadata] of [...rt.persisted])
          if (metadata.document.tabId === removed) {
            rt.persisted.delete(key);
            rt.persisted.set(recordKey(added, metadata.account.origin), {
              ...metadata,
              document: { ...metadata.document, tabId: added },
            });
            changed = true;
          }
        rt.replacedTabs.delete(removed);
        if (changed) await rt.attemptRecords.write([...rt.persisted.values()]);
        return undefined;
      })
      .catch(() => {
        rt.vars.storageHealthy = false;
      });
    // The discarded page was not left: it loads again in the new tab and is logged there.
    rt.confirmVisits.delete(removed);
    forgetTab(rt, removed);
  });

  // Pauses outlive a worker restart, and so does `II` on the badge of each tab of a paused
  // site, until its pause ends (ADR 0062).
  void browser.tabs
    .query({})
    .then((tabs) => Promise.all(tabs.map((tab: Browser.tabs.Tab) => showTabPause(rt, tab))))
    .catch(() => undefined);

  // A worker restart does not reinstall content scripts. Rebind browser-provided
  // document identity before reconciling, without restoring pending side effects.
  void rt.vars.loaded
    .then(async () => {
      if (!rt.vars.storageHealthy) return undefined;
      const patterns = [
        ...(probeMode ? [`${rt.vars.origin}/*`] : []),
        ...(rt.sites ? (await rt.sites.origins()).map((entry) => `${entry}/*`) : []),
        // An automatically chosen account has no saved default until it authenticates.
        ...rt.persisted.values().map((entry) => `${entry.account.origin}/*`),
      ];
      const tabs = patterns.length ? await browser.tabs.query({ url: patterns }) : [];
      // A frame's attempt lives in a tab whose own URL may be on another origin.
      const tabIds = new Set([
        ...tabs.flatMap((tab) => (tab.id === undefined ? [] : [tab.id])),
        ...rt.persisted.values().map((entry) => entry.document.tabId),
      ]);
      for (const tabId of tabIds)
        void browser.tabs
          // Every frame announces again; a frame inside the page may hold the attempt.
          .sendMessage(tabId, { version: 1, type: "login.reconnect" })
          .catch(() => undefined);
      await rt.vars.sessionLoaded;
      for (const waiting of rt.pending.values())
        if (!tabIds.has(waiting.document.tabId)) void revive(rt, waiting);
      return undefined;
    })
    .catch(() => undefined);
}

export async function admit(
  rt: Runtime,
  sender: Sender,
  token: string,
  helloKey: string,
  sequence: number,
  start?: { path: string },
  signIn?: { path: string; identifier?: true | undefined; passkey?: true | undefined },
  shown?: Shown,
  list?: ListOffer,
  entryHello?: Announced,
  unoffered?: Unoffered,
  switchedInPlace?: true,
): Promise<Readiness> {
  await rt.vars.loaded;
  await rt.vars.sessionLoaded;
  const document = await identify(rt, sender);
  if (!document || !sender.url) {
    if (sender.frameId === 0 && sender.tab?.id !== undefined) {
      // A page Pateat does not fill was left for a page it does not read, which is also
      // the tab's previous page for the next one it reads (ADR 0035).
      const visit = rt.confirmVisits.get(sender.tab.id);
      if (visit && visit.document.documentId !== sender.documentId) leaveConfirm(rt, visit);
      const top = rt.documents.get(frameKey({ tabId: sender.tab.id, frameId: 0 }));
      if (top && top.document.documentId !== sender.documentId) top.leftUnread = true;
    }
    await noteUnadmitted(rt, sender);
    return { ok: false, reason: "unauthorized-document" };
  }
  if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
  const key = frameKey(document);
  // The tab's next page of the origin after a submitted password form (ADR 0028).
  const submitted = rt.passwordSubmits.get(document.tabId);
  if (submitted && document.frameId === 0 && submitted.documentId !== document.documentId) {
    // Only the tab's next page counts: one of another origin ends the skip.
    rt.passwordSubmits.delete(document.tabId);
    // A clock that went back keeps the skip: sending the page is the less safe outcome.
    if (submitted.origin === document.origin && Date.now() - submitted.at < AFTER_SIGN_IN_MS)
      rt.afterSignIn.set(document.tabId, document.documentId);
  }
  // A new page in the tab replaces the document that waited for a choice.
  const waiting = rt.pending.get(document.tabId);
  if (
    waiting?.document.frameId === 0 &&
    document.frameId === 0 &&
    waiting.document.documentId !== document.documentId
  )
    clearChoice(rt, document.tabId);
  // `sender.url` keeps the URL the document loaded with; a same-document URL change
  // (history.pushState) of the tab's page shows only in the tab's committed URL. A frame
  // inside the page keeps its load URL and records the tab's URL to match as well.
  let url = sender.url;
  let topUrl: string | undefined;
  // The sender's tab says whether its window is incognito; `tabs.get` is asked otherwise.
  let incognito = sender.tab?.incognito;
  try {
    const tab = await browser.tabs.get(document.tabId);
    incognito ??= tab.incognito;
    if (document.frameId !== 0) {
      // A frame's page is a web page; any other URL means the tab moved on.
      if (!tab.url || !/^https?:$/.test(new URL(tab.url).protocol))
        return { ok: false, reason: "stale-document" };
      topUrl = tab.url;
    } else if (tab.url && new URL(tab.url).origin === document.origin) url = tab.url;
  } catch {
    return { ok: false, reason: "closed-tab" };
  }
  if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
  // A tab runs one attempt. Another frame of the tab, such as an embedded widget or the
  // page around a framed login, never takes it over or disturbs it. Only a new page in
  // the tab (another top document) ends an attempt held by a frame of the old page.
  let owner = tabAttempt(rt, document.tabId);
  const page = rt.documents.get(frameKey({ tabId: document.tabId, frameId: 0 }));
  let newPage =
    document.frameId === 0 &&
    page !== undefined &&
    page.document.documentId !== document.documentId;
  if (newPage) {
    // Frames of this page may have announced before it did. Only documents that no
    // longer answer went away with the old page.
    // A frame that does not answer in time counts as still there.
    const frames = [...rt.documents].filter(
      ([, entry]) => entry.document.tabId === document.tabId && entry.document.frameId !== 0,
    );
    const answers = await Promise.all(
      frames.map(([, entry]) =>
        Promise.race([
          send(rt, entry, { type: "login.observe", path: entry.path, targets: [] }).then(
            () => true,
            () => false,
          ),
          new Promise<boolean>((resolve) => setTimeout(resolve, 1000, true)),
        ]),
      ),
    );
    for (const [index, [other]] of frames.entries())
      if (!answers[index]) rt.documents.delete(other);
    if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
    owner = tabAttempt(rt, document.tabId);
    const holder = owner && rt.documents.get(frameKey(owner.document));
    if (owner && owner.document.frameId !== 0) {
      if (holder && sameLoginDocument(holder.document, owner.document)) {
        // The frame holding the attempt is still there, so this page is its parent.
        newPage = false;
      } else if (!terminal(owner)) {
        // The frame's page is gone: its attempt ends without resubmitting, whatever
        // origin the new page has.
        const run = rt.attempts.get(document.tabId);
        const ended = transitionLoginAttempt(run?.metadata ?? recoverLoginAttempt(owner), {
          type: "NAVIGATED",
          document,
        });
        if (run) run.metadata = ended;
        reportAttempt(rt, ended, run?.recipe);
        try {
          await keep(rt, ended);
        } catch {
          return { ok: false, reason: "storage-unavailable" };
        }
        if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
        owner = ended;
      }
    }
  }
  // The site the tab shows now. A login on another site's page, in the page or in one of
  // its frames, is a login of a site the tab left: it never holds a document of this
  // site, and a top-level one still running ends below.
  const siteOrigin = topUrl ? new URL(topUrl).origin : document.origin;
  const leftSite = (record: LoginAttemptMetadata) => {
    const site = record.document.frameId === 0 ? record.account.origin : record.pageOrigin;
    return site !== undefined && site !== siteOrigin;
  };
  // A busy document is still recorded, so a later new page in the tab is recognized.
  const busy =
    owner !== undefined &&
    !leftSite(owner) &&
    owner.document.frameId !== document.frameId &&
    !newPage;
  const oldLive = rt.documents.get(key);
  const sameDocument = oldLive !== undefined && sameLoginDocument(oldLive.document, document);
  // A document may announce again when its form appears or its URL changes in place,
  // but never while it already carries an attempt, unless that login finished and the
  // document now watches for its first step again (ADR 0062), the login is watched and
  // its first step shows in the document (ADR 0027), or the login switched accounts and
  // the document, changed in place, announces itself as a new page (ADR 0078).
  const carried = rt.attempts.get(document.tabId);
  if (
    sameDocument &&
    (oldLive.token !== token ||
      (carried?.live === oldLive &&
        !(
          document.frameId === 0 &&
          (finishedLogin(carried.metadata) ||
            (switchedInPlace &&
              carried.metadata.state === "blocked" &&
              carried.metadata.outcome === "account-switched") ||
            (carried.metadata.watch !== undefined &&
              start?.path === observedPath(new URL(url).pathname) &&
              document.documentId !== carried.metadata.watch.documentId))
        )))
  ) {
    note(rt, document, url, "duplicate-document");
    return { ok: false, reason: "duplicate-document" };
  }
  if (oldLive && !sameDocument)
    await send(rt, oldLive, { type: "login.cancel" }).catch(() => undefined);
  const path = observedPath(new URL(url).pathname);
  const previousUrl = previousPage(rt, document, oldLive, sameDocument, path);
  const live: LiveDocument = {
    document,
    token,
    url,
    path,
    ...(topUrl ? { topUrl } : {}),
    ...(incognito === undefined ? {} : { incognito }),
    ...(previousUrl ? { previousUrl } : {}),
    // A document announcing again on the same path logs each generation skip once.
    ...(sameDocument && oldLive.path === path && oldLive.generationSkip
      ? { generationSkip: oldLive.generationSkip }
      : {}),
    ...(sameDocument && oldLive.path === path && oldLive.notStarted
      ? { notStarted: oldLive.notStarted }
      : {}),
    seenAt: sameDocument ? oldLive.seenAt : Date.now(),
    // A document that waited for a locked vault starts its login's time again once it can
    // read it: unlocking the vault comes before any login (ADR 0019).
    timing:
      sameDocument && oldLive.reason !== "vault-unavailable"
        ? oldLive.timing
        : { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 },
    ...(sameDocument && oldLive.path === path && oldLive.entryRefusals
      ? { entryRefusals: oldLive.entryRefusals }
      : {}),
  };
  if (oldLive && !sameDocument)
    dropReprompt(rt, oldLive.document.tabId, oldLive.document.documentId);
  rt.documents.set(key, live);
  // The tab's next page after a page Pateat does not fill (ADR 0035).
  const earlier = rt.confirmVisits.get(document.tabId);
  if (
    earlier &&
    document.frameId === 0 &&
    (earlier.document.documentId !== document.documentId || earlier.path !== path)
  )
    leaveConfirm(rt, earlier, live);
  // Automatic login of the page's site is paused (ADR 0062): its own site's or, for a
  // frame, also its tab's. The tab's page shows the pause on the badge.
  const pauseState = await pauseOf(rt, live);
  const paused = pauseState !== undefined;
  if (document.frameId === 0) rt.badge.paused?.(document.tabId, pauseState);
  if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
  // The first other top document of the tab after an effect step, when it comes soon
  // enough to be the site's answer to it (ADR 0029). One announced later, as after the
  // person's own retry in a page the login settled on, is never read as that answer.
  const effect = rt.effects.get(document.tabId);
  if (
    effect &&
    effect.next === undefined &&
    document.frameId === 0 &&
    !sameLoginDocument(effect.document, document) &&
    Date.now() - effect.at <= SITE_MOVE_MS
  )
    effect.next = document.documentId;
  const refuse = async (
    reason: string,
    detail?: string,
    unrelated?: boolean,
    candidates?: number,
  ) => {
    note(rt, document, live.url, reason, detail, unrelated, candidates);
    live.state = "denied";
    live.reason = reason;
    if (detail === undefined) delete live.refusal;
    else live.refusal = detail;
    await publish(rt, live);
    return { ok: false, reason };
  };
  // A sign-in input shows on this path, but the page only watches: logged once per
  // document and path, so a login that silently does not start can be told apart.
  const notStarted = (detail: string, visit?: ConfirmVisit) => {
    if (shown?.path !== live.path || live.notStarted === detail) return;
    live.notStarted = detail;
    const refused = {
      type: "refused" as const,
      tabId: document.tabId,
      origin: document.origin,
      reason: "not-started",
      detail,
      ...(document.frameId === 0 ? {} : { frame: true as const }),
    };
    if (!visit) {
      const later = shown?.later;
      report(rt, document, {
        ...refused,
        ...(detail === "first-step-missing" && recipe
          ? { recipeId: recipe.id, recipeRevision: recipe.revision }
          : {}),
        ...(later
          ? { laterSteps: later.steps, laterPartial: later.partial, laterMiss: later.miss }
          : {}),
      });
      return;
    }
    // A page Pateat does not fill also logs what it shows for the evaluation of page kinds
    // (ADR 0035), read first, so the entry names this page's URL; its visit logs the
    // person's submission and the next page once the tab leaves it.
    const amount = shown?.amount;
    visit.logged = confirmSigns(rt, live).then((signs) => {
      report(rt, document, {
        ...refused,
        recipeId: visit.recipe.id,
        recipeRevision: visit.recipe.revision,
        pageKind: visit.recipe.pageKind,
        ...(amount === undefined ? {} : { amount }),
        ...signs,
        url: live.url,
      });
      // Read as the `signedIn` hint false: the page was read and neither shows, E2 also
      // when it was not read.
      return signs.e1 === false && signs.e2 !== true;
    });
    void visit.logged.catch(() => undefined);
  };
  // The page after a sign-in entry press is checked before anything else runs on it, and
  // one that blocked the entry is neither sent for generation nor logged in to (ADR 0031).
  const refusedKey = documentKey(document);
  if (!rt.entryRefused.has(refusedKey)) {
    await checkAfterPress(rt, live);
    if (rt.hellos.get(helloKey) !== sequence) return { ok: false, reason: "stale-document" };
  }
  if (rt.entryRefused.has(refusedKey)) return refuse("entry-blocked");
  // A report sent only for the log does not log the tab's hold again. A passkey page
  // (ADR 0053) is answered as the announcement it would be without its button: its list,
  // its entry, or, with neither, the log-only report of a page that offered nothing.
  const quiet = signIn?.passkey ? list || !entryHello : shown || list || unoffered;
  if (busy)
    return quiet && !start && (!signIn || signIn.passkey)
      ? { ok: false, reason: "tab-busy" }
      : refuse("tab-busy");
  if (!rt.vars.storageHealthy)
    return refuse(
      "storage-unavailable",
      undefined,
      !(await loginRelated(rt, document.tabId, document.frameId, document.origin)),
    );
  const holder = tabAttempt(rt, document.tabId);
  /** Logs why a move of `record` did not complete it, or that it was kept (ADR 0022). */
  const reportMove = (record: LoginAttemptMetadata, reason: MoveMiss, kept?: true) =>
    report(rt, document, {
      type: "move",
      tabId: document.tabId,
      origin: siteOrigin,
      recipeId: record.recipeId,
      recipeRevision: record.recipeRevision,
      route: record.route,
      reason,
      ...(document.frameId === 0 ? {} : { frame: true as const }),
      ...(kept ? { kept } : {}),
    });
  /**
   * Ends the tab's top-level attempt `latest`, run by `run` if it still runs, on its
   * tab's move to the page of `moved`, completed when `signedIn` (ADR 0022). Returns a
   * refusal when the record could not be stored.
   */
  const endMove = async (
    run: Execution | undefined,
    latest: LoginAttemptMetadata,
    moved: LoginDocument,
    signedIn: boolean,
  ) => {
    const before = run?.metadata ?? recoverLoginAttempt(latest);
    const ended = transitionLoginAttempt(before, {
      type: "NAVIGATED",
      document: moved,
      ...(signedIn ? { signedIn } : {}),
    });
    noteSignedIn(rt, before, ended, moved.origin);
    countRelogin(rt, before, ended, incognito === true);
    if (signedInNow(rt, before, ended)) void endPickedPause(rt, ended, run?.live);
    if (run) run.metadata = ended;
    reportAttempt(rt, ended, run?.recipe);
    try {
      await keep(rt, ended);
    } catch {
      return refuse("storage-unavailable");
    }
    if (ended.state === "authenticated" && run?.choice) await remember(rt, run);
    return undefined;
  };
  if (holder && !terminal(holder) && holder.document.frameId === 0 && leftSite(holder)) {
    // The tab's page moved to another origin: the attempt there ends without
    // resubmitting and keeps its record, and this page or its frame may start its own.
    // A frame stands for the tab's page, which left the attempt's origin. A move to the
    // passkey's site right after Pateat answered it, or to another origin of the site
    // right after a password submission, or of any site right after a second factor, to a
    // page that shows the account's username, completes the attempt instead, which only
    // the top page can tell: a frame of the new page waits for that check, or leaves the
    // move to the top page when one may follow.
    let ending = true;
    let signedIn = false;
    if (document.frameId !== 0) {
      // The top page announcing again during a check starts another, which is waited for
      // too; each check's own hello drops it once it settles.
      for (
        let check = rt.siteMoves.get(document.tabId), last: Promise<boolean> | undefined;
        check && check !== last;
        last = check, check = rt.siteMoves.get(document.tabId)
      )
        // eslint-disable-next-line no-await-in-loop
        await check;
      // A check that went stale, as when the top page announced again, ended nothing.
      // A login held by a page that asked for a passkey is left to the tab's top pages.
      if (
        passkeyMoveFits(rt, holder, document.tabId, siteOrigin) ||
        passwordMoveFits(rt, holder, document.tabId, siteOrigin) ||
        rt.passkeyPages.get(document.tabId)?.attemptId === holder.id
      )
        ending = false;
    } else {
      const check = passkeyMoveFits(rt, holder, document.tabId, siteOrigin)
        ? signedInByPasskey(rt, holder, live)
        : signedInByPassword(rt, holder, live);
      rt.siteMoves.set(document.tabId, check);
      try {
        signedIn = await check;
      } finally {
        if (rt.siteMoves.get(document.tabId) === check) rt.siteMoves.delete(document.tabId);
      }
    }
    if (rt.hellos.get(helloKey) !== sequence || rt.documents.get(key) !== live)
      return { ok: false, reason: "stale-document" };
    const miss: MoveMiss | undefined =
      document.frameId !== 0 ? (ending ? "no-factor" : undefined) : live.moveMiss;
    // Another page of the tab may have ended the attempt meanwhile.
    const running = () => {
      const latest = rt.attempts.get(document.tabId)?.metadata ?? tabAttempt(rt, document.tabId);
      return latest?.id === holder.id && !terminal(latest);
    };
    // A page that went away before it could be read, as a redirect through another
    // page does, is not where the move ended: the tab's next page is checked instead.
    if (miss === "page-gone" && running()) {
      reportMove(holder, miss, true);
      return { ok: false, reason: "stale-document" };
    }
    // Nor is a page of another origin of the site that asks for a passkey soon after the
    // attempt's last step: the attempt waits for the tab's next page, which a passkey
    // answered there with the attempt's own item lets complete it (`passkeyMoveFits`).
    // This page starts no login of its own meanwhile.
    const asked = async () =>
      passkeyPageFits(rt, holder, document, siteOrigin) &&
      (rt.passkeyPages.get(document.tabId)?.document.documentId !== document.documentId ||
        (await stillAsking(rt, live)));
    const held =
      document.frameId === 0 && !signedIn && miss !== undefined && running() && (await asked());
    if (rt.hellos.get(helloKey) !== sequence || rt.documents.get(key) !== live)
      return { ok: false, reason: "stale-document" };
    if (held && running()) {
      rt.passkeyPages.set(document.tabId, {
        attemptId: holder.id,
        document: { ...document, frameId: 0, origin: siteOrigin },
        requestedAt: Math.max(
          rt.passkeyRequests.get(`${document.tabId} ${siteOrigin}`) ?? 0,
          rt.passkeyPages.get(document.tabId)?.attemptId === holder.id
            ? rt.passkeyPages.get(document.tabId)!.requestedAt
            : 0,
        ),
      });
      holdForPasskey(rt, document.tabId);
      reportMove(holder, "passkey-request", true);
      return { ok: false, reason: "stale-document" };
    }
    const run = rt.attempts.get(document.tabId);
    const latest = run?.metadata ?? tabAttempt(rt, document.tabId);
    if (ending && latest?.id === holder.id && !terminal(latest)) {
      if (!signedIn && miss) reportMove(holder, miss);
      const refusal = await endMove(
        run,
        latest,
        { ...document, frameId: 0, origin: siteOrigin },
        signedIn,
      );
      if (refusal) return refusal;
    }
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
  } else if (
    holder &&
    !terminal(holder) &&
    document.frameId === 0 &&
    rt.passkeyPages.get(document.tabId)?.attemptId === holder.id
  ) {
    // The tab came back to the attempt's origin from a page of another origin of the site
    // that asked for a passkey (ADR 0022). A passkey answered there with the attempt's
    // own item, and this page quiet, complete the attempt; otherwise it ends as that move
    // would have, without resubmitting. A page that goes away before it is read leaves
    // the decision to the tab's next page.
    const asking = rt.passkeyPages.get(document.tabId)!;
    const check = signedInByPasskey(rt, holder, live);
    rt.siteMoves.set(document.tabId, check);
    let signedIn: boolean;
    try {
      signedIn = await check;
    } finally {
      if (rt.siteMoves.get(document.tabId) === check) rt.siteMoves.delete(document.tabId);
    }
    if (
      rt.hellos.get(helloKey) !== sequence ||
      rt.documents.get(key) !== live ||
      rt.passkeyPages.get(document.tabId) !== asking
    )
      return { ok: false, reason: "stale-document" };
    const run = rt.attempts.get(document.tabId);
    const latest = run?.metadata ?? tabAttempt(rt, document.tabId);
    if (latest?.id === holder.id && !terminal(latest)) {
      if (live.moveMiss === "page-gone") {
        reportMove(holder, live.moveMiss, true);
        return { ok: false, reason: "stale-document" };
      }
      rt.passkeyPages.delete(document.tabId);
      if (!signedIn && live.moveMiss) reportMove(holder, live.moveMiss);
      const refusal = await endMove(run, latest, asking.document, signedIn);
      if (refusal) return refusal;
    }
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
  }
  // A document resumes only its own origin's record in the tab, even an ended one, also
  // one of a site the tab left, so a login never submits there again.
  let recorded = recordFor(rt, document.tabId, document.origin);
  const askKey = recordKey(document.tabId, document.origin);
  // A fill-only login is forgotten when it ends; one a stopped worker left ended is too.
  if (recorded?.fillOnly && terminal(recorded)) {
    try {
      await forget(rt, askKey);
    } catch {
      return refuse("storage-unavailable");
    }
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    recorded = undefined;
  }
  /**
   * Releases a tab's finished login of this origin once its first step shows again (ADR
   * 0021 D, ADR 0062): the page then logs in as on any visit. After the site rejected that
   * login, the tab and the origin's other tabs ask for an account instead, and the page
   * that showed the rejection is never filled again. Returns a refusal when it could not,
   * else undefined.
   */
  const releaseFinished = async (
    released: LoginAttemptMetadata,
  ): Promise<Readiness | undefined> => {
    const { tabId } = released.document;
    const releasedKey = recordKey(tabId, document.origin);
    const rejected = released.outcome === "credential-rejected";
    if (rt.attempts.get(tabId)?.metadata.id === released.id) rt.attempts.delete(tabId);
    const unpicked = rt.picked.get(tabId)?.attemptId === released.id && rt.picked.delete(tabId);
    // The page that showed the rejection is never filled with an account again: the site
    // just refused what was filled there.
    const rejectedPage = documentKey(released.document);
    const asked = !rejected || rt.rejectedAsks.has(releasedKey);
    const unfilled = rejected && !rt.askFills.has(rejectedPage);
    // The tab must keep asking after a restart, so its ask is stored first.
    if (!asked || unfilled) {
      rt.rejectedAsks.add(releasedKey);
      if (unfilled) addAskFill(rt, rejectedPage);
      try {
        await saveSession(rt);
      } catch {
        if (!asked) rt.rejectedAsks.delete(releasedKey);
        if (unfilled) rt.askFills.delete(rejectedPage);
        return refuse("storage-unavailable");
      }
    } else if (unpicked) void quietly(rt, () => saveSession(rt));
    try {
      await forget(rt, releasedKey);
    } catch {
      return refuse("storage-unavailable");
    }
    // A page of that tab admitted meanwhile may have resumed the record; it stops too.
    if (rt.attempts.get(tabId)?.metadata.id === released.id) rt.attempts.delete(tabId);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    return undefined;
  };
  /**
   * Ends a watched login, which never signed in, once the recipe's first step shows again,
   * as after a code or an approval expired (ADR 0027). Only the watched login's tab asks
   * and fills, as after a stopped login (owner, 2026-10-13). Only its own tab's page ends
   * it: until the watch ends, the site's other tabs that share its cookies wait (owner,
   * 2026-10-23). Returns a refusal when it could not, else undefined.
   */
  const abandonWatch = async (
    watchedLogin: LoginAttemptMetadata,
  ): Promise<Readiness | undefined> => {
    const { tabId } = watchedLogin.document;
    const watchedKey = recordKey(tabId, document.origin);
    const run = rt.attempts.get(tabId);
    const own = run?.metadata.id === watchedLogin.id ? run : undefined;
    if (own) rt.attempts.delete(tabId);
    if (rt.picked.get(tabId)?.attemptId === watchedLogin.id) rt.picked.delete(tabId);
    // The tab must keep asking after a restart, so its ask is stored first.
    rt.stoppedAsks.add(watchedKey);
    try {
      await saveSession(rt);
    } catch {
      rt.stoppedAsks.delete(watchedKey);
      return refuse("storage-unavailable");
    }
    reportAttempt(
      rt,
      transitionLoginAttempt(own?.metadata ?? watchedLogin, {
        type: "WATCH_ENDED",
        abandoned: true,
      }),
      own?.recipe,
    );
    try {
      await forget(rt, watchedKey);
    } catch {
      return refuse("storage-unavailable");
    }
    // A page of that tab admitted meanwhile may have resumed the record; it stops too.
    if (rt.attempts.get(tabId)?.metadata.id === watchedLogin.id) rt.attempts.delete(tabId);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    return undefined;
  };
  // A watch that ran out ends the login where it stopped (ADR 0027). Its record keeps its
  // time, so it does not hold the site again.
  // The page a watch that ran out began in; another page that shows the first step then
  // asks as after a stopped login (below).
  let watchEnded: string | undefined;
  if (recorded && watchOver(recorded, Date.now())) {
    watchEnded = recorded.watch?.documentId;
    const run = rt.attempts.get(document.tabId);
    const own = run?.metadata.id === recorded.id ? run : undefined;
    // It ended when the watch ran out, which may be long before this page showed; the
    // time between counts for nothing (ADR 0019).
    const endedAt = Math.min(Date.now(), (recorded.watch?.since ?? 0) + WATCH_MS);
    const ended = transitionLoginAttempt(
      own?.metadata ?? recorded,
      { type: "WATCH_ENDED" },
      endedAt,
    );
    if (own) own.metadata = ended;
    reportAttempt(rt, ended, own?.recipe, undefined, { endedAt });
    try {
      await keep(rt, ended, false);
    } catch {
      return refuse("storage-unavailable");
    }
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    recorded = ended;
  }
  // While a login is watched, its recipe's first step showing in a new page of the tab
  // means the person is back at the start, as when a code or an approval expired: the
  // login never signed in. It ends, and only this tab asks and fills without pressing
  // anything (ADR 0027). The page the watch began in never ends it.
  if (
    recorded?.watch &&
    document.frameId === 0 &&
    start?.path === live.path &&
    document.documentId !== recorded.watch.documentId
  ) {
    const refused = await abandonWatch(recorded);
    if (refused) return refused;
    recorded = undefined;
  }
  // A paused site's automatic login that has not ended stops on its next page before any
  // step, as when its pause started (ADR 0062); one a popup pick started goes on.
  if (
    paused &&
    recorded &&
    !terminal(recorded) &&
    recorded.watch === undefined &&
    rt.picked.get(document.tabId)?.attemptId !== recorded.id
  ) {
    const run = rt.attempts.get(document.tabId);
    const own = run?.metadata.id === recorded.id ? run : undefined;
    const ended = transitionLoginAttempt(own?.metadata ?? recoverLoginAttempt(recorded), {
      type: "POLICY_CHANGED",
    });
    if (own) rt.attempts.delete(document.tabId);
    reportAttempt(rt, ended, own?.recipe, { cause: "paused" });
    try {
      await forget(rt, recordKey(document.tabId, recorded.account.origin));
    } catch {
      return refuse("storage-unavailable");
    }
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    recorded = undefined;
  }
  if (
    recorded &&
    finishedLogin(recorded) &&
    recorded.document.frameId === 0 &&
    document.frameId === 0
  ) {
    // Until the recipe's first step shows again, the page keeps watching for it. The page
    // a rejection was read in shows the sign-in form again with the failure, which may be
    // on another path, such as the one the form posted to: it asks at once.
    const rejectedHere =
      recorded.outcome === "credential-rejected" &&
      recorded.document.documentId === document.documentId;
    // A page generated as a verification while signed in is no logout either, even when
    // it announces a start from starts read before its recipe was generated again (ADR
    // 0035): the service keeps one recipe per path, so no sign-in recipe starts there.
    const confirm =
      rejectedHere || live.topUrl
        ? undefined
        : await confirmRecipeOn(rt, document.origin, live.path);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if ((start?.path !== live.path || confirm) && !rejectedHere) {
      const starts = await startsFor(rt, document.origin);
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      // Not a recipe's first step on its path, so the login stays (ADR 0021 D).
      const visit = confirm && confirmPage(rt, live, confirm);
      if (visit) notStarted("confirm-unsupported", visit);
      else notStarted("logged-in");
      return {
        ok: false,
        reason: "logged-in",
        starts,
        ...(visit ? { confirm: visit.first } : {}),
      };
    }
    // It shows again after a finished login, as after a logout. Only this tab's record
    // for this origin is released, and the page logs in again (ADR 0062).
    const refused = await releaseFinished(recorded);
    if (refused) return refused;
    recorded = undefined;
  }
  if (
    recorded &&
    stoppedByPateat(recorded) &&
    !finishedLogin(recorded) &&
    recorded.outcome !== "account-switched" &&
    recorded.submissions === 0 &&
    recorded.document.documentId !== document.documentId
  ) {
    // A login Pateat itself stopped before submitting anything holds no tab, its own
    // included: a new page of the tab logs in as a new tab would, with the saved default
    // or by asking when several accounts match (ADR 0022). One that submitted is resumed,
    // so a site that sends the tab back to its first step never gets it again; only its
    // form showing on a later page makes the tab ask and fill (below).
    const released = recorded;
    if (rt.attempts.get(document.tabId)?.metadata.id === released.id)
      rt.attempts.delete(document.tabId);
    if (rt.picked.get(document.tabId)?.attemptId === released.id) {
      rt.picked.delete(document.tabId);
      void quietly(rt, () => saveSession(rt));
    }
    try {
      await forget(rt, askKey);
    } catch {
      return refuse("storage-unavailable");
    }
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    recorded = undefined;
  }
  if (
    recorded &&
    recorded.state === "blocked" &&
    !finishedLogin(recorded) &&
    recorded.outcome !== "account-switched" &&
    recorded.submissions > 0 &&
    recorded.document.frameId === 0 &&
    document.frameId === 0 &&
    // A page the watch already followed is this login's too, but not the one it began in.
    (recorded.document.documentId !== document.documentId ||
      (watchEnded !== undefined && watchEnded !== document.documentId)) &&
    // While it still holds the site against other tabs, it is resumed as before.
    !holdsSite(recorded, Date.now())
  ) {
    // A login that stopped after it submitted is resumed by the tab's later pages, so it
    // never submits again. Its form showing again on one of them asks for an account, in
    // this tab only, and fills without pressing anything (ADR 0021 D, owner's choice
    // 2026-10-12); until then the page watches for it.
    const confirm = live.topUrl ? undefined : await confirmRecipeOn(rt, document.origin, live.path);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // Nor does its recipe's first step show again once the recipe was withdrawn, as one
    // revoked on the dashboard: the tab is released as after it, so its pages may be sent
    // for generation again. A recipe that only dropped the login's layout still starts.
    const withdrawn =
      start?.path !== live.path &&
      !confirm &&
      !(probeMode && document.origin === rt.vars.origin) &&
      (await rt.recipes.withdrawn?.(document.origin, recorded.recipeId).catch(() => false));
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if ((start?.path !== live.path || confirm) && !withdrawn) {
      const starts = await startsFor(rt, document.origin);
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      const visit = confirm && confirmPage(rt, live, confirm);
      if (visit) notStarted("confirm-unsupported", visit);
      else notStarted("stopped-login");
      return {
        ok: false,
        reason: "login-stopped",
        starts,
        ...(visit ? { confirm: visit.first } : {}),
      };
    }
    const released = recorded;
    if (rt.attempts.get(document.tabId)?.metadata.id === released.id)
      rt.attempts.delete(document.tabId);
    if (rt.picked.get(document.tabId)?.attemptId === released.id) rt.picked.delete(document.tabId);
    rt.stoppedAsks.add(askKey);
    try {
      await saveSession(rt);
    } catch {
      rt.stoppedAsks.delete(askKey);
      return refuse("storage-unavailable");
    }
    try {
      await forget(rt, askKey);
    } catch {
      return refuse("storage-unavailable");
    }
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    recorded = undefined;
  }
  // The tab asks for an account after the site rejected its login or another tab's login
  // of the origin, which shares its session, or after its own login stopped (ADR 0021 D);
  // it may fill the page once then, pressing nothing (below).
  let ask = recorded ? undefined : askFor(rt, document.tabId, document.origin);
  // A tab runs one attempt at a time; another one still running holds it.
  const running = tabAttempt(rt, document.tabId);
  if (running && !terminal(running) && running.id !== recorded?.id) return refuse("tab-busy");
  // After an account switch, the tab's next document of that origin starts a new
  // attempt, which may use another recipe. It carries the switch, so it never clicks
  // another one.
  const switched = recorded?.state === "blocked" && recorded.outcome === "account-switched";
  const previous = switched ? undefined : recorded;
  // Look up the recipe first: a page without one never opens the policy catalog or vault.
  let recipe =
    probeMode && document.origin === rt.vars.origin
      ? previous
        ? probeRecipe(rt.vars.origin, `/${previous.recipeId.replace(/^demo-/, "")}`)
        : probeRecipe(rt.vars.origin, live.path)
      : await rt.recipes.recipe(document.origin, live.path, previous?.recipeId, previous?.layout);
  if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
  // A new login on a recipe with several layouts (ADR 0060) takes the one whose start
  // page elements show most, then one of the page's language, then the newest; the
  // others follow in that order, and the first whose plan passes for the account runs.
  // A resumed login keeps its own layout.
  let layoutChoices: LayoutChoice[] = [];
  let layoutCount = 1;
  if (
    recipe &&
    !previous &&
    start?.path === live.path &&
    !(probeMode && document.origin === rt.vars.origin) &&
    rt.recipes.layouts
  ) {
    const candidates = await rt.recipes.layouts(document.origin, live.path).catch(() => []);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if (candidates.length > 1) {
      layoutCount = candidates.length;
      const ranked = await rankedLayouts(
        rt,
        live,
        candidates,
        layoutStartTargets,
        layoutFirstSteps,
        "login",
      );
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      layoutChoices = ranked.map(({ recipe: layout }) => ({ recipe: layout }));
      recipe = layoutChoices[0]?.recipe ?? recipe;
    }
  }
  // A chooser recipe (ADR 0028): a new login on its list runs the route of its account
  // entry until it decides what to click, and a resumed one the route of its click.
  let chooser: LoginChooserRecipe | undefined;
  if (
    !recipe &&
    !(probeMode && document.origin === rt.vars.origin) &&
    (!previous || previous.chooser)
  ) {
    chooser = await Promise.resolve(
      rt.recipes.chooser?.(document.origin, live.path, previous?.recipeId, previous?.layout),
    ).catch(() => undefined);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // A new login on a chooser with several layouts takes the one whose list buttons
    // show most, then one of the page's language, then the newest (ADR 0060). Which
    // account the list holds is decided only once the layout is, so the account's plan
    // does not choose here.
    if (chooser && !previous && start?.path === live.path && rt.recipes.choosers) {
      const candidates = await rt.recipes.choosers(document.origin, live.path).catch(() => []);
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (candidates.length > 1) {
        layoutCount = candidates.length;
        // The list's buttons are its first step: a layout whose buttons all show fits.
        const buttons = (candidate: LoginChooserRecipe) => listReadiness(rt, candidate).targets;
        const ranked = await rankedLayouts(
          rt,
          live,
          candidates,
          buttons,
          (candidate) => [buttons(candidate)],
          "accounts",
        );
        if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        chooser = ranked[0]?.recipe ?? chooser;
      }
    }
    if (chooser) recipe = chooserRoute(chooser, previous?.chooser?.click ?? "entry");
  }
  // The chooser's path shows its `other` branch's form instead of the list, as after the
  // person pressed the button for another account there: a new login starts on that
  // branch and clicks nothing on the list (ADR 0028). While the list shows, it goes first.
  let shownOther = false;
  const shownRoute = chooser && chooserRoute(chooser, "other-shown");
  const shownStart = shownRoute && loginReadiness(shownRoute.steps[0]!);
  if (chooser && shownStart?.targets.length && !previous && start?.path === live.path) {
    const shows =
      (await showsNow(rt, live, shownStart)) &&
      !(await showsNow(rt, live, listReadiness(rt, chooser)));
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if (shows) {
      recipe = shownRoute;
      shownOther = true;
    }
  }
  // A page that shows a later `fill` step of a recipe and none of the recipe's first
  // steps, as a password page shown again after a logout for an account the site
  // remembers, starts a new login at that step (ADR 0049, owner 2026-10-18). A first step
  // that shows goes first, another recipe's too; a chooser's branches never start there.
  let later: LaterStart | undefined;
  if (
    !previous &&
    !chooser &&
    start?.path === live.path &&
    !(probeMode && document.origin === rt.vars.origin) &&
    rt.recipes.later
  ) {
    const candidates = await rt.recipes.later(document.origin, live.path).catch(() => []);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if (candidates.length) {
      // The start page's passkey button may stay beside a later step, as on a page that
      // shows it at each stage: only a `password` variant's first step goes first, and the
      // button is offered to the account as on the first page (ADR 0027).
      let firstShows = false;
      // Any layout the start page ranked best counts (ADR 0060), not only the first.
      const layoutsHere = [
        ...(recipe ? [recipe] : []),
        ...layoutChoices.slice(1).map((choice) => choice.recipe),
      ];
      /* eslint-disable no-await-in-loop */
      for (const variant of layoutsHere.flatMap((layout) => passwordVariants(layout))) {
        firstShows = await showsNow(rt, live, loginReadiness(variant.steps[0]!));
        if (firstShows) break;
      }
      const showing: {
        recipe: LoginRecipe;
        variants: Map<number, number[]>;
        partial: Set<string>;
      }[] = [];
      if (!firstShows)
        for (const candidate of candidates) {
          // A page that shows one of the recipe's signed-in markers, those of any of its
          // layouts (ADR 0060), is signed in, as a single-page app asking for the password
          // again before a sensitive action: no login starts there.
          if (await showsAnyMarker(rt, live, candidate)) continue;
          const variants = new Map<number, number[]>();
          // A step that shows whole goes before the same step with its password alone.
          const whole = new Set<string>();
          const partial = new Set<string>();
          for (const entry of laterStartSteps(candidate)) {
            const { variant, index, step, partial: part } = entry;
            const at = `${variant}:${index}`;
            if (step.path !== live.path || whole.has(at)) continue;
            if (await showsNow(rt, live, laterReadiness(entry))) {
              if (part) partial.add(at);
              else whole.add(at);
              const indices = variants.get(variant) ?? [];
              if (!indices.includes(index)) variants.set(variant, [...indices, index]);
            }
          }
          if (variants.size) showing.push({ recipe: candidate, variants, partial });
        }
      /* eslint-enable no-await-in-loop */
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      const buttonShows = async (button: LoginRecipe | undefined) =>
        button?.passkey !== undefined &&
        button.passkey.path === live.path &&
        (await showsNow(rt, live, loginReadiness(routeSteps(button, { route: "passkey" })[0]!)));
      // Two recipes whose later steps show start neither, as two first steps do (ADR 0013).
      // Layouts of one recipe are told apart as at its start page (ADR 0060): by how many
      // of their later steps show, the page's language and age, then the account's plan.
      const shownRecipes = new Set(showing.map((entry) => entry.recipe.id));
      if (shownRecipes.size === 1) {
        let ranked = showing;
        if (showing.length > 1) {
          // Each layout's language and creation time, from the recipe's layouts.
          const group = await Promise.resolve(
            rt.recipes.layouts?.(document.origin, showing[0]!.recipe.steps[0]!.path),
          ).catch(() => undefined);
          const metaOf = (entry: LoginRecipe) =>
            group?.find((candidate) => candidate.recipe.layout === entry.layout);
          const laterCandidates = showing.map((entry) => {
            const meta = metaOf(entry.recipe);
            return {
              recipe: entry,
              ...(meta?.language ? { language: meta.language } : {}),
              createdAt: meta?.createdAt ?? 0,
            };
          });
          // Each shows later steps, whole or with their password alone, so only how many
          // show tells them apart.
          const laterShown = showing.map((entry) => ({
            starts: true,
            missing: 0,
            shown: [...entry.variants.values()].reduce((sum, steps) => sum + steps.length, 0),
          }));
          let order = rankLayouts(laterCandidates, laterShown);
          if (languageDecides(order))
            order = rankLayouts(
              laterCandidates,
              laterShown,
              await observedLanguage(rt, live, "login"),
            );
          ranked = order.map(({ recipe: entry }) => entry);
        }
        layoutCount = Math.max(layoutCount, showing.length);
        const choices: LayoutChoice[] = await Promise.all(
          ranked.map(async (entry) => ({
            recipe: entry.recipe,
            later: {
              variants: entry.variants,
              partial: entry.partial,
              button: await buttonShows(entry.recipe),
            },
          })),
        );
        layoutChoices = choices.length > 1 ? choices : [];
        recipe = choices[0]!.recipe;
        later = choices[0]!.later;
      } else if (showing.length > 1) recipe = undefined;
      else if (!firstShows && !(await buttonShows(recipe)))
        // No step that may start a login shows, as when the one that announced the page
        // went, or it shows beside a signed-in marker: the document tries again, up to
        // its limit (START_TRIES).
        return { ok: false, reason: "stale-document" };
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    }
  }
  // A new attempt starts only once the document reports a first step of its recipe ready:
  // any route's or variant's, or the path alone when one of them needs no element. Until
  // then it watches the first steps of every recipe for its origin; this reads no
  // settings, policy catalog or vault.
  if (
    !previous &&
    (!recipe ||
      (recipeStartSteps(recipe).every((step) => loginReadiness(step).targets.length) &&
        start?.path !== live.path))
  ) {
    const starts = await startsFor(rt, document.origin);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // A site's sign-in entry on this path is pressed once its checks pass (ADR 0031).
    const entryRecipe =
      recipe || document.frameId !== 0 || live.topUrl
        ? undefined
        : (await rt.recipes.entries(document.origin).catch(() => [])).find(
            (candidate) => candidate.entry.path === live.path,
          );
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if (entryRecipe) {
      live.state = "watching";
      delete live.reason;
      await publish(rt, live);
      void pressEntry(rt, live, entryRecipe).catch(() =>
        refuseEntry(rt, live, entryRecipe, "exception"),
      );
      return { ok: false, reason: "entry", starts };
    }
    // A recipe generated as `confirm` or `unclear` starts on this path: a verification
    // while signed in, which Pateat does not fill yet. The page is neither logged in to
    // nor sent for generation again, and the page only watches (ADR 0035).
    const confirm =
      recipe || document.frameId !== 0 || live.topUrl
        ? undefined
        : await confirmRecipeOn(rt, document.origin, live.path);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if (confirm) {
      const visit = confirmPage(rt, live, confirm);
      notStarted("confirm-unsupported", visit);
      live.state = "watching";
      delete live.reason;
      await publish(rt, live);
      return { ok: false, reason: "recipe-not-found", starts, confirm: visit.first };
    }
    // The chooser's path shows a sign-in form instead of its list, and the chooser has no
    // `other` branch yet, as after the person pressed its button for another account: the
    // page is sent as that branch's first page, as after Pateat's own click, and once
    // stored the form starts as `other-shown` (ADR 0028, owner 2026-10-17).
    const otherless =
      chooser?.chooser.other && !chooser.chooser.afterOther && !previous ? chooser : undefined;
    const otherOffer = otherless && (await offersOther(rt, live, otherless));
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // A passkey page carries the list and entry it would be announced with otherwise
    // (ADR 0053); only a plain sign-in page counts as such below.
    const plain = signIn?.passkey ? undefined : signIn;
    const otherShown = otherless && plain?.path === live.path ? otherless : undefined;
    // Logged only for a shown form: the list may still show on this path.
    if (
      otherShown &&
      (otherOffer === "sending" || otherOffer === "sent" || otherOffer === "not-connected")
    )
      skipGeneration(rt, live, otherOffer, "other");
    if (otherShown && otherOffer === true) {
      // Nor is the page right after a sign-in, nor one of a paused site (ADR 0062).
      if (paused) skipGeneration(rt, live, "paused", "other");
      else if (rt.afterSignIn.get(document.tabId) === document.documentId)
        skipGeneration(rt, live, "after-sign-in", "other");
      // Nor a page whose list shows meanwhile: the login clicks there (ADR 0028).
      else if (await showsNow(rt, live, listReadiness(rt, otherShown))) {
        if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        skipGeneration(rt, live, "list-shown", "other");
      } else {
        let missed: [GenerationMiss, (string | undefined)?] = ["vault-unavailable", "error"];
        const scope = await generationSlotsFor(rt, live, (...reason) => {
          missed = reason;
        }).catch(() => undefined);
        if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        if (scope) {
          live.state = "generating";
          delete live.reason;
          await publish(rt, live);
          void generateFor(rt, live, scope, undefined, otherShown);
          return { ok: false, reason: "generating" };
        }
        skipGeneration(rt, live, missed[0], "other", missed[1]);
      }
    }
    const availability = recipe ? undefined : await offersGeneration(rt, live);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    let offer = availability === true;
    // A paused site sends no page for generation (ADR 0062).
    if (offer && paused) {
      skipGeneration(rt, live, "paused");
      offer = false;
    }
    // Only a page that was sent is held, so the log says why it is not sent again.
    if (availability === "sending" || availability === "sent")
      skipGeneration(rt, live, availability);
    // Without the service no page is sent; logged at debug level, as every page is.
    if (availability === "not-connected") skipGeneration(rt, live, availability);
    const shownList = !plain && list?.path === live.path ? list : undefined;
    const listing = shownList && (shownList.names || !shownList.missed) ? shownList : undefined;
    // A page whose URL names another path of its site may be sent as a sign-in entry
    // once no sign-in input showed (ADR 0031); a list of accounts goes first.
    const entryPage =
      offer &&
      (namesReturnPath(new URL(live.url), sameSiteAs(live.url)) || (await switchingTab(rt, live)))
        ? true
        : undefined;
    const entryOffer = !plain && entryHello?.path === live.path;
    // A page with a passkey button is sent as a passkey-only page when a matching item
    // holds a discoverable passkey; otherwise the list or entry it also shows is handled
    // below as on a page without the button, logged as such (ADR 0053, owner 2026-10-19
    // 22:44 UTC). With a list or an entry to use instead, every matching item must hold
    // one: the recipe is shared, and an item without a passkey could not run it.
    if (offer && signIn?.passkey && signIn.path === live.path) {
      const fallback = listing !== undefined || entryOffer;
      // Nor is the page right after a sign-in sent as a passkey-only page.
      if (rt.afterSignIn.get(document.tabId) === document.documentId) {
        if (!fallback) {
          skipGeneration(rt, live, "after-sign-in");
          offer = false;
        }
      } else {
        let missed: [GenerationMiss, (string | undefined)?] = ["vault-unavailable", "error"];
        const scope = await generationSlotsFor(
          rt,
          live,
          (...reason) => {
            missed = reason;
          },
          fallback ? "every" : "some",
        ).catch(() => undefined);
        if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        if (scope) {
          live.state = "generating";
          delete live.reason;
          await publish(rt, live);
          void generateFor(rt, live, scope, undefined, undefined, true);
          return { ok: false, reason: "generating" };
        }
        if (!fallback) {
          skipGeneration(rt, live, missed[0], undefined, missed[1]);
          offer = false;
        }
      }
    }
    // A shown email address that is no list entry is logged only (ADR 0028).
    if (offer && shownList?.missed)
      skipGeneration(rt, live, "not-a-list", undefined, shownList.missed);
    // A list announced only for the log is never sent, but may hold the site's entry.
    if (shownList && !listing && !entryOffer) offer = false;
    // The page right after a sign-in is never sent as a list of accounts (ADR 0028) or as
    // a sign-in entry.
    if (offer && listing && rt.afterSignIn.get(document.tabId) === document.documentId) {
      // Logged for a list with an email, one with a control for another account, or an
      // offered entry only: short texts alone are ordinary browsing.
      if (!listing.names || listing.other || entryOffer) skipGeneration(rt, live, "after-sign-in");
      offer = false;
    }
    // Nor while another tab's login of the origin authenticated within the hour, as on a
    // signed-in dashboard listing the site's accounts by email opened in a new tab, unless
    // the tab asks for an account (ADR 0028, owner 2026-10-17).
    if (offer && listing && !ask && signedInElsewhere(rt, document.tabId, document.origin)) {
      if (!listing.names || listing.other || entryOffer)
        skipGeneration(rt, live, "signed-in-elsewhere");
      offer = false;
    }
    // Nor as a page that asks for an identifier alone (ADR 0016), such as a profile page
    // with an email field.
    if (offer && signIn?.identifier && rt.afterSignIn.get(document.tabId) === document.documentId) {
      skipGeneration(rt, live, "after-sign-in");
      offer = false;
    }
    if (offer && (plain?.path === live.path || listing)) {
      let missed: [GenerationMiss, (string | undefined)?] = ["vault-unavailable", "error"];
      const scope = await generationSlotsFor(rt, live, (...reason) => {
        missed = reason;
      }).catch(() => undefined);
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      // Without an email listed, a shown text must name a matching item's username. A
      // list on a page whose path holds one is not sent: the page would be refused as
      // `username-shown` once read (owner 2026-10-12 19:45 UTC).
      const listed =
        scope && listing
          ? await listedNames(rt, live.document.origin, scope, listing.names ?? [], rawPath(live))
          : undefined;
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      const names = listing?.names ? listed?.names : undefined;
      // Or the page shows a control to sign in with another account (ADR 0028, owner
      // 2026-10-12 19:11 UTC), as Instagram's list of a profile whose username is not the
      // item's: then every shown text is hidden from the page sent, as a possible account
      // name, and the login continues through that control.
      const otherOnly =
        !names?.length && listing?.names && listing.other ? listing.names : undefined;
      // A list by email lists no account a matching item's username that is not an email
      // can be chosen by: it is sent only for its control for another account.
      const unmatched = listing && !listing.names && !listing.other && listed?.email === false;
      if (
        scope &&
        !listed?.inPath &&
        !unmatched &&
        (!listing?.names || names?.length || otherOnly)
      ) {
        live.state = "generating";
        delete live.reason;
        await publish(rt, live);
        void generateFor(
          rt,
          live,
          scope,
          listing ? { names: otherOnly ?? names ?? [] } : undefined,
        );
        return { ok: false, reason: "generating" };
      }
      // No vault item matches this page, the vault could not tell, or no shown text names
      // an item's username, so it is not sent. A page offered only by its short texts is
      // mostly ordinary browsing, so that is logged at debug level (ADR 0019): most pages
      // show a short text beside a button. Such a page may still hold the site's sign-in
      // entry.
      if (listed?.inPath)
        skipGeneration(rt, live, "no-listed-account", undefined, "username-in-path");
      else if (unmatched)
        skipGeneration(rt, live, "no-listed-account", undefined, "no-email-username");
      else if (!listing?.names) skipGeneration(rt, live, missed[0], undefined, missed[1]);
      else
        skipGeneration(
          rt,
          live,
          "no-listed-account",
          undefined,
          scope
            ? (listing.otherMiss ?? "no-name-match")
            : logCode(missed.filter(Boolean).join(":")),
        );
      // A page whose path holds a username is not sent as a sign-in entry either.
      if (listed?.inPath || !(listing?.names && entryOffer)) offer = false;
    }
    if (offer && entryOffer) {
      const offered = entryPage
        ? await entryOfferRefusal(rt, live)
        : { refusal: "no-return-target" };
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if ("matched" in offered) {
        live.state = "generating";
        delete live.reason;
        await publish(rt, live);
        void generateEntryFor(rt, live, offered.matched);
        return { ok: false, reason: "generating" };
      }
      skipGeneration(rt, live, offered.refusal, "entry");
      offer = false;
    }
    // A page offered for generation that showed nothing to send by the end of the step
    // wait is logged with why; mostly ordinary browsing, so at debug level (ADR 0019).
    // The tab's next document after a submitted password form is known only here. A page
    // that looks like a verification but is never sent, a secret answer of `type="text"` or
    // a frame, is counted by reason at info level when a vault item matches it, as it
    // would for a page that is sent (ADR 0035).
    // A secret answer on the tab's next document after a password submit is part of that
    // sign-in, so it is not counted.
    const framed = availability === "frame";
    const afterSubmit = rt.afterSignIn.get(document.tabId) === document.documentId;
    const unsendable =
      unoffered?.path === live.path &&
      ((offer && unoffered.why === "text-answer" && !afterSubmit) ||
        (framed && unoffered.why === "frame"))
        ? unoffered.why
        : undefined;
    let counted = false;
    if (unsendable) {
      counted = (await generationSlotsFor(rt, live).catch(() => undefined)) !== undefined;
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      if (counted) skipGeneration(rt, live, unsendable);
    }
    if (!counted && offer && unoffered?.path === live.path && !signIn && !shownList && !entryOffer)
      skipGeneration(
        rt,
        live,
        "nothing-offered",
        undefined,
        (unoffered.why === "no-list" || unoffered.why === "text-answer") && afterSubmit
          ? "after-sign-in"
          : unoffered.why,
      );
    // No recipe of the origin and no login in the tab: ordinary browsing (ADR 0019).
    if (!recipe && !starts.length && !offer) {
      const refused = await refuse("recipe-not-found", undefined, true);
      return framed ? { ...refused, frame: true as const } : refused;
    }
    // Only an origin with a recipe: elsewhere every sign-in page would be logged.
    if (starts.length) notStarted(recipe ? "first-step-missing" : "no-recipe-on-path");
    // A generated recipe's own start page that misses its first steps may be stale
    // (ADR 0041).
    if (
      recipe &&
      !chooser &&
      !later &&
      !(probeMode && live.document.origin === rt.vars.origin) &&
      shown?.path === live.path
    )
      void repairStale(rt, live, recipe, shown.miss, shown.accounts).catch(() => undefined);
    live.state = "watching";
    delete live.reason;
    await publish(rt, live);
    return {
      ok: false,
      reason: recipe ? "form-not-ready" : "recipe-not-found",
      starts,
      ...(offer || (otherOffer === true && !paused) ? { generate: true as const } : {}),
      ...(offer && entryPage ? { entry: true as const } : {}),
      ...(framed ? { frame: true as const } : {}),
    };
  }
  // A resumed attempt keeps its own recipe revision; a replaced or different recipe never
  // takes it over. A newer revision that only adds handlers or markers is taken over
  // when this worker still holds the recorded one to compare (ADR 0027); after a restart
  // only the recorded revision resumes.
  let revised = false;
  let replaced = false;
  if (
    previous &&
    recipe &&
    previous.recipeId === recipe.id &&
    previous.recipeRevision !== recipe.revision
  ) {
    const known = rt.attempts.get(document.tabId);
    const held =
      known?.metadata.id === previous.id &&
      known.recipe.id === previous.recipeId &&
      known.recipe.revision === previous.recipeRevision
        ? known.recipe
        : undefined;
    // A cache that lags behind the attempt keeps the attempt's own recipe.
    if (held && recipe.revision < held.revision) recipe = held;
    else if (held && extendsRecipe(held, recipe)) revised = true;
    // A revision that continues the recipe after its final advance is taken over on the
    // page, after the same checks as an answer to the continuation (ADR 0018); until then
    // the attempt keeps its own revision.
    else if (
      held &&
      previous.operationEffect === "advance" &&
      previous.stepIndex + 1 === previous.stepCount &&
      continuesRecipe(held, recipe)
    )
      recipe = held;
    else {
      recipe = undefined;
      replaced = true;
    }
  }
  if (
    !recipe ||
    recipe.origin !== document.origin ||
    (previous && previous.recipeId !== recipe.id)
  ) {
    // A resumed login its recipe no longer runs ends here: a revision replaced its own, or
    // after a restart is one this worker cannot compare, or the recipe or its layout was
    // withdrawn. Left running, every later page of the tab would resume it and be refused,
    // the recipe's first step included, until the tab closed. It moves to this page and
    // stops as under other settings, so it never submits again; the rules for a stopped
    // login apply from the tab's next page on (ADR 0021 D, ADR 0022). A lookup that could
    // not read the recipes leaves it to resume (owner, 2026-10-23).
    const ends =
      previous &&
      !(probeMode && document.origin === rt.vars.origin) &&
      (replaced ||
        // A chooser login's chooser no longer has the route of its click: a revision
        // dropped it, as the one the login ran had it.
        (previous.chooser !== undefined && chooser !== undefined && !recipe) ||
        (!recipe &&
          (await rt.recipes
            .withdrawn?.(document.origin, previous.recipeId, previous.layout)
            .catch(() => false))));
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    const latest = ends ? recordFor(rt, document.tabId, document.origin) : undefined;
    if (latest && latest.id === previous?.id && !terminal(latest)) {
      const run = rt.attempts.get(document.tabId);
      const own = run?.metadata.id === latest.id ? run : undefined;
      let ended = transitionLoginAttempt(own?.metadata ?? recoverLoginAttempt(latest), {
        type: "NAVIGATED",
        document,
      });
      if (!terminal(ended)) ended = transitionLoginAttempt(ended, { type: "POLICY_CHANGED" });
      if (own) own.metadata = ended;
      rt.continuations.delete(ended.id);
      reportAttempt(rt, ended, own?.recipe, { cause: "recipe-changed" });
      try {
        await keep(rt, ended);
      } catch {
        return refuse("storage-unavailable");
      }
      // A conditional request of the page waits for how this login ends (ADR 0034).
      reviewRequests(rt);
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    }
    return refuse("recipe-not-found");
  }
  const savedBefore = rt.vars.remembered;
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!snapshot.ok) return refuse(snapshot.error.code);
  if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
  // A close/navigation can happen while settings storage was awaited.
  try {
    const tab = await browser.tabs.get(document.tabId);
    if (
      !tab.url ||
      rt.documents.get(key) !== live ||
      (live.topUrl
        ? new URL(tab.url).origin !== new URL(live.topUrl).origin
        : new URL(tab.url).origin !== document.origin ||
          observedPath(new URL(tab.url).pathname) !== live.path)
    )
      return refuse("stale-document");
  } catch {
    return refuse("closed-tab");
  }
  // Two automatic logins of the site that ended `authenticated` within 10 minutes, in
  // any tab of this normal or incognito session, keep a third from starting: the tab asks
  // instead, so a site that logs out again at once is not logged in over and over. A pick
  // in the popup still logs in, and is not counted (ADR 0062).
  if (!ask && !previous && !switched && reloginLimited(rt, document.origin, incognito === true))
    ask = "relogin-limit";
  // A pick that did not make its account the default makes the site ask every time until
  // the browser closes or a default is saved for it (ADR 0063).
  const everyTime =
    !previous &&
    !switched &&
    (await asksEveryTime(rt, document.origin, incognito === true, snapshot));
  if (!ask && everyTime) ask = "one-time-pick";
  if (ask && heldElsewhere(rt, document.tabId, document.origin)) {
    showHeld(rt, document.tabId);
    return refuse("origin-busy");
  }
  const asking = ask === "relogin-limit" ? ask : ask ? "account-asked" : undefined;
  // A new login reads its item's facts once and chooses its route from them (ADR 0027);
  // a resumed one keeps those in its record, so a sync cannot change its route.
  // While the tab asks after a rejection, a stopped login or an abandoned watch, a
  // document is filled once on each path with the single account to use, without
  // pressing anything (ADR 0021 D); the passkey route has nothing to fill, and the relogin
  // limit fills nothing (ADR 0062). A single-page app that shows its next step in place,
  // as a password page after its email page, gets that step filled as a new document
  // would (ADR 0049). A page the site rejected a login on is never filled again, on any
  // path. A site that asks every time after a one-time pick fills nothing, also while
  // the tab asks for another reason (ADR 0063).
  const filledKey = `${documentKey(document)} ${live.path}`;
  const fill =
    asking === "account-asked" &&
    !everyTime &&
    !previous &&
    !switched &&
    !rt.askFills.has(documentKey(document)) &&
    !rt.askFills.has(filledKey);
  // A new login answers the page's own passkey request when its item holds a passkey
  // (ADR 0034), as one picked in the popup and one on a chooser's list do, instead of
  // clicking there; a login that only fills keeps its form.
  const pageRequest = !previous && document.frameId === 0 && parkedFor(rt, document) !== undefined;
  // A paused site starts no login by itself; a resumed one goes on (ADR 0062).
  const pausedStart = paused && !previous;
  const planOf = async (
    route: LoginRecipe,
    from: typeof later,
  ): Promise<Awaited<ReturnType<typeof planFor>> | undefined> => {
    let planned = await planFor(rt, snapshot, live, route, {
      ...(asking ? { asking } : {}),
      ...(fill ? { fill } : {}),
      ...(pausedStart ? { paused: true } : {}),
      ...(previous ? { route: attemptRouteChoice(previous) } : {}),
      ...(pageRequest ? { pageRequest } : {}),
      ...(from && !from.button ? { later: true } : {}),
    });
    if (rt.documents.get(key) !== live) return undefined;
    if (planned.ok && "fillOnly" in planned && planned.route.route !== "password") {
      planned = await planFor(rt, snapshot, live, route, {
        ...(asking ? { asking } : {}),
        ...(pausedStart ? { paused: true } : {}),
        ...(from && !from.button ? { later: true } : {}),
      });
      if (rt.documents.get(key) !== live) return undefined;
    }
    return planned;
  };
  let plan = await planOf(recipe, later);
  if (!plan) return { ok: false, reason: "stale-document" };
  // Another layout of the recipe, next in order, runs when the account's plan passes on
  // it and not on the first (ADR 0060); when none passes, the first one's refusal stands.
  /* eslint-disable no-await-in-loop */
  for (const choice of layoutChoices.slice(1)) {
    if (plan.ok) break;
    const next = await planOf(choice.recipe, choice.later);
    if (!next) return { ok: false, reason: "stale-document" };
    if (next.ok) {
      plan = next;
      recipe = choice.recipe;
      later = choice.later;
    }
  }
  /* eslint-enable no-await-in-loop */
  // A passkey-only item on a list whose account branch cannot take the stop (ADR 0036,
  // owner 2026-10-13 06:32 UTC: the account's row, else "another account") still reads
  // the list first, planned on the click alone: it goes on only through `other`, and is
  // refused with the account branch's reason, pressing nothing, when its row fits.
  let deferred: { route: LoginRecipe; detail?: string } | undefined;
  if (!plan.ok && plan.reason === "no-route" && !previous && chooser && !shownOther) {
    const { afterAccount: _afterAccount, ...lists } = chooser.chooser;
    const bare = chooserRoute({ ...chooser, chooser: lists }, "entry");
    const alone =
      bare &&
      (await planFor(rt, snapshot, live, bare, {
        ...(asking ? { asking } : {}),
        ...(fill ? { fill } : {}),
        ...(pageRequest ? { pageRequest } : {}),
        ...(pausedStart ? { paused: true } : {}),
      }));
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if (bare && alone && alone.ok && "stopAt" in alone && !("fillOnly" in alone)) {
      deferred = {
        route: bare,
        ...("detail" in plan && typeof plan.detail === "string" ? { detail: plan.detail } : {}),
      };
      plan = alone;
    }
  }
  // A generated recipe the chosen item cannot run, where it holds what a route the recipe
  // lacks needs, has its start page sent for repair in this visit (ADR 0058 A, amended by
  // ADR 0041): only for a new login of the tab's own page that starts at the recipe's first
  // step, neither while the tab asks nor after an account switch, nor on a chooser's
  // list, and while no login of the recipe runs or is watched in any tab. Until the answer
  // the page waits as for a generation; a page the repair did not answer with a recipe is
  // refused as it would have been.
  const unfit =
    !plan.ok && "unfit" in plan && (plan.unfit === "passkey" || plan.unfit === "password")
      ? plan.unfit
      : undefined;
  // Such a recipe still answers the page's own passkey request, which may come only after
  // this start (ADR 0034 amendment of 2026-10-25).
  const awaitsRequest =
    unfit === "passkey" &&
    !pageRequest &&
    !previous &&
    !switched &&
    !ask &&
    !pausedStart &&
    document.frameId === 0 &&
    !live.topUrl &&
    passkeyAnswersRequest(recipe);
  if (
    !plan.ok &&
    unfit &&
    !previous &&
    !switched &&
    !ask &&
    !chooser &&
    !shownOther &&
    !deferred &&
    !later &&
    !pausedStart &&
    document.frameId === 0 &&
    !live.topUrl &&
    !(probeMode && document.origin === rt.vars.origin) &&
    isGeneratedRecipeId(recipe.id) &&
    rt.generation?.claimRepair &&
    rt.repairs &&
    !recipeInUse(rt, recipe.id)
  ) {
    // A pause that started meanwhile admits the document again (ADR 0062).
    if ((await pauseOf(rt, live)) !== undefined) return { ok: false, reason: CHOICE_SAVED };
    if (awaitsRequest) {
      live.awaitsPageRequest = true;
      live.repairing = true;
    }
    live.state = "generating";
    delete live.reason;
    await publish(rt, live);
    void repairUnfit(rt, live, recipe, {
      reason: plan.reason,
      ...("detail" in plan && typeof plan.detail === "string" ? { detail: plan.detail } : {}),
      route: unfit,
    })
      .catch(() => undefined)
      .finally(() => {
        // A request that waited for it is decided again, also when the repair failed.
        delete live.repairing;
        reviewRequests(rt);
      });
    return { ok: false, reason: "generating" };
  }
  if (!plan.ok) {
    // An account the page's value picked for a login that did not start is dropped, so
    // a default saved or a logout later decides this document again.
    const site = rt.picked.get(document.tabId);
    if (site?.site && site.attemptId === undefined && site.documentId === document.documentId) {
      rt.picked.delete(document.tabId);
      void quietly(rt, () => saveSession(rt));
    }
    // Only a fresh start can be restarted with a picked account (ADR 0021). The page
    // after an account switch belongs to that login, so it offers none.
    if (!previous && !switched && "candidates" in plan && plan.candidates) {
      const asked = "ask" in plan && plan.ask === true ? ask : undefined;
      const pausedChoice = "paused" in plan && plan.paused === true;
      offerChoice(rt, document, plan.candidates, asked, pausedChoice);
      // Outside an ask, the page's own conditional request may wait for the pick, on a
      // recipe without a passkey button (ADR 0034); a paused site hands it on (ADR 0062).
      noteChoice(
        rt,
        document,
        plan.candidates,
        !asked && !pausedChoice && document.frameId === 0 && passkeyAnswersRequest(recipe),
      );
    }
    const refused = await refuse(
      plan.reason,
      "detail" in plan && typeof plan.detail === "string"
        ? plan.detail
        : plan.reason === "account-asked"
          ? // Why the tab asks: its own rejection or stopped login, or another tab's
            // rejection (ADR 0021 D).
            ask
          : // No vault item matches the page, which a vault sync may change.
            "noUriMatch" in plan && plan.noUriMatch
            ? "no-uri-match"
            : undefined,
      undefined,
      "candidates" in plan && plan.candidates ? plan.candidates.length : undefined,
    );
    // Asked while the page still holds vault replacement off, so a check started by
    // this page's announcement cannot apply before the miss is registered.
    if (!previous && !switched && "noUriMatch" in plan && plan.noUriMatch)
      retryAfterSync(rt, live, plan.reason);
    if (awaitsRequest && rt.documents.get(key) === live) {
      live.awaitsPageRequest = true;
      restartForRequest(rt, live);
    }
    return refused;
  }
  if (heldElsewhere(rt, document.tabId, document.origin)) {
    showHeld(rt, document.tabId);
    return refuse("origin-busy");
  }
  // A new login on a chooser's list decides what it clicks there for its account (ADR
  // 0028), and takes the route that click leads to. A fill-only login presses nothing.
  let click: ChooserClick | "none" | undefined = shownOther ? "other-shown" : undefined;
  let listMiss: ListMiss | undefined;
  if (!previous && chooser && !shownOther && !("fillOnly" in plan)) {
    const chosen = await listClick(rt, snapshot, live, chooser, plan.account);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // Without the account's username nothing on the list can be compared with it.
    if (chosen === "unreadable") return refuse("field-unavailable", "list-username");
    // The page no longer shows the list, or could not be asked: it announces again.
    if (!chosen) return { ok: false, reason: "stale-document" };
    if (typeof chosen === "string") click = chosen;
    else {
      click = "none";
      listMiss = chosen;
      // A button the chooser names that the list no longer shows, as on a list redesigned
      // or in another language, sends the list for repair while this login goes on
      // (ADR 0041 section 6).
      if (chosen.other === "missing" || chosen.continue === "missing")
        void repairChooser(rt, live, chooser).catch(() => undefined);
    }
    // The account's row or its button leads to the branch that cannot take the stop.
    if (deferred && (click === "entry" || click === "continue"))
      return refuse("no-route", deferred.detail);
    // Nothing fits and there is no button: the login ends on the click alone's route.
    if (deferred && click === "none") recipe = deferred.route;
    if (click === "other" || click === "continue") {
      const route = chooserRoute(chooser, click);
      if (!route) return refuse("recipe-not-found");
      // Another branch's route has other slots, and is planned again for the same account.
      if (click === "other") {
        const replanned = await planFor(rt, snapshot, live, route, {
          ...(asking ? { asking } : {}),
          ...(pageRequest ? { pageRequest } : {}),
          ...(pausedStart ? { paused: true } : {}),
        });
        if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
        // An item without a password goes on only when that branch can take its stop
        // (ADR 0036); the log names why not, as for the list's own route.
        if (!replanned.ok)
          return refuse(
            replanned.reason,
            "detail" in replanned && typeof replanned.detail === "string"
              ? replanned.detail
              : undefined,
          );
        // The click was chosen for the planned account; another one is not logged in.
        if (
          replanned.account.connectionId !== plan.account.connectionId ||
          replanned.account.itemId !== plan.account.itemId
        )
          return refuse("account-changed", "list-other");
        plan = replanned;
      }
      recipe = route;
    }
  }
  // The vault account whose master password this new login was started with, if any.
  let typedFor: string | undefined;
  if (!previous) {
    // The lookup answered from the cache while the sync it started may be revoking the
    // recipe, as one removed on the dashboard minutes ago: that sync ends first, and a
    // recipe or layout it removed never starts.
    if (
      !(probeMode && document.origin === rt.vars.origin) &&
      (await rt.recipes.withdrawn?.(document.origin, recipe.id, recipe.layout).catch(() => false))
    ) {
      if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
      return refuse("recipe-not-found", "withdrawn");
    }
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    // Another login's account choice, being saved now or saved since this snapshot was read,
    // bumps the revision this new login would be checked against: it is admitted again.
    await choicesSaved(rt);
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    if (rt.savingChoices.size || rt.vars.remembered !== savedBefore)
      return { ok: false, reason: CHOICE_SAVED };
    if (heldElsewhere(rt, document.tabId, document.origin)) {
      showHeld(rt, document.tabId);
      return refuse("origin-busy");
    }
    // An item with Bitwarden's re-prompt starts a login on a site that honours it only
    // after its master password was typed for this document; until then the page is
    // neither filled nor pressed, and the chooser window asks (owner, 2026-10-23 12:46 UTC).
    // Its username may already have been read to match the page's accounts, as Bitwarden
    // shows usernames without asking.
    // The started login goes on across its pages, and answers the site's passkey request
    // with that item (ADR 0027), without asking again.
    const connection = snapshot.catalog.connections.find(
      (entry) => entry.id === plan.account.connectionId,
    );
    const item = connection?.items.find((entry) => entry.id === plan.account.itemId);
    if (connection && itemAsksForMasterPassword(snapshot.snapshot.settings, item, live.url)) {
      const grantKey = `${document.tabId} ${document.documentId}`;
      const grant = rt.repromptGrants.get(grantKey);
      if (
        grant?.connectionId === plan.account.connectionId &&
        grant.itemId === plan.account.itemId &&
        Date.now() - grant.at <= REPROMPT_GRANT_MS
      ) {
        rt.repromptGrants.delete(grantKey);
        typedFor = grant.connectionId;
        if (document.frameId === 0) rt.repromptWaiting.delete(document.tabId);
      } else {
        const awaiting = {
          document,
          account: {
            origin: document.origin,
            connectionId: plan.account.connectionId,
            itemId: plan.account.itemId,
          },
          ...(rt.picked.get(document.tabId)?.documentId === document.documentId
            ? { pick: { ...rt.picked.get(document.tabId)! } }
            : {}),
        };
        if (document.frameId === 0) rt.repromptWaiting.set(document.tabId, awaiting);
        void askMasterPassword(rt, awaiting, connection, item!);
        return refuse("master-password-reprompt");
      }
    }
  }
  // A pause that started while this announcement was handled stops what it would start
  // or go on with by itself: the document is admitted again and refused as paused. A
  // login a popup pick started goes on (ADR 0062).
  const picking = previous
    ? rt.picked.get(document.tabId)?.attemptId === previous.id
    : "chosen" in plan && (plan.chosen?.source === "pick" || plan.chosen?.source === "switch");
  if (!paused && !picking && (await pauseOf(rt, live)) !== undefined) {
    if (rt.documents.get(key) !== live) return { ok: false, reason: "stale-document" };
    return { ok: false, reason: CHOICE_SAVED };
  }
  if (!previous && rt.persisted.size >= 100) return refuse("attempt-limit");
  // Another document of the tab, such as a frame, may have started an attempt while this
  // one was checked, and the tab runs one attempt at a time. Nothing below awaits until
  // the attempt is registered.
  const latest = tabAttempt(rt, document.tabId);
  if (
    recordFor(rt, document.tabId, document.origin)?.id !== recorded?.id ||
    (latest && !terminal(latest) && latest.id !== recorded?.id)
  )
    return refuse("tab-busy");
  // A passkey Pateat returned to the tab's page, outside a login of it, signed that page
  // in: the site moves on by itself, so no login runs there by itself, as one would fill
  // and submit the password over the passkey's sign-in, also from a later step such as a
  // password page shown alone. Read here, after the admission's last wait, so an answer
  // returned while it waited counts too. A pick in the popup or an account switch still
  // logs in, and the page announces again when the answer's window ends, so a step the
  // site shows after the passkey, such as a one-time code, is filled then.
  if (!previous && !picking) {
    const answer = rt.passkeyAnswers.get(`${document.tabId} ${siteOrigin}`);
    const top =
      document.frameId === 0
        ? document.documentId
        : rt.documents.get(frameKey({ tabId: document.tabId, frameId: 0 }))?.document.documentId;
    if (
      answer?.signedIn !== undefined &&
      answer.signedIn === top &&
      Date.now() - answer.at < PASSKEY_SIGN_IN_MS
    ) {
      const refused = await refuse(PASSKEY_SIGNED_IN);
      retryAfterPasskey(rt, live, answer.at);
      return refused;
    }
  }
  let metadata: LoginAttemptMetadata;
  let resumedPolicy: PolicyChange | undefined;
  if (previous) {
    let resumed = recoverLoginAttempt(previous);
    // The page left the document a TOTP code was filled into before its click,
    // as a code input that submits on its last digit does: the page submitted the code
    // itself, and it is never filled again (ADR 0027).
    // So did a software keyboard's page once a key was pressed (ADR 0067).
    if (
      previous.document.documentId !== document.documentId &&
      codeAwaitsClick(recipe, resumed, rt.keypadPresses.get(resumed.id))
    )
      resumed = transitionLoginAttempt(resumed, autoSubmitted(recipe, resumed));
    metadata = transitionLoginAttempt(resumed, {
      type: "NAVIGATED",
      document,
    });
    // A new page ends a wait for the person's click, as their press led to it, and the
    // login waits for the site until it read that page (ADR 0019).
    if (!metadata.watch) metadata = followPage(personAnswered(metadata));
    if (revised)
      metadata = transitionLoginAttempt(metadata, {
        type: "REVISED",
        recipeRevision: recipe.revision,
      });
    if (metadata.policyRevision !== snapshot.snapshot.revision && !terminal(metadata)) {
      // A watched login keeps watching while the newer settings still plan its account
      // (ADR 0027).
      const kept =
        metadata.watch !== undefined &&
        snapshot.snapshot.revision > metadata.policyRevision &&
        plan.ok &&
        plan.account.connectionId === metadata.account.connectionId &&
        plan.account.itemId === metadata.account.itemId;
      metadata = transitionLoginAttempt(
        metadata,
        kept
          ? { type: "POLICY_REVISED", policyRevision: snapshot.snapshot.revision }
          : { type: "POLICY_CHANGED" },
      );
      if (!kept) resumedPolicy = { cause: "settings-revision" };
    }
  } else {
    // A new login's plan carries the facts it chose its route with.
    if (!("facts" in plan)) return refuse("no-route");
    // An account whose route is the passkey button that shows beside the later step
    // presses it, as on the first page (ADR 0027).
    if (later?.button && plan.route.route === "passkey") later = undefined;
    // A login that starts at a later step takes the first one that shows in the variant
    // its account fits, or a passkey answer that falls back to that variant (ADR 0049); an
    // item without a password goes no further than the step before its password.
    const startVariant =
      plan.route.route === "password"
        ? plan.route.variant
        : "fallback" in plan && typeof plan.fallback === "number"
          ? plan.fallback
          : undefined;
    const startAt =
      later && startVariant !== undefined ? later.variants.get(startVariant)?.[0] : undefined;
    if (later && startAt === undefined) return refuse("no-route", "later-variant");
    if (later && "stopAt" in plan && typeof plan.stopAt === "number" && plan.stopAt <= startAt!)
      return refuse("no-route", "password-empty:later-start");
    const timing = startTiming(rt, live, plan.account);
    metadata = transitionLoginAttempt(
      createAttemptMetadata({
        id: newId(),
        recipe,
        policyRevision: snapshot.snapshot.revision,
        account: {
          origin: document.origin,
          connectionId: plan.account.connectionId,
          itemId: plan.account.itemId,
        },
        choice: plan.route,
        ...("fallback" in plan ? { fallback: plan.fallback } : {}),
        facts: plan.facts,
        document,
        ...(document.frameId === 0 ? {} : { pageOrigin: siteOrigin }),
        accountSwitched: switched,
        fillOnly: "fillOnly" in plan,
        ...(chooser ? { chooser: click === undefined || click === "none" ? "entry" : click } : {}),
        // An item without a password stops before it (ADR 0036).
        ...("stopAt" in plan && typeof plan.stopAt === "number" ? { stopAt: plan.stopAt } : {}),
        ...(startAt === undefined ? {} : { startAt }),
        ...(startAt !== undefined && later?.partial.has(`${startVariant}:${startAt}`)
          ? { startPartial: true }
          : {}),
        timing,
      }),
      { type: "RESOLVE" },
    );
    rt.begunIn.delete(metadata.id);
    rt.begunIn.set(metadata.id, document.documentId);
    for (const old of rt.begunIn.keys()) {
      if (rt.begunIn.size <= 256) break;
      rt.begunIn.delete(old);
    }
    if (typedFor !== undefined) holdPassword(rt, metadata.id, typedFor);
    // No listed account fits, and the list has no button for another one (ADR 0028).
    if (click === "none") metadata = transitionLoginAttempt(metadata, { type: "NOT_LISTED" });
  }
  const run: Execution = {
    metadata,
    recipe,
    live,
    running: false,
    ...(chooser && metadata.chooser ? { chooser } : {}),
    // Each document re-derives the choice; every step still checks it is the attempt's account.
    ...(plan.choice &&
    !terminal(metadata) &&
    plan.account.connectionId === metadata.account.connectionId &&
    plan.account.itemId === metadata.account.itemId
      ? { choice: plan.choice }
      : {}),
    ...(ask && "asked" in plan ? { asked: { candidates: plan.asked, ask } } : {}),
  };
  // A new document after an advance on the same path, as a form posted back to its own
  // path, is checked against what the advancing document showed before it (ADR 0013).
  const before = rt.attempts.get(document.tabId);
  if (
    before?.inPlace &&
    before.metadata.id === metadata.id &&
    before.inPlace.operationId === metadata.operationId
  )
    run.inPlace = before.inPlace;
  if (
    before?.siblingsInPlace &&
    before.metadata.id === metadata.id &&
    before.siblingsInPlace.operationId === metadata.operationId
  )
    run.siblingsInPlace = before.siblingsInPlace;
  rt.attempts.set(document.tabId, run);
  reviewRequests(rt);
  if (!previous)
    report(rt, document, {
      type: "start",
      tabId: document.tabId,
      origin: document.origin,
      recipeId: metadata.recipeId,
      recipeRevision: metadata.recipeRevision,
      ...(metadata.layout === undefined ? {} : { layout: metadata.layout }),
      ...(layoutCount > 1 ? { layouts: layoutCount } : {}),
      route: metadata.route,
      ...(metadata.variant === undefined ? {} : { variant: metadata.variant }),
      ...("chosen" in plan && plan.chosen
        ? {
            account: plan.chosen.source,
            ...(plan.chosen.candidates === undefined ? {} : { candidates: plan.chosen.candidates }),
            ...(plan.chosen.source === "match" || plan.chosen.source === "site-value"
              ? { itemId: metadata.account.itemId }
              : {}),
          }
        : {}),
      ...(metadata.fillOnly ? { fillOnly: true as const } : {}),
      ...(metadata.startStep === undefined ? {} : { startStep: metadata.startStep }),
      ...(metadata.startPartial ? { startPartial: true as const } : {}),
      ...(click ? { click } : {}),
      ...(listMiss ? { listMiss } : {}),
    });
  // Each new document of the tab resumes the attempt; only a change is news.
  reportAttempt(
    rt,
    metadata,
    recipe,
    resumedPolicy,
    previous && metadata.state === previous.state && metadata.outcome === previous.outcome
      ? { repeat: true }
      : {},
  );
  // A page that resumes a login stopped after a submission while it still holds the site
  // (ADR 0022) does nothing, and says why once (ADR 0019).
  if (
    previous?.state === "blocked" &&
    metadata.state === "blocked" &&
    previous.submissions > 0 &&
    holdsSite(previous, Date.now())
  )
    note(rt, document, live.url, "not-started", "stopped-login");
  // The choice, pick and ask markers form one session update. Snapshot only once they
  // all name the started login, rather than relying on a deferred save callback.
  let sessionChanged = false;
  const pick = rt.picked.get(document.tabId);
  if (
    !previous &&
    pick?.connectionId === plan.account.connectionId &&
    pick.itemId === plan.account.itemId &&
    (pick.attemptId === undefined
      ? pick.documentId === document.documentId
      : // The login a pick started goes on past an account switch.
        switched && pick.attemptId === recorded?.id)
  ) {
    pick.attemptId = metadata.id;
    sessionChanged = true;
  }
  // The login an account switch's pick started ends that pick and the switch (ADR 0063).
  if (!previous && "chosen" in plan && plan.chosen?.source === "switch") {
    rt.switchStates.delete(document.tabId);
    void rt.accountPicks.endSwitch(document.tabId);
  }
  // A login started while the tab asks, as by a pick, ends the tab's asking for this
  // origin, and that of the origin's other tabs it began; filling the page only does not,
  // and the document is not filled again on this path.
  if (metadata.fillOnly) {
    addAskFill(rt, filledKey);
    sessionChanged = true;
  } else if (!previous) {
    const rejected = rt.rejectedAsks.delete(askKey);
    if (rt.stoppedAsks.delete(askKey) || rejected) sessionChanged = true;
  }
  // clearChoice saves the completed update before notifying a badge that may reenter.
  if (!rt.pending.has(document.tabId) && sessionChanged) void quietly(rt, () => saveSession(rt));
  clearChoice(rt, document.tabId);
  // A hold's tooltip no longer applies once the tab logs in.
  rt.badge.note(document.tabId, undefined);
  await save(rt, run);
  await publish(rt, live, metadata);
  void drive(rt, run);
  // A page of a watched login watches for the recipe's first step, which ends the
  // login (ADR 0027).
  if (metadata.watch && document.documentId !== metadata.watch.documentId) {
    const starts = await startsFor(rt, document.origin);
    if (rt.documents.get(key) === live) return { ok: true, starts };
  }
  return { ok: true };
}
