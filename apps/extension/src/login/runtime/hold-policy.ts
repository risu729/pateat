import type { LoginAttemptMetadata } from "@pateat/contracts";
import { holdsOthers } from "./attempt-state";
import { SIGNED_IN_ELSEWHERE_MS } from "./constants";
import { siteOf } from "./steps";

/** Unknown window kinds may share cookies; only known opposite kinds are separate. */
export function sharesCookies(
  incognitoTabs: ReadonlyMap<number, boolean>,
  tabId: number,
  otherTabId: number,
): boolean {
  const incognito = incognitoTabs.get(tabId);
  const other = incognitoTabs.get(otherTabId);
  return incognito === undefined || other === undefined || incognito === other;
}

/** Attempt-record holds for one origin; the caller checks account switches separately. */
export function heldElsewhere(
  records: Iterable<LoginAttemptMetadata>,
  incognitoTabs: ReadonlyMap<number, boolean>,
  tabId: number,
  siteOrigin: string,
  now: number,
): boolean {
  for (const entry of records)
    if (
      entry.account.origin === siteOrigin &&
      entry.document.tabId !== tabId &&
      sharesCookies(incognitoTabs, entry.document.tabId, tabId) &&
      holdsOthers(entry, now)
    )
      return true;
  return false;
}

/** Attempt-record holds across the origins of one registrable site. */
export function siteHeldElsewhere(
  records: Iterable<LoginAttemptMetadata>,
  incognitoTabs: ReadonlyMap<number, boolean>,
  tabId: number,
  site: string,
  now: number,
): boolean {
  for (const entry of records)
    if (
      entry.document.tabId !== tabId &&
      siteOf(entry.account.origin) === site &&
      sharesCookies(incognitoTabs, entry.document.tabId, tabId) &&
      holdsOthers(entry, now)
    )
      return true;
  return false;
}

/** A recent signed-in record suppresses account-list generation in another shared tab. */
export function signedInElsewhere(
  records: Iterable<LoginAttemptMetadata>,
  incognitoTabs: ReadonlyMap<number, boolean>,
  tabId: number,
  siteOrigin: string,
  now: number,
): boolean {
  for (const entry of records) {
    const age = now - (entry.changedAt ?? Number.NEGATIVE_INFINITY);
    if (
      entry.account.origin === siteOrigin &&
      entry.document.tabId !== tabId &&
      sharesCookies(incognitoTabs, entry.document.tabId, tabId) &&
      entry.state === "authenticated" &&
      age >= 0 &&
      age < SIGNED_IN_ELSEWHERE_MS
    )
      return true;
  }
  return false;
}
