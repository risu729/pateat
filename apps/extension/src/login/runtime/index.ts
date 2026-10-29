import * as v from "valibot";
import { parseAttemptMetadata, recoverLoginAttempt, type LocalSettings } from "@pateat/contracts";
import { browser, type Browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";
import { configureSchema } from "../wire";
import { DEMO_PROBE_ACCOUNT } from "../dummy";
import { allowlistOf } from "../pause";
import { quietly } from "./session-store";
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
import { choiceBadge, recordKey, reloginKey } from "./steps";
import { armEntryTimer, asksEveryTime } from "./entry-press";
import { refusalKey } from "./detail-fill";
import { probeMode } from "./constants";
import { pausingSettings, showTabPause, pauseOf } from "./pause";
import {
  forgetTab,
  incognitoClosed,
  active,
  handle,
  settingsChanged,
  choiceDefaults,
  loginAccount,
} from "./messages";
import { saveSession } from "./attempt";
import { revive } from "./choice";
import { type Sender } from "./types";
import { reloginLimited } from "./relogin";
import {
  passkeyReverification,
  passkeyRequested,
  passkeyAnswered,
  conditionalRequest,
} from "./passkey";
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
