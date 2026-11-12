import { type LoginAttemptMetadata } from "@pateat/contracts";
import { recordKey, siteOf } from "./steps";
import { terminal, watchOver, idle, passiveFillWaiting } from "./attempt-state";
import { manualPending } from "./manual-scope";
import type { LiveDocument, Execution } from "./types";
import {
  heldElsewhere as recordsHeldElsewhere,
  sharesCookies as tabsShareCookies,
  signedInElsewhere as recordsSignedInElsewhere,
} from "./hold-policy";
import type { Runtime } from "./state";

/**
 * The record of a tab for one origin, also once it ended. A document resumes only its
 * own origin's record; a logout may release exactly this one.
 */
export function recordFor(
  rt: Runtime,
  tabId: number,
  documentOrigin: string,
): LoginAttemptMetadata | undefined {
  const parent = rt.sso.flows.get(tabId);
  if (parent && !parent.ended && parent.account.origin === documentOrigin && parent.parent)
    return parent.parent;
  const run = rt.attempts.get(tabId);
  return run?.metadata.account.origin === documentOrigin
    ? run.metadata
    : rt.persisted.get(recordKey(tabId, documentOrigin));
}

/**
 * Whether another tab's login still holds the origin. Cookies can be shared across tabs,
 * so a login that is running, awaits its result, or ended without success there keeps this
 * tab from submitting until that tab closes or its record has not changed for
 * `HOLD_MS` (ADR 0022). One that authenticated, ended without ever submitting, or was
 * stopped by Pateat with nothing in flight does not: the login form showing in this tab
 * then means the site's session has ended.
 */
export function heldElsewhere(rt: Runtime, tabId: number, siteOrigin: string): boolean {
  const now = Date.now();
  if (
    [...rt.sso.flows.values()].some(
      (flow) =>
        !flow.ended &&
        flow.rpLive.document.tabId !== tabId &&
        [flow.account.origin, flow.selected.origin].includes(siteOrigin) &&
        sharesCookies(rt, tabId, flow.rpLive.document.tabId),
    )
  )
    return true;
  return (
    switchingElsewhere(rt, tabId, siteOf(siteOrigin)) ||
    recordsHeldElsewhere(rt.persisted.values(), rt.incognitoTabs, tabId, siteOrigin, now)
  );
}

/**
 * Whether another tab sharing its cookies switches accounts on `site` (ADR 0063): from
 * its start until its pick starts a login, the switch fails or the pick expires. A login
 * here meanwhile would sign the site back in with the account being left.
 */
export function switchingElsewhere(rt: Runtime, tabId: number, site: string | undefined): boolean {
  return rt.accountPicks.switchingElsewhere(tabId, site, rt.incognitoTabs.get(tabId));
}

/**
 * Whether two tabs may share a site's cookies: unless one is known to be in an incognito
 * window and the other known not to be (owner, 2026-10-23).
 */
export function sharesCookies(rt: Runtime, tabId: number, otherTabId: number): boolean {
  return tabsShareCookies(rt.incognitoTabs, tabId, otherTabId);
}

/** The tab of a `recordKey`. */
export const keyTab = (_rt: Runtime, key: string) => Number(key.slice(0, key.indexOf(" ")));

/**
 * Whether another tab sharing its cookies logged in to the origin within the last hour. A list of
 * accounts showing then is most likely the signed-in site's own, such as its accounts or
 * workspaces, so it is not sent for generation (ADR 0028, owner 2026-10-17). The record
 * stays until that tab shows the recipe's first step again or closes, so the hour bounds
 * how long a tab left open keeps a real list of the site from being sent.
 */
export function signedInElsewhere(rt: Runtime, tabId: number, siteOrigin: string): boolean {
  const now = Date.now();
  return recordsSignedInElsewhere(rt.persisted.values(), rt.incognitoTabs, tabId, siteOrigin, now);
}

/** Whether another tab sharing its cookies still asks after the site rejected its login (ADR 0021). */
export function rejectedElsewhere(rt: Runtime, tabId: number, siteOrigin: string): boolean {
  return [...rt.rejectedAsks].some(
    (key) =>
      key !== recordKey(tabId, siteOrigin) &&
      key.endsWith(` ${siteOrigin}`) &&
      sharesCookies(rt, keyTab(rt, key), tabId),
  );
}

/** Tells the tab why it does not log in while another tab's login holds the site (a key). */
export function showHeld(rt: Runtime, tabId: number): void {
  rt.badge.note(
    tabId,
    "Pateat: another tab's login to this site is running or did not succeed. Close that tab, or wait up to 10 minutes and reload this page, to log in here.",
  );
}

/** The attempt a tab runs, else the one it last recorded. */
export function tabAttempt(rt: Runtime, tabId: number): LoginAttemptMetadata | undefined {
  const run = rt.attempts.get(tabId);
  if (run) return run.metadata;
  const records = [...rt.persisted.values()].filter((entry) => entry.document.tabId === tabId);
  return records.find((entry) => !terminal(entry)) ?? records.at(-1);
}

/** An explicit retry ignores ended-record cooldowns, while live work and account switches still win. */
export function manualHeldElsewhere(rt: Runtime, tabId: number, origin: string): boolean {
  if (switchingElsewhere(rt, tabId, siteOf(origin))) return true;
  if (
    [...rt.attempts.values()].some(
      (run) =>
        run.running &&
        (!passiveFillWaiting(run.metadata, run) ||
          rt.options.passkeyActive?.(run.metadata.document.documentId)) &&
        run.metadata.document.tabId !== tabId &&
        run.metadata.account.origin === origin &&
        sharesCookies(rt, tabId, run.metadata.document.tabId),
    )
  )
    return true;
  const records = new Map([...rt.persisted.values()].map((record) => [record.id, record]));
  for (const run of rt.attempts.values()) records.set(run.metadata.id, run.metadata);
  return [...records.values()].some(
    (record) =>
      record.document.tabId !== tabId &&
      record.account.origin === origin &&
      sharesCookies(rt, tabId, record.document.tabId) &&
      (!passiveFillWaiting(record, rt.attempts.get(record.document.tabId)) ||
        rt.options.passkeyActive?.(record.document.documentId)) &&
      ((!terminal(record) && !record.settled) ||
        (record.state === "watching" && !watchOver(record, Date.now()))),
  );
}

/** Ordinary logins retain the automatic hold; only an explicit request uses the narrower one. */
export function heldForLogin(rt: Runtime, live: LiveDocument): boolean {
  const pick = rt.picked.get(live.document.tabId);
  const manual =
    manualPending(rt, live) ||
    (pick?.manual &&
      pick.attemptId !== undefined &&
      recordFor(rt, live.document.tabId, live.document.origin)?.id === pick.attemptId);
  return manual
    ? manualHeldElsewhere(rt, live.document.tabId, live.document.origin)
    : heldElsewhere(rt, live.document.tabId, live.document.origin);
}

/** Retained settled observers may wake, but must not execute beside a conflicting manual login. */
export function manualExecutionConflict(rt: Runtime, run: Execution): boolean {
  const manual = (entry: Execution) => {
    const pick = rt.picked.get(entry.metadata.document.tabId);
    return pick?.manual && pick.attemptId === entry.metadata.id && !terminal(entry.metadata);
  };
  return [...rt.attempts.values()].some(
    (other) =>
      other !== run &&
      other.metadata.account.origin === run.metadata.account.origin &&
      sharesCookies(rt, run.metadata.document.tabId, other.metadata.document.tabId) &&
      (manual(run) || manual(other)) &&
      !terminal(other.metadata) &&
      (!passiveFillWaiting(other.metadata, other) ||
        rt.options.passkeyActive?.(other.metadata.document.documentId)) &&
      (other.running ||
        !idle(other.metadata) ||
        (other.metadata.state === "watching" && !watchOver(other.metadata, Date.now()))),
  );
}
