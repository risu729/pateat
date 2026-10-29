import {
  isPasskeyBrowserSite,
  type LoginAttemptMetadata,
  type LocalSettings,
} from "@pateat/contracts";
import { browser, type Browser } from "wxt/browser";
import { type PauseResponse, type StatusResponse } from "../choice-wire";
import {
  pauseSite,
  pausedInPrivate,
  pausingRule,
  type PauseLength,
  type PauseState,
} from "../pause";
import type { PausingSettings } from "../sites";
import { siteOf, logCode, frameKey, recordKey } from "./steps";
import { type Execution, type LiveDocument } from "./types";
import { current, send, change, publish, report } from "./attempt";
import { terminal } from "./attempt-state";
import { forget } from "./session-store";
import { pausedCandidates } from "./choice-save";
import { offerChoice, clearChoice } from "./choice";
import { note } from "./generation";
import { reviewRequests } from "./passkey";
import type { Runtime } from "./state";

/** A hostname whose passkey requests go to the browser, listed or just chosen (ADR 0007). */
export const listedBrowserSite = (rt: Runtime, saved: LocalSettings, origin: string) =>
  isPasskeyBrowserSite(saved, origin) || rt.options.pendingBrowserSite?.(origin) === true;

/**
 * When the pause the person set for a document's site ends, while it runs: a frame is
 * paused when its own site or its tab's is (ADR 0062). `unreadable` when the paused
 * sites cannot be read.
 */
export const pausedUntil = (
  rt: Runtime,
  live: {
    url: string;
    topUrl?: string | undefined;
    incognito?: boolean | undefined;
  },
): Promise<number | "unreadable" | undefined> =>
  rt.pauses.until([live.url, live.topUrl], live.incognito).catch(() => "unreadable" as const);

/**
 * What of the saved settings pauses automatic login, read as document admission reads
 * them, before any recipe or vault access; undefined when they cannot be read, or without
 * site admission.
 */
export const pausingSettings = (rt: Runtime) =>
  rt.sites?.pausing().catch(() => undefined) ?? Promise.resolve(undefined);

/**
 * What of `policy` pauses a document (ADR 0062): automatic login being off in private
 * windows, for a page of one, else an exclusion rule covering its site or its tab's, or
 * the allowed sites leaving one of them out (ADR 0077).
 */
export const settingsPause = (
  _rt: Runtime,
  policy: PausingSettings | undefined,
  live: { url: string; topUrl?: string | undefined; incognito?: boolean | undefined },
): PauseState | undefined => {
  if (!policy) return undefined;
  if (pausedInPrivate(policy, live.incognito)) return { private: true };
  const rules = [live.url, live.topUrl].map((page) =>
    page === undefined ? undefined : pausingRule(policy, page),
  );
  if (rules.includes("excluded")) return { rule: true };
  return rules.includes("not-allowed") ? { rule: true, notAllowed: true } : undefined;
};

/**
 * What pauses automatic login of a document, if anything (ADR 0062): automatic login
 * being off in private windows, or an exclusion rule of the settings covering its site or
 * its tab's, both until changed in the settings, else a pause of a chosen length. Settings
 * that cannot be read count as none; paused sites that cannot be read pause every site,
 * failing safe. `private: false` leaves out automatic login being off in private windows,
 * as for the person's own passkey requests there (ADR 0062 E).
 */
export const pauseOf = async (
  rt: Runtime,
  live: {
    url: string;
    topUrl?: string | undefined;
    incognito?: boolean | undefined;
  },
  kinds: { private?: false; policy?: PausingSettings } = {},
): Promise<PauseState | undefined> => {
  // Both are read at once, so the pause costs a request no more time than before.
  const [policy, until] = await Promise.all([
    kinds.policy ?? pausingSettings(rt),
    pausedUntil(rt, live),
  ]);
  const ruled = settingsPause(
    rt,
    policy && kinds.private === false ? { ...policy, loginInPrivateWindows: true } : policy,
    live,
  );
  if (ruled) return ruled;
  if (until === "unreadable") return { unreadable: true };
  return until === undefined ? undefined : { until };
};

/**
 * For the popup (ADR 0063): the account of the tab's latest login on the page's site that
 * signed in, and the tab's account switch.
 */
export function usedAndSwitch(
  rt: Runtime,
  tabId: number,
  pageOrigin: string,
): Pick<Extract<StatusResponse, { ok: true }>, "used" | "switch"> {
  const site = siteOf(pageOrigin);
  const run = rt.attempts.get(tabId)?.metadata;
  const signedIn = [
    ...rt.persisted.values().filter((entry) => entry.id !== run?.id),
    ...(run ? [run] : []),
  ]
    .filter(
      (entry) =>
        entry.document.tabId === tabId &&
        entry.state === "authenticated" &&
        site !== undefined &&
        siteOf(entry.account.origin) === site,
    )
    .sort((left, right) => (left.changedAt ?? 0) - (right.changedAt ?? 0))
    .at(-1);
  const switching = rt.switchStates.get(tabId);
  return {
    ...(signedIn
      ? {
          used: {
            connectionId: signedIn.account.connectionId,
            itemId: signedIn.account.itemId,
          },
        }
      : {}),
    ...(switching
      ? {
          switch: {
            state: switching.state,
            ...(switching.reason ? { reason: logCode(switching.reason) } : {}),
            connectionId: switching.connectionId,
            itemId: switching.itemId,
          },
        }
      : {}),
  };
}

/**
 * The open tabs whose page is on `url`'s registrable site, in the windows of that kind:
 * normal or incognito (ADR 0062).
 */
export async function siteTabs(
  _rt: Runtime,
  url: string,
  incognito: boolean,
): Promise<Browser.tabs.Tab[]> {
  const site = pauseSite(url);
  const tabs = await browser.tabs.query({}).catch(() => []);
  return tabs.filter(
    (tab) =>
      tab.id !== undefined &&
      (tab.incognito === true) === incognito &&
      tab.url !== undefined &&
      site !== undefined &&
      pauseSite(tab.url) === site,
  );
}

/** Shows the pause of the tab's page, or its end, on the tab's badge (ADR 0062). */
export async function showTabPause(rt: Runtime, tab: Browser.tabs.Tab): Promise<void> {
  if (tab.id === undefined || !tab.url || pauseSite(tab.url) === undefined) return;
  rt.badge.paused?.(tab.id, await pauseOf(rt, { url: tab.url, incognito: tab.incognito }));
}

/** Shows the pause of `url`'s site, or its end, on the badge of each of its tabs. */
export async function showPause(
  rt: Runtime,
  url: string,
  incognito: boolean,
): Promise<Browser.tabs.Tab[]> {
  const tabs = await siteTabs(rt, url, incognito);
  await Promise.all(tabs.map((tab: Browser.tabs.Tab) => showTabPause(rt, tab)));
  return tabs;
}

/**
 * The tabs that show the site of `url` in a window of that kind, also in a frame of
 * another site's page, or hold a choice of a document of the site (ADR 0062).
 */
export async function pausedTabs(
  rt: Runtime,
  url: string,
  incognito: boolean,
): Promise<Set<number>> {
  const site = pauseSite(url);
  const tabs = await browser.tabs.query({}).catch(() => []);
  const kindOf = new Map(tabs.map((tab) => [tab.id, tab.incognito === true]));
  const ids = new Set((await siteTabs(rt, url, incognito)).map((tab) => tab.id!));
  // Only the documents and choices of tabs of that window kind: the other kind keeps its
  // own pause. One whose kind is not known is left out.
  const ofKind = (tabId: number, known: boolean | undefined) =>
    (known ?? kindOf.get(tabId)) === incognito;
  for (const live of rt.documents.values())
    if (pauseSite(live.url) === site && ofKind(live.document.tabId, live.incognito))
      ids.add(live.document.tabId);
  for (const [tabId, waiting] of rt.pending)
    if (
      waiting.paused &&
      pauseSite(waiting.document.origin) === site &&
      ofKind(tabId, rt.documents.get(frameKey(waiting.document))?.incognito)
    )
      ids.add(tabId);
  return ids;
}

/**
 * Stops a running automatic login of a site whose pause just started, before its next
 * step, as a settings change does (outcome `policy-changed`, cause `paused`). Its record
 * is let go, so it holds nothing, and its document asks as a paused one (ADR 0062).
 */
export async function stopForPause(rt: Runtime, run: Execution): Promise<void> {
  if (!current(rt, run) || terminal(run.metadata)) return;
  void send(rt, run.live, { type: "login.cancel" }).catch(() => undefined);
  await change(rt, run, { type: "POLICY_CHANGED" }, { cause: "paused" }).catch(() => undefined);
  const { document } = run.live;
  if (rt.attempts.get(document.tabId) !== run || !terminal(run.metadata)) return;
  rt.attempts.delete(document.tabId);
  await forget(rt, recordKey(document.tabId, run.metadata.account.origin)).catch(() => undefined);
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  if (rt.documents.get(frameKey(document)) !== run.live) return;
  const candidates = snapshot?.ok
    ? await pausedCandidates(
        rt,
        snapshot,
        run.live,
        snapshot.snapshot.settings.siteDefaults.find((entry) => entry.origin === document.origin),
      ).catch(() => [])
    : [];
  if (rt.documents.get(frameKey(document)) !== run.live) return;
  if (candidates.length) offerChoice(rt, document, candidates, undefined, true);
  note(rt, document, run.live.url, "paused", undefined, undefined, candidates.length || undefined);
  run.live.state = "denied";
  run.live.reason = "paused";
  delete run.live.refusal;
  await publish(rt, run.live);
}

/**
 * Pauses automatic login of the tab's registrable site for `length`, in every tab of the
 * tab's window kind, or resumes it without one (ADR 0062). A pause stops the site's running automatic
 * logins and hands on its waiting conditional passkey requests at once. A resume ends the
 * site's paused choices, also once the pause ended by itself, and asks the site's tabs,
 * and frames of the site in other tabs, to announce again, so they log in at once.
 * Nothing goes to the service.
 */
/**
 * When the timed pause of the tab's site ends, for the popup's pause row (ADR 0062): read
 * from the tab's URL and window kind alone, as the row shows while the page section and
 * its status are hidden.
 */
export async function pauseStateFor(rt: Runtime, tabId: number): Promise<PauseResponse> {
  await rt.vars.sessionLoaded;
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  const url = tab?.url;
  if (!url || pauseSite(url) === undefined) return { ok: false, reason: "no-site" };
  const till = await pausedUntil(rt, { url, incognito: tab.incognito === true });
  if (till === "unreadable") return { ok: false, reason: "storage-unavailable" };
  return till === undefined ? { ok: true } : { ok: true, until: till };
}

export async function pauseFor(
  rt: Runtime,
  tabId: number,
  length: PauseLength | undefined,
): Promise<PauseResponse> {
  const paused = length !== undefined;
  await rt.vars.sessionLoaded;
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  const url = tab?.url;
  if (!url || pauseSite(url) === undefined) return { ok: false, reason: "no-site" };
  const incognito = tab.incognito === true;
  let until: number | undefined;
  let resumed = false;
  try {
    if (paused) until = await rt.pauses.pause(url, incognito, length);
    else resumed = await rt.pauses.resume(url, incognito);
  } catch {
    return { ok: false, reason: "storage-unavailable" };
  }
  if (paused || resumed)
    report(
      rt,
      { frameId: 0 },
      {
        type: "pause",
        tabId,
        origin: new URL(url).origin,
        action: paused ? "paused" : "resumed",
        ...(paused ? { length } : {}),
        ...(incognito ? { incognito: true as const } : {}),
      },
    );
  await showPause(rt, url, incognito);
  const ids = await pausedTabs(rt, url, incognito);
  if (paused) {
    // Waiting conditional requests of the site's pages go to the browser at once.
    for (const parked of [...rt.parkedRequests])
      if (ids.has(parked.tabId) && pauseSite(parked.origin) === pauseSite(url))
        parked.settle({ kind: "delegate", reason: "paused" });
    reviewRequests(rt);
    // Running automatic logins of the site stop; one a popup pick started goes on.
    const stopping: Promise<void>[] = [];
    for (const run of rt.attempts.values())
      if (
        !terminal(run.metadata) &&
        run.metadata.watch === undefined &&
        rt.picked.get(run.live.document.tabId)?.attemptId !== run.metadata.id &&
        (run.live.incognito ?? incognito) === incognito &&
        [run.live.url, run.live.topUrl].some(
          (page) => page !== undefined && pauseSite(page) === pauseSite(url),
        )
      )
        stopping.push(stopForPause(rt, run));
    await Promise.all(stopping);
  } else
    for (const id of ids) {
      // A choice offered because of the pause ends; the page's announcement decides anew.
      const hadChoice = rt.pending.get(id)?.paused === true;
      if (hadChoice) clearChoice(rt, id);
      // Every frame announces again, so the site's pages log in at once; after a pause
      // that ran out by itself, those still refused as paused do.
      if (
        resumed ||
        hadChoice ||
        rt.documents.values().some((live) => live.document.tabId === id && live.reason === "paused")
      )
        void browser.tabs
          .sendMessage(id, { version: 1, type: "login.reconnect" })
          .catch(() => undefined);
    }
  return { ok: true, ...(until === undefined ? {} : { until }) };
}

/**
 * Ends the pause of the site of a login picked in the popup once it signed in, confirmed
 * as `noteSignedIn` counts it (ADR 0062): the person signed in, so nothing is left to keep
 * paused. Its own site's pause ends, and for a login in a frame the tab's site's too.
 */
export async function endPickedPause(
  rt: Runtime,
  metadata: LoginAttemptMetadata,
  live: LiveDocument | undefined,
): Promise<void> {
  const { tabId } = metadata.document;
  if (rt.picked.get(tabId)?.attemptId !== metadata.id) return;
  const tab = await browser.tabs.get(tabId).catch(() => undefined);
  const incognito = live?.incognito ?? tab?.incognito;
  // A login whose window kind is not known ends no pause, since the other kind's pause is
  // the person's own.
  if (incognito === undefined) return;
  const urls = new Set(
    [metadata.account.origin, metadata.pageOrigin, live?.topUrl].filter(
      (value): value is string => value !== undefined,
    ),
  );
  const ended: string[] = [];
  for (const url of urls)
    if (await rt.pauses.resume(url, incognito).catch(() => false)) ended.push(url);
  for (const url of ended) {
    report(rt, metadata.document, {
      type: "pause",
      tabId,
      origin: new URL(url).origin,
      action: "picked",
      ...(incognito ? { incognito: true as const } : {}),
    });
    // eslint-disable-next-line no-await-in-loop
    await showPause(rt, url, incognito);
  }
}
