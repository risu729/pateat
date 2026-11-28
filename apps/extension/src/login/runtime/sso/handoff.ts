import {
  fillRoles,
  sameLoginDocument,
  type LoginDocument,
  type LoginObservation,
  type VaultItemMetadata,
} from "@pateat/contracts";
import { saveSession } from "../attempt";
import { quietly } from "../session-store";
import { siteOf } from "../steps";
import type { Runtime } from "../state";

// The hand-off of an SSO item's URL-form method on a page that asks for an identifier
// alone (owner, 2026-11-28 07:42 UTC, ADR 0085 amendment of that day, #1847).

const fenceKey = (tabId: number, origin: string, path: string) => `${tabId} ${origin}${path}`;

/**
 * Why the item's sign-in may not hand off on this page, or undefined when it may: the
 * item's own Username holds a value the account may fill; the page's observation shows no
 * password field and exactly one field to fill; and no hand-off typed on this tab's page
 * of the origin and path before, nor was refused there (`fenceHandoff`), unless the
 * person's own Log in now asks. A fenced page's miss is the fence's reason, as `typed`.
 */
export function handoffMiss(
  rt: Runtime,
  page: { tabId: number; origin: string; path: string; manual: boolean },
  item: Pick<VaultItemMetadata, "fields">,
  fieldIds: readonly string[],
  observation: LoginObservation | undefined,
): string | undefined {
  const username = item.fields.find((field) => field.id === "login.username");
  if (!username || username.empty === true || !fieldIds.includes("login.username"))
    return "no-username";
  if (!observation) return "unread";
  const fields = observation.candidates.filter((candidate) =>
    (fillRoles as readonly string[]).includes(candidate.role),
  );
  if (fields.some((candidate) => candidate.role === "password")) return "password-field";
  if (fields.length !== 1) return "fields";
  return page.manual ? undefined : rt.ssoHandoffs.get(fenceKey(page.tabId, page.origin, page.path));
}

/**
 * A hand-off login starts on the tab's page of `origin` and `path` (`typed`), or its
 * admission was refused there (`why`, as `no-route:sso-identifier:fills-other`): none
 * hands off there by itself again, also from another document of that page, as after Back,
 * until a login of that site in the tab signs in (`liftHandoffFence`). The page's next
 * announcement waits for the person's entry choice instead, its line naming `why`. The
 * 256 newest are kept across a restart.
 */
export function fenceHandoff(
  rt: Runtime,
  tabId: number,
  origin: string,
  path: string,
  why = "typed",
): void {
  const key = fenceKey(tabId, origin, path);
  rt.ssoHandoffs.delete(key);
  rt.ssoHandoffs.set(key, why);
  for (const old of rt.ssoHandoffs.keys()) {
    if (rt.ssoHandoffs.size <= 256) break;
    rt.ssoHandoffs.delete(old);
  }
  void quietly(rt, () => saveSession(rt));
}

/**
 * A login of the tab signed in on `origins`: the tab's pages of the same sites, or of the
 * same origins where they have no registrable site, may hand off again. Another site's
 * sign-in in that tab keeps them fenced.
 */
export function liftHandoffFence(rt: Runtime, tabId: number, origins: readonly string[]): void {
  const sameSite = (origin: string) =>
    origins.some((signed) => {
      const site = siteOf(signed);
      return site === undefined ? signed === origin : siteOf(origin) === site;
    });
  let changed = false;
  for (const key of rt.ssoHandoffs.keys()) {
    if (!key.startsWith(`${tabId} `)) continue;
    const origin = URL.parse(key.slice(`${tabId} `.length))?.origin;
    if (origin && sameSite(origin)) changed = rt.ssoHandoffs.delete(key) || changed;
  }
  if (changed) void quietly(rt, () => saveSession(rt));
}

/** The tab's method choice when it is a hand-off for this very document. */
export function handoffOn(rt: Runtime, document: LoginDocument) {
  const native = rt.sso.native.get(document.tabId);
  return native?.handoff && sameLoginDocument(native.document, document) ? native : undefined;
}
