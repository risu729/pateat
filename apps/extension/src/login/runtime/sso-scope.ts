import { heldElsewhere } from "./hold";
import { pausedInPrivate } from "../pause";
import {
  getItemEligibility,
  isSiteAllowed,
  isSiteExcluded,
  resolvePagePermission,
  type LoginDocument,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { frameKey } from "./steps";
import { pauseOf } from "./pause";
import { itemMatchesUrl } from "./plan";
import type { Runtime } from "./state";
import type { SsoWork } from "./sso-state";
import type { LiveDocument } from "./types";

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
  (live.document.origin === work.account.origin || live.document.origin === work.selected.origin);
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
  if (
    !saved.ok ||
    !ssoCurrent(rt, work, live) ||
    saved.snapshot.revision !== work.saved.snapshot.revision ||
    JSON.stringify(saved.catalog) !== JSON.stringify(work.saved.catalog)
  )
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
    live.document.origin === work.account.origin &&
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
  if (
    !mapping.ok ||
    mapping.data.policyRevision !== work.saved.snapshot.revision ||
    !ssoCurrent(rt, work, live)
  )
    return undefined;
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
  if (
    !current() ||
    !latest.ok ||
    latest.snapshot.revision !== saved.snapshot.revision ||
    JSON.stringify(latest.catalog) !== JSON.stringify(saved.catalog)
  )
    return undefined;
  return current;
}
