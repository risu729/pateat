import {
  onlyChoicesSince,
  getItemEligibility,
  itemAsksForMasterPassword,
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
import { pagePermission } from "./page-permission";
import { probeMode } from "./constants";
import { manualPending } from "./manual-scope";
import { hasConfirmAuthentication, type ConfirmWork } from "./confirm-state";
import { openPasswordWindow } from "./master-password";
import { settleConfirmFill } from "./not-started";
import { LOGIN_STEP_WAIT_MS } from "../wire";
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
  const permission = pagePermission(snapshot.snapshot.settings, live.url, "confirm");
  if (!work.generation && permission.permission !== "fill") return;
  if (
    work.policyRevision !== undefined &&
    !onlyChoicesSince(snapshot.snapshot, work.policyRevision)
  )
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

/**
 * A confirmation gets its own document-bound reprompt, never a saved login grant. Its
 * window does not hold the tab: the work ends while it is open (`asked`), so the tab's
 * other frames, **Log in now** and an account switch go on meanwhile. Once the vault
 * accepts the password for the same vault account, while the document, still on the same
 * path, and the authenticated login are the tab's, the document announces again and that
 * announcement's fill uses the answer, once, on that path with the same recipe, within
 * `LOGIN_STEP_WAIT_MS`. A window answered for another vault account, as a login's that
 * was open already, is followed by one for this account. A window the person closed leaves
 * the page to them until the document moves to another path; an unavailable one asks again
 * at the document's next announcement.
 */
export async function confirmReprompt(
  rt: Runtime,
  work: ConfirmWork,
  found: NonNullable<Awaited<ReturnType<typeof confirmAccount>>>,
): Promise<boolean | "asked"> {
  if (!itemAsksForMasterPassword(found.snapshot.snapshot.settings, found.item, work.live.url))
    return true;
  if (!rt.options.askMasterPassword || !confirmCurrent(rt, work)) return false;
  const { live, parent } = work;
  const { tabId, frameId, documentId } = live.document;
  const key = tabId + " " + documentId;
  const grant = parent.id + " " + found.connection.id;
  const state = rt.confirmFill;
  const recipeId = work.recipe?.id;
  const granted = state.granted.get(live);
  state.granted.delete(live);
  if (granted?.grant === grant && granted.recipeId === recipeId && Date.now() < granted.expires)
    return true;
  if (!recipeId) return false;
  if (state.asking.has(key)) return "asked";
  state.asking.add(key);
  const ask = () => {
    // A window already open for the document, as its login's or a detail's, is answered once.
    const asked =
      rt.passwordAsks.get(key) ??
      openPasswordWindow(rt, "detail", key, {
        tabId,
        origin: live.document.origin,
        account: parent.account,
        connection: found.connection,
        item: found.item,
      });
    void asked.answer
      .then(async ({ answer, aborted }) => {
        const page = rt.documents.get(frameKey(live.document));
        const here = page?.document.documentId === documentId ? page : undefined;
        const current =
          !aborted &&
          here?.path === live.path &&
          recordFor(rt, tabId, live.document.origin)?.id === parent.id;
        // Checked for another vault account: once it ends, the page asks for its own.
        if (current && asked.connectionId !== found.connection.id) return ask();
        state.asking.delete(key);
        if (!current || answer !== "verified") {
          // Only the person closing the window leaves the page to them; an unavailable
          // vault or prompt asks again at the document's next announcement.
          if (here)
            await settleConfirmFill(
              rt,
              here,
              live.path,
              "confirm-fill-stopped",
              current && answer === "closed",
            );
          return undefined;
        }
        const entry = {
          grant,
          path: live.path,
          recipeId,
          expires: Date.now() + LOGIN_STEP_WAIT_MS,
        };
        state.verified.set(key, entry);
        await browser.tabs
          .sendMessage(tabId, { version: 1, type: "login.reconnect" }, { frameId, documentId })
          .catch(() => {
            if (state.verified.get(key) === entry) state.verified.delete(key);
          });
        return undefined;
      })
      .catch(() => state.asking.delete(key));
  };
  ask();
  return "asked";
}
