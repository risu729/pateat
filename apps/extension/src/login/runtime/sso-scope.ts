import { heldElsewhere } from "./hold";
import { pausedInPrivate } from "../pause";
import {
  getItemEligibility,
  isSiteAllowed,
  isSiteExcluded,
  onlyChoicesSince,
  resolvePagePermission,
  type LoginDocument,
  type LocalSettings,
  type SettingsResponse,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { frameKey, siteOf } from "./steps";
import { pauseOf } from "./pause";
import { itemMatchesUrl } from "./plan";
import { ssoDependenciesKept } from "./sso/dependencies";
import type { Runtime } from "./state";
import type { SsoMapping, SsoWork } from "./sso-state";
import type { LiveDocument } from "./types";

/**
 * Where the flow's RP return may land: the RP's own origin, or another origin of its
 * registrable site that is not the selected IdP's, as a broker that hands the tab to the
 * site's portal or its own callback does (ADR 0085 amendment of 2026-11-18). The other
 * origin keeps the RP's scheme, so an https RP never returns to http, and an RP on
 * `localhost` or an IP address has no site beyond its own origin. Any other origin stays
 * forbidden.
 */
export function ssoReturnOrigin(work: SsoWork, origin: string) {
  if (origin === work.account.origin) return true;
  if (origin === work.selected.origin) return false;
  const rp = URL.parse(work.account.origin);
  const url = URL.parse(origin);
  if (!rp || !url || url.protocol !== rp.protocol || hostOnly(rp.hostname)) return false;
  const site = siteOf(rp);
  return site !== undefined && siteOf(url) === site;
}
/** `localhost`, an IPv4 address or an IPv6 literal, as URL canonicalizes them. */
const hostOnly = (hostname: string) =>
  hostname.replace(/\.$/u, "") === "localhost" ||
  hostname.startsWith("[") ||
  /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(hostname);
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
 * What a flow's SSO mapping depends on: the settings revision and whether a settings sync
 * is pending, the flow's RP method and IdP choice, and both accounts' vault connections
 * as the catalog has them, with their snapshots, states and quarantined items.
 */
const mappingKey = (work: SsoWork, saved: Extract<SettingsResponse, { ok: true }>) =>
  JSON.stringify([
    saved.snapshot.revision,
    saved.catalog.settingsSyncPending === true,
    work.source,
    work.selected,
    [work.source.account, work.selected.account].map(
      (account) =>
        saved.catalog.connections.find((entry) => entry.id === account.connectionId) ?? null,
    ),
  ]);
/**
 * The flow's SSO mapping, read from the vault once for the settings and vault snapshots
 * it depends on and kept with the flow, in memory only (ADR 0026, amendment of
 * 2026-11-22). A refused or failed read is never kept, and a read dropped while it was
 * awaited (`dropSsoMappings`) is not used: the vault is read again.
 */
async function ssoMapping(
  sso: NonNullable<Runtime["options"]["sso"]>,
  work: SsoWork,
  saved: Extract<SettingsResponse, { ok: true }>,
): Promise<SsoMapping> {
  const key = mappingKey(work, saved);
  let entry = work.mapping;
  if (entry?.key !== key) {
    entry = { key, read: sso.validate(work.source, work.selected) };
    work.mapping = entry;
  }
  const kept = entry;
  const mapping = await kept.read.catch((error: unknown) => {
    if (work.mapping === kept) work.mapping = undefined;
    throw error;
  });
  if (work.mapping !== kept) return sso.validate(work.source, work.selected);
  if (!mapping.ok) work.mapping = undefined;
  return mapping;
}
/**
 * Drops every flow's kept SSO mapping, on a vault notice (a sync, a lock, a timeout) or
 * a settings save, so the next scope check reads the vault again.
 */
export function dropSsoMappings(rt: Runtime): void {
  for (const work of rt.sso.flows.values()) work.mapping = undefined;
}
/**
 * Whether the settings let an SSO flow act on `page`, the RP's or the IdP's: a site Pateat
 * may use, not excluded, with `auto` sign-in (ADR 0026).
 */
export function ssoPageAllowed(settings: LocalSettings, page: string): boolean {
  return (
    !isSiteExcluded(settings, page) &&
    isSiteAllowed(settings, page) &&
    resolvePagePermission(settings, page, "sign-in")?.permission === "auto"
  );
}
/**
 * A fresh mapping is evidence only; item, page, policy and operation epochs authorize
 * delivery. Returns the fence of this check, to recheck after later awaits, or undefined
 * when it fails. Each caller keeps its own fence, so another check of the same flow, as
 * for its IdP child's document, never replaces it. The flow's SSO mapping is the one
 * kept for the same settings and vault snapshots (`ssoMapping`); every other part of the
 * scope is checked afresh.
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
  for (const page of [work.rpLive.url, live.url, work.selected.origin])
    if (!ssoPageAllowed(saved.snapshot.settings, page)) return undefined;
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
  const mapping = await ssoMapping(rt.options.sso, work, saved);
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
