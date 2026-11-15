import { browser } from "wxt/browser";
import { sameLoginDocument, type LoginDocument } from "@pateat/contracts";
import { frameKey } from "../steps";
import { ssoCurrent } from "../sso-scope";
import type { Runtime } from "../state";
import type { LiveDocument } from "../types";

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
  work.movedAgain = true;
  if (work.moved) return true;
  work.moved = (async () => {
    // A further path event queues one more reading, never a timed or DOM polling loop.
    while (work.movedAgain && ssoCurrent(rt, work, work.live)) {
      work.movedAgain = false;
      const current = work.live;
      work.refresh = current;
      // oxlint-disable-next-line no-await-in-loop -- each iteration is requested by a fresh path signal
      await browser.tabs
        .sendMessage(
          document.tabId,
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
