// The person's **Fill** on a verification page from the popup (ADR 0035, amended
// 2026-11-17): one press grants one fill of one document and path with the account they
// chose, never a press of the page's buttons.
import { sameLoginDocument, type LoginDocument } from "@pateat/contracts";
import type { ConfirmFillStatus } from "../manual-wire";
import { frameKey } from "./steps";
import type { LiveDocument } from "./types";
import type { Runtime } from "./state";

/** A press's authority is local to one exact page, and expires even if it never answers. */
export const CONFIRM_PICK_MS = 5 * 60_000;

export type ConfirmPick = {
  /** This press's own identity: its claims and its fill's attempt ID carry it. */
  id: string;
  document: LoginDocument;
  url: string;
  path: string;
  topUrl: string;
  topDocumentId: string | undefined;
  account: { origin: string; connectionId: string; itemId: string };
  expiresAt: number;
  status: ConfirmFillStatus;
  /** Whether the press is still authority to fill; an ended press keeps its status only. */
  active: boolean;
  /** The document's announcement took the press and started its work. */
  taken?: true;
  /** The press already sent its page for generation, which it does once at most. */
  generated?: true;
  timer?: ReturnType<typeof setTimeout>;
};

/** Whether the tab's press waits for exactly this document, before its announcement is read. */
export function confirmPickWaits(rt: Runtime, document: LoginDocument): boolean {
  const pick = rt.confirmFill.picks.get(document.tabId);
  return (
    pick?.active === true &&
    Date.now() < pick.expiresAt &&
    sameLoginDocument(pick.document, document)
  );
}

/** The press that may fill this announcement, if any; a changed page ends it. */
export function confirmPickFor(rt: Runtime, live: LiveDocument): ConfirmPick | undefined {
  const pick = rt.confirmFill.picks.get(live.document.tabId);
  if (!pick?.active) return undefined;
  const top = rt.documents.get(frameKey({ tabId: live.document.tabId, frameId: 0 }));
  if (pick.document.frameId !== live.document.frameId) {
    // The tab's page itself moved on: the press for its frame ends with it.
    if (
      live.document.frameId === 0 &&
      (pick.topUrl !== live.url || pick.topDocumentId !== live.document.documentId)
    )
      endConfirmPick(pick, "blocked", "page-changed");
    return undefined;
  }
  if (
    Date.now() >= pick.expiresAt ||
    !sameLoginDocument(pick.document, live.document) ||
    pick.url !== live.url ||
    pick.path !== live.path ||
    (live.document.frameId !== 0 &&
      (pick.topUrl !== live.topUrl || pick.topDocumentId !== top?.document.documentId))
  ) {
    endConfirmPick(pick, "blocked", Date.now() >= pick.expiresAt ? "timed-out" : "page-changed");
    return undefined;
  }
  return pick;
}

/** Ends a press: it fills nothing more, and the popup reads how it ended. */
export function endConfirmPick(
  pick: ConfirmPick,
  state: Exclude<ConfirmFillStatus["state"], "preparing" | "generating" | "asked">,
  reason?: string,
): void {
  clearTimeout(pick.timer);
  delete pick.timer;
  if (!pick.active) return;
  pick.active = false;
  pick.status = {
    requestId: pick.status.requestId,
    state,
    ...(reason ? { reason: reason.slice(0, 100) } : {}),
  };
}

const heldKey = (live: LiveDocument) => `${live.document.tabId} ${live.document.documentId}`;

/**
 * The press sent this document's page for generation: whatever comes back, the document
 * starts no login on that path, so a press never leads to a login that presses buttons.
 */
export function holdPressed(rt: Runtime, live: LiveDocument): void {
  rt.confirmFill.held.set(heldKey(live), live.path);
}

/** Whether a press's generation holds this document on its current path. */
export const pressHeld = (rt: Runtime, live: LiveDocument): boolean =>
  rt.confirmFill.held.get(heldKey(live)) === live.path;

/** Whether the tab holds a press that has not ended. */
export const confirmPickPending = (rt: Runtime, tabId: number): boolean =>
  rt.confirmFill.picks.get(tabId)?.active === true;
