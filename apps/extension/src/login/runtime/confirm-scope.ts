import {
  getItemEligibility,
  itemAsksForMasterPassword,
  resolvePagePermission,
  runsLogin,
  type LoginRecipe,
} from "@pateat/contracts";
import { browser } from "wxt/browser";
import { recordFor, tabAttempt, switchingElsewhere } from "./hold";
import { frameKey, siteOf } from "./steps";
import { terminal } from "./attempt-state";
import { liveScope, topScope, bindingFor } from "./plan";
import { routesOf } from "./generation-scope";
import { pauseOf } from "./pause";
import { probeMode } from "./constants";
import { manualPending } from "./manual-scope";
import { hasConfirmAuthentication, type ConfirmWork } from "./confirm-state";
import { openPasswordWindow } from "./master-password";
import type { Runtime } from "./state";

export function confirmCurrent(rt: Runtime, work: ConfirmWork): boolean {
  const { live, parent } = work;
  const latest = recordFor(rt, live.document.tabId, live.document.origin);
  const top = rt.documents.get(frameKey({ tabId: live.document.tabId, frameId: 0 }));
  const running = tabAttempt(rt, live.document.tabId);
  return (
    !work.cancelled &&
    rt.confirmFill.healthy &&
    rt.vars.storageHealthy &&
    rt.confirmFill.work.get(live.document.tabId) === work &&
    rt.documents.get(frameKey(live.document)) === live &&
    latest?.id === parent.id &&
    hasConfirmAuthentication(rt, latest) &&
    latest.account.connectionId === parent.account.connectionId &&
    latest.account.itemId === parent.account.itemId &&
    (!running || terminal(running)) &&
    !manualPending(rt, live) &&
    !rt.manualStarts.get(live.document.tabId)?.pick &&
    !rt.switchesRunning.has(live.document.tabId) &&
    !switchingElsewhere(rt, live.document.tabId, siteOf(live.document.origin)) &&
    !rt.accountPicks.switchingHere(
      live.document.tabId,
      siteOf(live.document.origin),
      live.incognito,
    ) &&
    (live.document.frameId === 0 || top?.document.documentId === work.topDocumentId)
  );
}

async function snapshotFor(rt: Runtime, work: ConfirmWork) {
  if (!confirmCurrent(rt, work)) return;
  const { live } = work;
  const tab = await browser.tabs.get(live.document.tabId).catch(() => undefined);
  if (!tab?.url || tab.url !== (live.topUrl ?? live.url) || !confirmCurrent(rt, work)) return;
  const admissions = await Promise.all(
    [live.url, ...(live.topUrl ? [live.topUrl] : [])].map(async (value) => {
      const url = new URL(value);
      return (
        (probeMode && url.origin === rt.vars.origin) ||
        (await rt.sites?.admission(url).catch(() => "settings-unavailable")) === "admitted"
      );
    }),
  );
  if (!admissions.every(Boolean) || !confirmCurrent(rt, work)) return;
  if (await pauseOf(rt, live)) return;
  if (!confirmCurrent(rt, work)) return;
  const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
  if (!snapshot.ok || !confirmCurrent(rt, work)) return;
  const permission = resolvePagePermission(snapshot.snapshot.settings, live.url, "confirm");
  if (!permission || (!work.generation && permission.permission !== "fill")) return;
  if (work.policyRevision !== undefined && snapshot.snapshot.revision !== work.policyRevision)
    return;
  return snapshot;
}

/** Eligibility is checked for the authenticated account, never by a default or popup pick. */
export async function confirmAccount(rt: Runtime, work: ConfirmWork) {
  const snapshot = await snapshotFor(rt, work);
  if (!snapshot) return;
  const { account } = work.parent;
  const scoped = await liveScope(rt, snapshot, work.live, account);
  if ("reason" in scoped || !confirmCurrent(rt, work)) return;
  // A frame-only URI grant must never authorize its top page, even on the same origin.
  if (await topScope(rt, snapshot, work.live, account, snapshot.catalog)) return;
  const connection = scoped.catalog.connections.find((entry) => entry.id === account.connectionId);
  const item = connection?.items.find((entry) => entry.id === account.itemId);
  const eligible = getItemEligibility(
    snapshot.snapshot.settings,
    scoped.catalog,
    account.connectionId,
    account.itemId,
  );
  if (
    !connection ||
    !item ||
    !eligible.eligible ||
    !item.allowedOrigins.includes(work.live.document.origin) ||
    (connection.state !== undefined && !["ready", "review-required"].includes(connection.state)) ||
    connection.quarantinedItemIds?.includes(item.id) ||
    (connection.provider === "bitwarden" && !connection.snapshotId) ||
    (work.snapshotId !== undefined && connection.snapshotId !== work.snapshotId)
  )
    return;
  const scope = await rt.options.bindingScope?.(snapshot.snapshot).catch(() => undefined);
  if (rt.options.bindingScope && scope === undefined) return;
  if (work.scopeMark !== undefined && scope !== work.scopeMark) return;
  const latest = await snapshotFor(rt, work);
  if (!latest || JSON.stringify(latest) !== JSON.stringify(snapshot) || !confirmCurrent(rt, work))
    return;
  return { snapshot, catalog: scoped.catalog, connection, item, eligible, scope };
}

/** Fresh recipe head, policy, vault snapshot and field bindings authorize each delivery. */
export async function confirmPlan(
  rt: Runtime,
  work: ConfirmWork,
  recipe: LoginRecipe,
  slots: readonly string[],
) {
  const recipeCurrent = await rt.recipes.fence?.(recipe).catch(() => undefined);
  if (!recipeCurrent) return;
  const found = await confirmAccount(rt, work);
  if (!found) return;
  const snapshotCurrent = () =>
    found.connection.provider !== "bitwarden" ||
    (found.connection.snapshotId !== undefined &&
      rt.options.bindingSnapshotCurrent?.(found.connection.id, found.connection.snapshotId) ===
        true);
  if (!recipeCurrent() || !snapshotCurrent()) return;
  const routes = await routesOf(rt, work.live.document.origin);
  const current = routes?.find((entry) => entry.id === recipe.id && entry.layout === recipe.layout);
  if (!current || runsLogin(current) || JSON.stringify(current) !== JSON.stringify(recipe)) return;
  if (await rt.recipes.withdrawn?.(recipe.origin, recipe.id, recipe.layout).catch(() => true))
    return;
  if (!confirmCurrent(rt, work)) return;
  const bound = await bindingFor(
    rt,
    found.catalog,
    found.snapshot.snapshot.settings,
    recipe,
    { ...work.parent.account, saved: false, source: "match" },
    work.live.document.origin,
    slots,
    () => Promise.resolve(rt.generation?.slotFields(recipe.id)).catch(() => undefined),
    true,
  );
  if (
    !bound.ok ||
    !bound.binding.slots.every((field) => found.eligible.fieldIds.includes(field.fieldId))
  )
    return;
  const latest = await confirmAccount(rt, work);
  if (
    !latest ||
    JSON.stringify(latest) !== JSON.stringify(found) ||
    !confirmCurrent(rt, work) ||
    !recipeCurrent() ||
    !snapshotCurrent()
  )
    return;
  const fence = () => confirmCurrent(rt, work) && recipeCurrent() && snapshotCurrent();
  return {
    ...found,
    fence,
    binding: bound.binding,
    account: { ...work.parent.account, fieldIds: found.eligible.fieldIds },
  };
}

/** A confirmation gets its own document-bound reprompt, never a saved login grant. */
export async function confirmReprompt(
  rt: Runtime,
  work: ConfirmWork,
  found: NonNullable<Awaited<ReturnType<typeof confirmAccount>>>,
): Promise<boolean> {
  if (!itemAsksForMasterPassword(found.snapshot.snapshot.settings, found.item, work.live.url))
    return true;
  if (!rt.options.askMasterPassword || !confirmCurrent(rt, work)) return false;
  const key = work.live.document.tabId + " " + work.live.document.documentId;
  const asked =
    rt.passwordAsks.get(key) ??
    openPasswordWindow(rt, "detail", key, {
      tabId: work.live.document.tabId,
      origin: work.live.document.origin,
      account: work.parent.account,
      connection: found.connection,
      item: found.item,
    });
  const answer = await asked.answer;
  return (
    answer.answer === "verified" &&
    !answer.aborted &&
    asked.connectionId === found.connection.id &&
    confirmCurrent(rt, work)
  );
}
