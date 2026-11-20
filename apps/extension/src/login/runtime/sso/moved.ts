import { browser } from "wxt/browser";
import { sameLoginDocument, type LoginDocument } from "@pateat/contracts";
import { frameKey } from "../steps";
import { send } from "../attempt";
import { DESCRIBED_WATCHES, WATCH_MS } from "../constants";
import { ssoCurrent, ssoReturnOrigin } from "../sso-scope";
import type { SsoWork } from "../sso-state";
import type { Runtime } from "../state";
import type { LiveDocument } from "../types";

/**
 * Asks the flow's current top document to announce again, once per signal: a further
 * signal while it is asked queues one more, never a timed or DOM polling loop.
 */
function reannounce(rt: Runtime, work: SsoWork, tabId: number) {
  // An RP page being read, whose sign-in may be being written, is asked after its reading:
  // its announcement would replace the document the write's fence holds (ADR 0026,
  // amendment of 2026-11-20).
  const reading = work.reading;
  if (reading) {
    void reading.then(() => {
      if (!work.ended) reannounce(rt, work, tabId);
      return undefined;
    });
    return;
  }
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

/**
 * An IdP document refused as one the tab left (`idp:left`) that is still the tab's
 * document, as an IdP's own routing replaced its URL while it was read, is asked once to
 * announce again, so it is read at its new URL rather than leave the flow waiting (ADR
 * 0026, amendment of 2026-11-20). A document the tab really left cannot answer.
 */
export function reconnectLeft(rt: Runtime, work: SsoWork, live: LiveDocument) {
  if (
    work.leftAsked === live.document.documentId ||
    rt.documents.get(frameKey(live.document)) !== live ||
    !ssoCurrent(rt, work, live)
  )
    return;
  work.leftAsked = live.document.documentId;
  work.refresh = live;
  void browser.tabs
    .sendMessage(
      live.document.tabId,
      { version: 1, type: "login.reconnect" },
      { frameId: 0, documentId: live.document.documentId },
    )
    .catch(() => undefined);
}

/** The longest an SSO flow lasts (`sso-expired`). */
export const SSO_FLOW_MS = 600_000;
/**
 * Asks a waiting RP page that describes nothing yet to say once it describes something
 * (`login.extract.watch`), at most `DESCRIBED_WATCHES` times per document, for no longer
 * than the flow lasts: a page that renders its signed-in view in place, without a new URL,
 * is then read again (ADR 0026, amendment of 2026-11-20).
 */
export function watchReturn(rt: Runtime, work: SsoWork, live: LiveDocument) {
  if (live.document.frameId !== 0 || work.ended) return;
  const asked = work.watched?.documentId === live.document.documentId ? work.watched.count : 0;
  const left = work.startedAt + SSO_FLOW_MS - Date.now();
  if (asked >= DESCRIBED_WATCHES || left <= 0) return;
  work.watched = { documentId: live.document.documentId, count: asked + 1 };
  void send(rt, live, {
    type: "login.extract.watch",
    timeoutMs: Math.min(Math.ceil(left), WATCH_MS),
    shown: true,
  }).catch(() => undefined);
}

/** The watched RP page describes something now: it is asked to announce again. */
export function ssoDescribed(rt: Runtime, document: LoginDocument, token: string): boolean {
  const work = rt.sso.flows.get(document.tabId);
  const live = work?.live;
  if (!work || !live || work.watched?.documentId !== document.documentId) return false;
  if (
    !work.ended &&
    ["at-idp", "returning-rp"].includes(work.phase) &&
    live.token === token &&
    sameLoginDocument(live.document, document) &&
    ssoReturnOrigin(work, live.document.origin) &&
    ssoCurrent(rt, work, live)
  )
    reannounce(rt, work, document.tabId);
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
