import type { LoginAttemptMetadata } from "@pateat/contracts";
import { finishedLogin, holdsSite, stoppedByPateat, terminal, watchOver } from "./attempt-state";

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
}

export interface RecordSeen {
  readonly phase: RecordPhase;
  readonly watchEnded?: string | undefined;
  readonly confirm?: boolean | undefined;
  readonly withdrawn?: boolean | undefined;
  readonly rejectedHere?: boolean | undefined;
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
      next: "finished-confirmed" | "submitted-confirmed";
    }
  | { kind: "release-finished"; next: "stopped" }
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
        page.frameId === 0 &&
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
      return {
        kind: "read-confirm",
        read: !rejectedHere && !page.hasTopUrl,
        rejectedHere,
        next: "finished-confirmed",
      };
    }
    case "finished-confirmed":
      return (!page.showsFirstStep || seen.confirm) && !seen.rejectedHere
        ? { kind: "keep-watching", reason: "logged-in" }
        : { kind: "release-finished", next: "stopped" };
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
