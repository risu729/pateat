// The popup's **Fill** on a verification page (ADR 0035, amended 2026-11-17): the person
// picks one of the page's matching accounts, and that account's password goes into the
// page's recipe fields once. Pateat presses nothing and asks no model to classify a page
// that has a recipe; the page's own announcement runs the fill (`admitConfirm`).
import { sameLoginDocument, type SettingsResponse } from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import { browser } from "wxt/browser";
import { observedPath } from "../../observation/path";
import type { ConfirmFillRequest, ConfirmFillResponse } from "../manual-wire";
import { frameKey, logCode, siteOf } from "./steps";
import { siteCandidates } from "./choice-save";
import { tabAttempt } from "./hold";
import { terminal } from "./attempt-state";
import { confirmBusy, hasConfirmClaim, pressGenerationKey } from "./confirm-state";
import { confirmRecipeOn, offersGeneration } from "./generation-scope";
import { pagePermission } from "./page-permission";
import { fingerprint, pageRefusal } from "./manual";
import {
  CONFIRM_PICK_MS,
  confirmPickPending,
  endConfirmPick,
  type ConfirmPick,
} from "./confirm-pick-scope";
import type { LiveDocument } from "./types";
import type { Runtime } from "./state";

/**
 * Whether the popup offers **Fill** on this document instead of **Log in now**: its path
 * has a `confirm` or `unclear` recipe, or, without one, it asks for a secret answer and
 * could be sent for generation now, and verification filling is not `off` for its site or
 * profile.
 */
export async function confirmFillPage(
  rt: Runtime,
  live: LiveDocument,
  snapshot: Extract<SettingsResponse, { ok: true }>,
): Promise<boolean> {
  if (pagePermission(snapshot.snapshot.settings, live.url, "confirm").permission !== "fill")
    return false;
  if ((await confirmRecipeOn(rt, live.document.origin, live.path)) !== undefined) return true;
  // A press's page that came back as anything but a verification is not offered again;
  // the press still at work keeps its offer.
  await rt.confirmFill.loaded;
  const pick = rt.confirmFill.picks.get(live.document.tabId);
  const pressing = pick?.active === true && sameLoginDocument(pick.document, live.document);
  if (!pressing && hasConfirmClaim(rt, pressGenerationKey(live))) return false;
  return live.textAnswer === true && (await offersGeneration(rt, live)) === true;
}

/**
 * Asks the tab's page to announce again when the worker knows no document of it and its
 * path has a `confirm` or `unclear` recipe that `confirm` lets fill, so the popup can offer
 * **Fill** there. A restarted worker keeps no document: it asks only the tabs of sites
 * with a saved default or a login record to announce again, and the popup's offer may
 * come before they do. The announcement is the one the page made before the restart.
 */
export async function announceConfirmPage(
  rt: Runtime,
  tabId: number,
  url: string,
  snapshot: Extract<SettingsResponse, { ok: true }>,
): Promise<void> {
  if (rt.documents.has(frameKey({ tabId, frameId: 0 }))) return;
  const page = URL.parse(url);
  if (
    !page ||
    pagePermission(snapshot.snapshot.settings, url, "confirm").permission !== "fill" ||
    (await confirmRecipeOn(rt, page.origin, observedPath(page.pathname))) === undefined
  )
    return;
  // An announcement already under way, as the restarted worker's own reconnect, is enough.
  if (!rt.admitting.has(`${tabId}:0`) && !rt.documents.has(frameKey({ tabId, frameId: 0 })))
    await browser.tabs
      .sendMessage(tabId, { version: 1, type: "login.reconnect" }, { frameId: 0 })
      .catch(() => undefined);
  await rt.admitting.get(`${tabId}:0`)?.catch(() => undefined);
}

/** What holds the tab from a press: any login, account switch or other fill there. */
function fillRefusal(rt: Runtime, live: LiveDocument): string | undefined {
  const { tabId } = live.document;
  const running = tabAttempt(rt, tabId);
  const flow = rt.sso.flows.get(tabId);
  return confirmBusy(rt, tabId) ||
    confirmPickPending(rt, tabId) ||
    rt.attempts.get(tabId)?.running ||
    (running && !terminal(running)) ||
    rt.options.passkeyActive?.(live.document.documentId) ||
    rt.manualStarts.get(tabId)?.pick !== undefined ||
    (flow && !flow.ended) ||
    rt.switchesRunning.has(tabId) ||
    rt.accountPicks.switchingHere(tabId, siteOf(live.document.origin), live.incognito)
    ? "login-running"
    : undefined;
}

/**
 * The person pressed **Fill**: one fill of this exact document and path, with the account
 * they chose, once the document announces again. It overrides a pause and a private
 * window, as an account pick does; every check of a confirmation fill still runs.
 */
export async function confirmPickStart(
  rt: Runtime,
  request: ConfirmFillRequest,
): Promise<ConfirmFillResponse> {
  await rt.vars.loaded;
  await rt.vars.sessionLoaded;
  await rt.confirmFill.loaded;
  const { tabId } = request.document;
  const refuse = (reason: string): ConfirmFillResponse => ({ ok: false, reason: logCode(reason) });
  if (confirmPickPending(rt, tabId)) return refuse("preparing");
  const live = rt.documents.get(frameKey(request.document));
  if (!live || !sameLoginDocument(live.document, request.document)) return refuse("page-changed");
  const check = async () =>
    (await pageRefusal(rt, live)) ??
    fillRefusal(rt, live) ??
    ((await fingerprint(rt, live)) === request.scope ? undefined : "page-changed");
  const refused = await check();
  if (refused) return refuse(refused);
  const snapshot = await rt.settings
    .handle({ version: 1, type: "settings.get" })
    .catch(() => undefined);
  if (!snapshot?.ok) return refuse("settings-unavailable");
  if (!(await confirmFillPage(rt, live, snapshot))) return refuse("not-a-verification-page");
  const found = rt.uris
    ? await siteCandidates(rt, snapshot, live).catch(() => undefined)
    : undefined;
  if (!found || "reason" in found) return refuse(found?.reason ?? "vault-unavailable");
  if (
    !found.candidates.some(
      (entry) => entry.connectionId === request.connectionId && entry.itemId === request.itemId,
    )
  )
    return refuse("not-a-candidate");
  // The page, the tab and a competing press are checked again after every wait above.
  const changed = await check();
  if (changed) return refuse(changed);
  const pick: ConfirmPick = {
    id: newId(),
    document: live.document,
    url: live.url,
    path: live.path,
    topUrl: live.topUrl ?? live.url,
    topDocumentId: rt.documents.get(frameKey({ tabId, frameId: 0 }))?.document.documentId,
    account: {
      origin: live.document.origin,
      connectionId: request.connectionId,
      itemId: request.itemId,
    },
    expiresAt: Date.now() + CONFIRM_PICK_MS,
    status: { requestId: request.requestId, state: "preparing" },
    active: true,
  };
  clearTimeout(rt.confirmFill.picks.get(tabId)?.timer);
  rt.confirmFill.picks.set(tabId, pick);
  pick.timer = setTimeout(() => endConfirmPick(pick, "blocked", "timed-out"), CONFIRM_PICK_MS);
  try {
    // The document's announcement takes the press (`admitConfirm`); it answers once read.
    await browser.tabs.sendMessage(
      tabId,
      { version: 1, type: "login.reconnect" },
      { frameId: live.document.frameId, documentId: live.document.documentId },
    );
    await rt.admitting.get(tabId + ":" + live.document.frameId)?.catch(() => undefined);
  } catch {
    endConfirmPick(pick, "blocked", "unavailable");
    return refuse("unavailable");
  }
  // An announcement that did not take the press, as one refused before it was read, ends it.
  if (pick.active && !pick.taken) {
    const page = rt.documents.get(frameKey(live.document));
    endConfirmPick(
      pick,
      "blocked",
      page?.state !== "denied" || !page.reason
        ? "not-started"
        : // A login that took the tab meanwhile is told as running, as before the press.
          page.reason === "tab-busy"
          ? "login-running"
          : page.reason,
    );
  }
  const { state, reason } = pick.status;
  return state === "blocked" ? refuse(reason ?? "not-started") : { ok: true, state };
}
