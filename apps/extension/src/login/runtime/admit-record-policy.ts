import { finishedLogin, stoppedByPateat, type LoginAttemptMetadata } from "@pateat/contracts";
import { holdsSite, terminal, watchOver } from "./attempt-state";
import { RESULT_CORRECTION_MS } from "./constants";

/** Each phase is visited once, preserving the order of the asynchronous record effects. */
export type RecordPhase =
  | "fill-only"
  | "watch"
  | "abandon-watch"
  | "pause"
  | "finished"
  | "finished-confirmed"
  | "stopped"
  | "submitted"
  | "submitted-confirmed"
  | "submitted-withdrawn"
  | "done";

export interface RecordPage {
  readonly frameId: number;
  readonly documentId: string;
  readonly showsFirstStep: boolean;
  readonly hasTopUrl: boolean;
  readonly paused: boolean;
  readonly probe: boolean;
  readonly pickedAttemptId: string | undefined;
  /** An account switch from the popup runs in the tab or waits for its login page. */
  readonly switching?: boolean;
  /** The tab holds an account picked in the popup, for this login or a later one. */
  readonly picked?: boolean;
  /**
   * When the tab's stored record of this login last changed (`changedAt`): a record read
   * from its running login does not carry it, and one a resumed login carries may be older
   * than the stored one, which each change updates.
   */
  readonly recordedAt?: number | undefined;
}

export interface RecordSeen {
  readonly phase: RecordPhase;
  readonly watchEnded?: string | undefined;
  readonly confirm?: boolean | undefined;
  readonly withdrawn?: boolean | undefined;
  readonly rejectedHere?: boolean | undefined;
  readonly correctedHere?: boolean | undefined;
}

export type RecordStep =
  | { kind: "advance"; next: RecordPhase }
  | { kind: "forget-fill-only"; next: "watch" }
  | { kind: "end-watch"; next: "abandon-watch" }
  | { kind: "abandon-watch"; next: "pause" }
  | { kind: "stop-paused"; next: "finished" }
  | {
      kind: "read-confirm";
      read: boolean;
      rejectedHere: boolean;
      /** A completion its own document's sign-in form corrects (ADR 0029, 2026-11-03). */
      correctedHere?: boolean;
      next: "finished-confirmed" | "submitted-confirmed";
    }
  | { kind: "release-finished"; corrected: boolean; next: "stopped" }
  | { kind: "release-stopped"; next: "submitted" }
  | { kind: "read-withdrawn"; read: boolean; next: "submitted-withdrawn" }
  | { kind: "ask-after-stop"; next: "done" }
  | { kind: "keep-watching"; reason: "logged-in" | "login-stopped" }
  | { kind: "done" };

/**
 * Decide one record phase from snapshots. The caller performs any read or write,
 * checks that its document is still current, then supplies the result at `next`.
 * A read phase remains explicit even when its branch skips the actual read, so the
 * caller retains the original stale-document check at that boundary.
 */
export function nextRecordStep(
  recorded: LoginAttemptMetadata | undefined,
  page: RecordPage,
  seen: RecordSeen,
  now: number,
): RecordStep {
  if (!recorded) return { kind: "done" };
  switch (seen.phase) {
    case "fill-only":
      return recorded.fillOnly && terminal(recorded)
        ? { kind: "forget-fill-only", next: "watch" }
        : { kind: "advance", next: "watch" };
    case "watch":
      return watchOver(recorded, now)
        ? { kind: "end-watch", next: "abandon-watch" }
        : { kind: "advance", next: "abandon-watch" };
    case "abandon-watch":
      return recorded.watch &&
        page.frameId === recorded.document.frameId &&
        page.showsFirstStep &&
        page.documentId !== recorded.watch.documentId
        ? { kind: "abandon-watch", next: "pause" }
        : { kind: "advance", next: "pause" };
    case "pause":
      return page.paused &&
        !terminal(recorded) &&
        recorded.watch === undefined &&
        page.pickedAttemptId !== recorded.id
        ? { kind: "stop-paused", next: "finished" }
        : { kind: "advance", next: "finished" };
    case "finished": {
      if (!finishedLogin(recorded) || recorded.document.frameId !== 0 || page.frameId !== 0)
        return { kind: "advance", next: "stopped" };
      const rejectedHere =
        recorded.outcome === "credential-rejected" &&
        recorded.document.documentId === page.documentId;
      // A login that completed in this document shortly before it shows the sign-in form
      // again did not sign in: its result was read at once and is corrected, not taken for
      // a logout (ADR 0029, amended 2026-11-03). A switch or a pick of the person's own
      // logs in as before.
      const age = now - (page.recordedAt ?? recorded.changedAt ?? Number.NEGATIVE_INFINITY);
      const correctedHere =
        recorded.state === "authenticated" &&
        recorded.document.documentId === page.documentId &&
        page.showsFirstStep &&
        !page.switching &&
        (!page.picked || page.pickedAttemptId === recorded.id) &&
        // A clock set back corrects nothing.
        age >= 0 &&
        age < RESULT_CORRECTION_MS;
      return {
        kind: "read-confirm",
        read: !rejectedHere && !page.hasTopUrl,
        rejectedHere,
        ...(correctedHere ? { correctedHere } : {}),
        next: "finished-confirmed",
      };
    }
    case "finished-confirmed":
      return (!page.showsFirstStep || seen.confirm) && !seen.rejectedHere
        ? { kind: "keep-watching", reason: "logged-in" }
        : {
            kind: "release-finished",
            corrected: seen.correctedHere === true && !seen.rejectedHere,
            next: "stopped",
          };
    case "stopped":
      return stoppedByPateat(recorded) &&
        !finishedLogin(recorded) &&
        recorded.outcome !== "account-switched" &&
        recorded.submissions === 0 &&
        recorded.document.documentId !== page.documentId
        ? { kind: "release-stopped", next: "submitted" }
        : { kind: "advance", next: "submitted" };
    case "submitted":
      return recorded.state === "blocked" &&
        !finishedLogin(recorded) &&
        recorded.outcome !== "account-switched" &&
        recorded.submissions > 0 &&
        recorded.document.frameId === 0 &&
        page.frameId === 0 &&
        (recorded.document.documentId !== page.documentId ||
          (seen.watchEnded !== undefined && seen.watchEnded !== page.documentId)) &&
        !holdsSite(recorded, now)
        ? {
            kind: "read-confirm",
            read: !page.hasTopUrl,
            rejectedHere: false,
            next: "submitted-confirmed",
          }
        : { kind: "advance", next: "done" };
    case "submitted-confirmed":
      return {
        kind: "read-withdrawn",
        read: !page.showsFirstStep && !seen.confirm && !page.probe,
        next: "submitted-withdrawn",
      };
    case "submitted-withdrawn":
      return (!page.showsFirstStep || seen.confirm) && !seen.withdrawn
        ? { kind: "keep-watching", reason: "login-stopped" }
        : { kind: "ask-after-stop", next: "done" };
    case "done":
      return { kind: "done" };
  }
}
