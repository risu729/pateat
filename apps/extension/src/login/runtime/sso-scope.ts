import { heldElsewhere } from "./hold";
import { pausedInPrivate } from "../pause";
import {
  getItemEligibility,
  isSiteAllowed,
  isSiteExcluded,
  onlyChoicesSince,
  resolvePagePermission,
  type LoginDocument,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { frameKey, siteOf } from "./steps";
import { pauseOf } from "./pause";
import { itemMatchesUrl } from "./plan";
import { ssoDependenciesKept } from "./sso/dependencies";
import type { Runtime } from "./state";
import type { SsoWork } from "./sso-state";
import type { LiveDocument } from "./types";

/**
 * Where the flow's RP return may land: the RP's own origin, or another origin of its
 * registrable site that is not the selected IdP's, as a broker that hands the tab to the
 * site's portal or its own callback does (ADR 0085 amendment of 2026-11-18). Any other
 * origin stays forbidden.
 */
export function ssoReturnOrigin(work: SsoWork, origin: string) {
  if (origin === work.account.origin) return true;
  const site = siteOf(work.account.origin);
  return origin !== work.selected.origin && site !== undefined && siteOf(origin) === site;
}
export const ssoCurrent = (rt: Runtime, work: SsoWork, live = work.live) =>
  rt.sso.flows.get(work.rpLive.document.tabId) === work &&
  !work.ended &&
  !work.abort.signal.aborted &&
  rt.sso.healthy() &&
  rt.vars.storageHealthy &&
  !rt.sso.pauseIntents.blocked(work.rpLive.url, work.rpLive.incognito) &&
  !rt.sso.pauseIntents.blocked(work.selected.origin, work.rpLive.incognito) &&
  !rt.manualStarts.get(live.document.tabId)?.pick &&
  !rt.switchesRunning.has(live.document.tabId) &&
  !rt.bindingReviews.has(live.document.tabId) &&
  (!rt.picked?.get(live.document.tabId) ||
    rt.picked.get(live.document.tabId) === work.chosen.pick ||
    rt.picked.get(live.document.tabId)?.attemptId === work.id) &&
  Date.now() - work.startedAt < 600_000 &&
  !heldElsewhere(rt, live.document.tabId, work.account.origin) &&
  !heldElsewhere(rt, live.document.tabId, work.selected.origin) &&
  live.document.frameId === 0 &&
  rt.documents.get(frameKey(live.document)) === live &&
  (ssoReturnOrigin(work, live.document.origin) || live.document.origin === work.selected.origin);
export const ssoChildOn = (rt: Runtime, document: LoginDocument) => {
  const work = rt.sso.flows.get(document.tabId);
  return work && !work.ended && document.frameId === 0 && document.origin === work.selected.origin
    ? work
    : undefined;
};
/** A synchronous check that the scope one {@link ssoScope} call checked still holds. */
export type SsoFence = () => boolean;
/**
 * A fresh mapping is evidence only; item, page, policy and operation epochs authorize
 * delivery. Returns the fence of this check, to recheck after later awaits, or undefined
 * when it fails. Each caller keeps its own fence, so another check of the same flow, as
 * for its IdP child's document, never replaces it.
 */
export async function ssoScope(
  rt: Runtime,
  work: SsoWork,
  live: LiveDocument = work.live,
): Promise<SsoFence | undefined> {
  if (
    !ssoCurrent(rt, work, live) ||
    !rt.options.sso ||
    rt.manualStarts.get(live.document.tabId)?.pick ||
    rt.switchesRunning.has(live.document.tabId) ||
    rt.bindingReviews.has(live.document.tabId)
  )
    return undefined;
  const picked = rt.picked?.get(live.document.tabId);
  if (picked && picked !== work.chosen.pick && picked.attemptId !== work.id) return undefined;
  const tab = await browser.tabs.get(live.document.tabId).catch(() => undefined);
  if (
    !ssoCurrent(rt, work, live) ||
    !tab?.url ||
    tab.url !== live.url ||
    tab.incognito !== live.incognito
  )
    return undefined;
  const pauses = await Promise.all([
    pauseOf(rt, live),
    pauseOf(rt, { url: work.rpLive.url, incognito: work.rpLive.incognito }),
    pauseOf(rt, { url: work.selected.origin, incognito: work.rpLive.incognito }),
  ]);
  if (pauses.some(Boolean)) return undefined;
  if (!ssoCurrent(rt, work, live)) return undefined;
  const saved = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!saved.ok || !ssoCurrent(rt, work, live) || !ssoDependenciesKept(work, work.saved, saved))
    return undefined;
  if (pausedInPrivate(saved.snapshot.settings, live.incognito)) return undefined;
  for (const page of [work.rpLive.url, live.url, work.selected.origin]) {
    if (
      isSiteExcluded(saved.snapshot.settings, page) ||
      !isSiteAllowed(saved.snapshot.settings, page) ||
      resolvePagePermission(saved.snapshot.settings, page, "sign-in")?.permission !== "auto"
    )
      return undefined;
  }
  if (
    ssoReturnOrigin(work, live.document.origin) &&
    !isSiteAllowed(saved.snapshot.settings, work.selected.origin)
  )
    return undefined;
  for (const account of [work.source.account, work.selected.account]) {
    const found = getItemEligibility(
      saved.snapshot.settings,
      saved.catalog,
      account.connectionId,
      account.itemId,
    );
    const connection = saved.catalog.connections.find((entry) => entry.id === account.connectionId);
    if (
      !found.eligible ||
      found.item.inactive ||
      connection?.quarantinedItemIds?.includes(account.itemId) ||
      !connection?.snapshotId ||
      (connection.provider === "bitwarden" &&
        rt.options.bindingSnapshotCurrent?.(connection.id, connection.snapshotId) !== true)
    )
      return undefined;
  }
  const mapping = await rt.options.sso.validate(work.source, work.selected);
  if (!mapping.ok || !ssoCurrent(rt, work, live)) return undefined;
  // The selection was validated on these settings, or on later ones that only wrote
  // choices (`onlyChoicesSince`).
  if (mapping.data.policyRevision !== saved.snapshot.revision) {
    const latest = await rt.settings.handle({ version: 1, type: "settings.get" });
    if (
      !latest.ok ||
      !ssoCurrent(rt, work, live) ||
      mapping.data.policyRevision < saved.snapshot.revision ||
      mapping.data.policyRevision > latest.snapshot.revision ||
      !onlyChoicesSince(latest.snapshot, saved.snapshot.revision)
    )
      return undefined;
  }
  const selected =
    live.document.origin === work.selected.origin ? work.selected.account : work.source.account;
  const matched = await itemMatchesUrl(rt, saved, selected, live.url, saved.catalog);
  if ("reason" in matched || !ssoCurrent(rt, work, live)) return undefined;
  const recipe = work.recipe;
  let recipeCurrent: (() => boolean) | undefined;
  if (work.recipe) {
    recipeCurrent = await rt.recipes.ssoFence?.(work.recipe).catch(() => undefined);
    if (!recipeCurrent?.() || !ssoCurrent(rt, work, live)) return undefined;
    const heads = await rt.recipes.sso?.(work.account.origin, work.recipe.sso.path, work.recipe.id);
    if (
      !ssoCurrent(rt, work, live) ||
      !heads?.some((head) => JSON.stringify(head) === JSON.stringify(work.recipe))
    )
      return undefined;
  }
  // The final awaited read follows all provider and recipe work.
  const latest = await rt.settings.handle({ version: 1, type: "settings.get" });
  const snapshotCurrent = () =>
    [work.source.account, work.selected.account].every((account) => {
      const connection = saved.catalog.connections.find(
        (entry) => entry.id === account.connectionId,
      );
      return (
        !!connection?.snapshotId &&
        (connection.provider !== "bitwarden" ||
          rt.options.bindingSnapshotCurrent?.(connection.id, connection.snapshotId) === true)
      );
    });
  const current = () =>
    ssoCurrent(rt, work, live) &&
    snapshotCurrent() &&
    work.recipe === recipe &&
    (!recipe || recipeCurrent?.() === true);
  if (!current() || !latest.ok || !ssoDependenciesKept(work, saved, latest)) return undefined;
  // A newer revision that changed nothing the flow depends on carries the flow over.
  work.saved = latest;
  return current;
}
