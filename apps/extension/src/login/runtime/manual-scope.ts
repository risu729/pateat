import { sameLoginDocument, type LoginDocument } from "@pateat/contracts";
import type { ManualStatus } from "../manual-wire";
import type { PickedAccount } from "./session-schemas";
import type { LiveDocument } from "./types";
import type { Runtime } from "./state";
import { frameKey } from "./steps";

/** Pending permission is local to one exact page and expires even if that page stops answering. */
export const MANUAL_START_MS = 5 * 60_000;
export type ManualStart = {
  document: LoginDocument;
  url: string;
  path: string;
  topUrl: string;
  topDocumentId: string | undefined;
  expiresAt: number;
  status: ManualStatus;
  pick?: PickedAccount;
  generated?: boolean;
  timer?: ReturnType<typeof setTimeout>;
};

export function manualPending(rt: Runtime, live: LiveDocument): ManualStart | undefined {
  const request = rt.manualStarts.get(live.document.tabId);
  if (!request || !request.pick || request.pick.attemptId !== undefined) return undefined;
  if (rt.picked.get(live.document.tabId) !== request.pick) return undefined;
  const top = rt.documents.get(frameKey({ tabId: live.document.tabId, frameId: 0 }));
  if (request.document.frameId !== live.document.frameId) {
    if (
      live.document.frameId === 0 &&
      (request.topUrl !== live.url || request.topDocumentId !== live.document.documentId)
    )
      endManual(rt, live.document.tabId, "page-changed", request);
    return undefined;
  }
  if (
    Date.now() >= request.expiresAt ||
    !sameLoginDocument(request.document, live.document) ||
    request.url !== live.url ||
    request.path !== live.path ||
    (live.document.frameId !== 0 &&
      (request.topUrl !== live.topUrl || request.topDocumentId !== top?.document.documentId))
  ) {
    endManual(
      rt,
      live.document.tabId,
      Date.now() >= request.expiresAt ? "timed-out" : "page-changed",
      request,
    );
    return undefined;
  }
  return request;
}

/** Drops pending authority; the retained page identity and result only describe this request. */
export function endManual(
  rt: Runtime,
  tabId: number,
  reason?: string,
  expected?: ManualStart,
): void {
  const request = rt.manualStarts.get(tabId);
  if (!request || (expected && request !== expected)) return;
  clearTimeout(request.timer);
  const pick = request.pick;
  if (pick && pick.attemptId === undefined && rt.picked.get(tabId) === pick)
    rt.picked.delete(tabId);
  delete request.pick;
  delete request.timer;
  request.status = reason
    ? { requestId: request.status.requestId, state: "blocked", reason: reason.slice(0, 100) }
    : { requestId: request.status.requestId, state: "started" };
}

export function manualGenerating(rt: Runtime, live: LiveDocument): void {
  const request = manualPending(rt, live);
  if (request) request.status = { requestId: request.status.requestId, state: "generating" };
}
