// The popup on a verification page, or a page that signs in automatically, that a
// restarted worker does not know yet (ADR 0035, amended 2026-11-17; ADR 0085, amended
// 2026-11-18): the worker keeps the documents it admitted in memory only, and asks only
// the tabs of sites with a saved default or a login record to announce again (`index.ts`).
import type { SettingsResponse } from "@pateat/contracts";
import { browser } from "wxt/browser";
import { observedPath } from "../../observation/path";
import { frameKey } from "./steps";
import { confirmRecipeOn } from "./generation-scope";
import { pagePermission } from "./page-permission";
import type { Runtime } from "./state";

/** The bound on the popup offer's wait for a verification page's announcement. */
export const CONFIRM_ANNOUNCE_MS = 1500;

/** Waits for `work` until `until` at most, whatever it settles as. */
async function within(work: Promise<unknown>, until: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, until - Date.now()));
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps a tab's `login.reconnect` send in `rt.reconnects` while it is in flight. */
export function trackReconnect(
  rt: Runtime,
  tabId: number,
  send: Promise<unknown>,
): Promise<unknown> {
  const sent = send.catch(() => undefined);
  rt.reconnects.tabs.set(tabId, sent);
  void sent.finally(() => {
    if (rt.reconnects.tabs.get(tabId) === sent) rt.reconnects.tabs.delete(tabId);
  });
  return sent;
}

/**
 * Asks the tab's top document to announce again when the worker knows none and the tab's
 * path has a `confirm` or `unclear` recipe that `confirm` lets fill, so the popup can
 * offer **Fill** there, or `sign-in` is `auto` there, so an automatic login or SSO method
 * offer the restarted worker lost is offered again (ADR 0085, amended 2026-11-18). A reconnect already in flight for the tab, the restarted worker's
 * own or another offer's, is waited for instead of sending another. A frame's page, such
 * as a 3-D Secure frame, is not asked. A page that does not answer within
 * `CONFIRM_ANNOUNCE_MS`, as one whose script a dialog blocks, stays unknown.
 */
export async function announceUnknownPage(
  rt: Runtime,
  tabId: number,
  url: string,
  snapshot: Extract<SettingsResponse, { ok: true }>,
): Promise<void> {
  const known = () => rt.documents.has(frameKey({ tabId, frameId: 0 }));
  if (known()) return;
  const page = URL.parse(url);
  const { settings } = snapshot.snapshot;
  if (
    !page ||
    (pagePermission(settings, url, "sign-in").permission !== "auto" &&
      (pagePermission(settings, url, "confirm").permission !== "fill" ||
        (await confirmRecipeOn(rt, page.origin, observedPath(page.pathname))) === undefined))
  )
    return;
  const until = Date.now() + CONFIRM_ANNOUNCE_MS;
  await within(rt.reconnects.sent.promise, until);
  const sending = rt.reconnects.tabs.get(tabId);
  if (sending) await within(sending, until);
  if (!known() && !rt.admitting.has(`${tabId}:0`) && Date.now() < until)
    await within(
      rt.reconnects.tabs.get(tabId) ??
        trackReconnect(
          rt,
          tabId,
          browser.tabs.sendMessage(tabId, { version: 1, type: "login.reconnect" }, { frameId: 0 }),
        ),
      until,
    );
  const admission = rt.admitting.get(`${tabId}:0`);
  if (admission) await within(admission, until);
}
