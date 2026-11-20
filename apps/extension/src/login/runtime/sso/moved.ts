import { browser } from "wxt/browser";
import { sameLoginDocument, type LoginDocument } from "@pateat/contracts";
import { frameKey } from "../steps";
import { ssoCurrent, ssoReturnOrigin } from "../sso-scope";
import type { SsoWork } from "../sso-state";
import type { Runtime } from "../state";
import type { LiveDocument } from "../types";

/**
 * Asks the flow's current top document to announce again, once per signal: a further
 * signal while it is asked queues one more, never a timed or DOM polling loop.
 */
function reannounce(rt: Runtime, work: SsoWork, tabId: number) {
  work.movedAgain = true;
  if (work.moved) return;
  work.moved = (async () => {
    while (work.movedAgain && ssoCurrent(rt, work, work.live)) {
      work.movedAgain = false;
      const current = work.live;
      work.refresh = current;
      // oxlint-disable-next-line no-await-in-loop -- each iteration is requested by a fresh signal
      await browser.tabs
        .sendMessage(
          tabId,
          { version: 1, type: "login.reconnect" },
          { frameId: 0, documentId: current.document.documentId },
        )
        .catch(() => undefined);
      if (work.refresh === current) delete work.refresh;
    }
  })().finally(() => {
    delete work.moved;
    delete work.movedAgain;
  });
}

/**
 * The tab's URL is `url` while the flow waits on an RP page after the IdP: a page that
 * changed its URL in place, as a site's portal routing from its callback to its signed-in
 * page does, is asked to announce again, so it is read as it now shows (ADR 0026,
 * amendment of 2026-11-20). A new document announces by itself; asking the old one fails.
 */
export function ssoReturnMoved(rt: Runtime, tabId: number, url: string | undefined) {
  const work = rt.sso.flows.get(tabId);
  const live = work?.live;
  if (
    !work ||
    !live ||
    work.ended ||
    !["at-idp", "returning-rp"].includes(work.phase) ||
    live.document.frameId !== 0 ||
    !ssoReturnOrigin(work, live.document.origin) ||
    url === undefined ||
    URL.parse(url)?.origin !== live.document.origin ||
    url === live.url ||
    !ssoCurrent(rt, work, live)
  )
    return false;
  reannounce(rt, work, tabId);
  return true;
}

/** A path signal only re-admits its exact IdP document; it grants no effect. */
export function ssoMoved(rt: Runtime, document: LoginDocument, token: string): boolean {
  const work = rt.sso.flows.get(document.tabId);
  if (!work) return false;
  const live = rt.documents.get(frameKey(document));
  const incognito = rt.incognitoTabs.get(document.tabId);
  if (
    !live ||
    (incognito !== undefined && incognito !== live.incognito) ||
    live.incognito !== work.rpLive.incognito ||
    document.frameId !== 0 ||
    document.origin !== work.selected.origin ||
    live.token !== token ||
    !sameLoginDocument(live.document, document) ||
    !sameLoginDocument(work.live.document, document) ||
    !ssoCurrent(rt, work, live)
  )
    return true;
  reannounce(rt, work, document.tabId);
  return true;
}

/** One normal re-admission may replace the same-document native child's old URL. */
export function ssoRefresh(
  rt: Runtime,
  old: LiveDocument | undefined,
  document: LoginDocument,
  token: string,
  url: string,
): boolean {
  const work = rt.sso.flows.get(document.tabId);
  const incognito = rt.incognitoTabs.get(document.tabId);
  if (
    !work ||
    !old ||
    (incognito !== undefined && incognito !== old.incognito) ||
    old.incognito !== work.rpLive.incognito ||
    work.refresh !== old ||
    document.frameId !== 0 ||
    document.origin !== work.selected.origin ||
    old.token !== token ||
    old.url === url ||
    !sameLoginDocument(old.document, document) ||
    !ssoCurrent(rt, work, old)
  )
    return false;
  delete work.refresh;
  return true;
}
