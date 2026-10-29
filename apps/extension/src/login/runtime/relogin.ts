import { type LoginAttemptMetadata } from "@pateat/contracts";
import { browser } from "wxt/browser";
import { reloginKey, siteOf } from "./steps";
import { RELOGIN_WINDOW_MS, RELOGIN_LIMIT } from "./constants";
import { quietly } from "./session-store";
import { saveSession } from "./attempt";
import type { Runtime } from "./state";

/** Records a page or document in `askFills`, keeping the 256 newest. */
export function addAskFill(rt: Runtime, entry: string): void {
  rt.askFills.add(entry);
  for (const old of rt.askFills) {
    if (rt.askFills.size <= 256) break;
    rt.askFills.delete(old);
  }
}

/** A login just signed in, confirmed: what `noteSignedIn` tells (ADR 0007, ADR 0062). */
export const signedInNow = (
  _rt: Runtime,
  previous: LoginAttemptMetadata,
  next: LoginAttemptMetadata,
) => next.state === "authenticated" && !next.unconfirmed && previous.state !== "authenticated";

/**
 * The times automatic logins of `site` ended `authenticated` that still count at `now`
 * (ADR 0062); a clock set back drops them rather than keeping them longer.
 */
export function reloginTimes(rt: Runtime, site: string, incognito: boolean, now: number): number[] {
  return (rt.relogins.get(reloginKey(site, incognito))?.at ?? []).filter(
    (at) => now - at >= 0 && now - at < RELOGIN_WINDOW_MS,
  );
}

/**
 * Whether a new automatic login of the origin would be one too many: two of its site
 * ended `authenticated` within the last 10 minutes, in any tab of the same normal or
 * incognito session (ADR 0062).
 */
export function reloginLimited(rt: Runtime, siteOrigin: string, incognito: boolean): boolean {
  const site = siteOf(siteOrigin);
  return (
    site !== undefined && reloginTimes(rt, site, incognito, Date.now()).length >= RELOGIN_LIMIT
  );
}

/**
 * Forgets the re-logins of each site none of whose tabs is open any more in its normal or
 * incognito session, and those past the window (ADR 0062). Returns whether any went.
 */
export async function forgetClosedSites(rt: Runtime): Promise<boolean> {
  const open = await browser.tabs.query({}).catch(() => undefined);
  if (!open) return false;
  const shown = new Set(
    open.flatMap((tab) => {
      const site = tab.url ? siteOf(tab.url) : undefined;
      return site === undefined ? [] : [reloginKey(site, tab.incognito === true)];
    }),
  );
  const now = Date.now();
  let changed = false;
  for (const [key, entry] of rt.relogins)
    if (!shown.has(key) || !reloginTimes(rt, entry.site, entry.incognito, now).length) {
      rt.relogins.delete(key);
      changed = true;
    }
  return changed;
}

/**
 * Counts a login that just ended `authenticated`, an undecided completion (ADR 0029)
 * included, for its registrable site (ADR 0062). A login a popup pick started is the
 * person's own and is not counted.
 */
export function countRelogin(
  rt: Runtime,
  previous: LoginAttemptMetadata,
  next: LoginAttemptMetadata,
  incognito: boolean,
): void {
  if (next.state !== "authenticated" || previous.state === "authenticated") return;
  if (rt.picked.get(next.document.tabId)?.attemptId === next.id) return;
  countSignIn(rt, next.account.origin, incognito);
}

/**
 * Counts a sign-in Pateat made by itself on the origin's registrable site towards the
 * relogin guard (ADR 0062): a login that ended `authenticated`, or a passkey request the
 * page started without user activation that it answered with no login and no choice, as
 * a login page that asks on load after each logout.
 */
export function countSignIn(rt: Runtime, siteOrigin: string, incognito: boolean): void {
  const site = siteOf(siteOrigin);
  if (site === undefined) return;
  const now = Date.now();
  const key = reloginKey(site, incognito);
  const at = [...reloginTimes(rt, site, incognito, now), now].slice(-RELOGIN_LIMIT);
  // The most recently counted site is kept last, so the cap drops the oldest first.
  rt.relogins.delete(key);
  rt.relogins.set(key, { site, incognito, at });
  for (const oldest of rt.relogins.keys()) {
    if (rt.relogins.size <= 256) break;
    rt.relogins.delete(oldest);
  }
  void quietly(rt, () => saveSession(rt));
}
