import { type LoginAttemptMetadata } from "./login-attempt";

/**
 * A login Pateat itself stopped with nothing in flight: a withdrawn authorization, a
 * cancel, a value the page would not take, another account shown, or retries spent on
 * failures that changed nothing. It does not hold the origin against other tabs (ADR
 * 0022). A refusal by the site, a second-factor challenge, a submission limit, an
 * operation the page may have received or a result that may still arrive keeps holding.
 */
export const stoppedByPateat = (metadata: LoginAttemptMetadata) =>
  metadata.state === "blocked" &&
  ([
    "policy-changed",
    "value-mismatch",
    "wrong-account",
    "account-switched",
    "retry-limit",
    // Nothing on a chooser's list fit the account (ADR 0028); nothing was clicked.
    "account-not-listed",
  ].includes(metadata.outcome ?? "") ||
    // A frame login whose page went away also ends `cancelled`; after a submission that
    // is the tab leaving, which holds like `interrupted`.
    (metadata.outcome === "cancelled" && metadata.submissions === 0)) &&
  metadata.mutationIntent !== true &&
  metadata.settled !== true &&
  !(metadata.operationKind === "click" && metadata.operationId !== undefined);

/** A fill the page may submit by itself was in flight with its keys allowed. */
const pressing = (entry: LoginAttemptMetadata) =>
  entry.operationPresses === true &&
  entry.operationKind === "fill" &&
  entry.operationId !== undefined &&
  entry.mutationIntent === true;

/**
 * Whether a record, by what it holds and not by how long ago it changed, holds its origin
 * against other tabs (ADR 0022). The runtime adds the time limit.
 */
export const holdsOrigin = (entry: LoginAttemptMetadata) =>
  entry.state !== "authenticated" &&
  // A fill-only login never submits (ADR 0021 D).
  !entry.fillOnly &&
  !entry.signInFill &&
  // A login interrupted, or whose tab left the origin, before anything was submitted
  // never submits: a filled username or password alone sent nothing (owner, 2026-11-09).
  // A fill the page may have submitted by itself, as a PIN pad does at its last key, is
  // no such fill while it was in flight.
  !(
    entry.state === "blocked" &&
    (entry.outcome === "interrupted" || entry.outcome === "left-origin") &&
    !entry.submissions &&
    !pressing(entry)
  ) &&
  !stoppedByPateat(entry);

/**
 * A login that ended with a result, or that ended when the tab left its origin (ADR 0022);
 * its first step showing again in the tab's page releases its record, and the page logs in
 * again as on any visit (ADR 0062), or asks after a rejection. A switch, a stop, or a
 * result still being reconciled does not.
 */
export const finishedLogin = (metadata: LoginAttemptMetadata) =>
  metadata.state === "authenticated" ||
  (metadata.state === "blocked" &&
    ["credential-rejected", "wrong-account", "left-origin", "interrupted"].includes(
      metadata.outcome ?? "",
    ));
