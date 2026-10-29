import { WATCH_PATH_MAX, type LoginAttemptMetadata } from "@pateat/contracts";
import { HOLD_MS, WATCH_MS } from "./constants";
import { type Execution } from "./types";
import { pathNow } from "./steps";

/** Whether a record holds its origin against other tabs at `now` (ADR 0022). */
export const holdsSite = (entry: LoginAttemptMetadata, now: number) =>
  entry.state !== "authenticated" &&
  // A fill-only login never submits (ADR 0021 D).
  !entry.fillOnly &&
  // A login interrupted before anything was submitted never submits.
  !(entry.state === "blocked" && entry.outcome === "interrupted" && !entry.submissions) &&
  !stoppedByPateat(entry) &&
  // A clock set back ends the hold rather than prolonging it.
  now - (entry.changedAt ?? 0) >= 0 &&
  now - (entry.changedAt ?? 0) < HOLD_MS;

/**
 * Whether a record holds its origin against the site's other tabs at `now` (ADR 0022): as
 * {@link holdsSite}, and a watched login for as long as its watch, as while its tab waits
 * for a code, so a second tab does not log in and send a second code (owner, 2026-10-23).
 */
export const holdsOthers = (entry: LoginAttemptMetadata, now: number) =>
  holdsSite(entry, now) || (entry.watch !== undefined && !watchOver(entry, now));

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

export const terminal = (metadata: LoginAttemptMetadata) =>
  ["authenticated", "blocked"].includes(metadata.state);

/**
 * A login with no step left to run: its result settled as unknown, or it is watched after a
 * `challenge` (ADR 0027). Its later pages are checked, but it is not a login in progress.
 */
export const idle = (metadata: LoginAttemptMetadata) =>
  metadata.settled === true || metadata.state === "watching";

/**
 * Whether a login of an item without a password stands at its stop with nothing in flight
 * (ADR 0036): the step there fills the password, so it never runs, or the stop lies just
 * past the plan's last step and no step is there.
 */
export const atStop = (metadata: LoginAttemptMetadata) =>
  metadata.route === "password" &&
  metadata.stopAt !== undefined &&
  metadata.stepIndex === metadata.stopAt &&
  metadata.operationId === undefined;

/** Whether such a login answered a passkey request at its stop (`STOP_ANSWERED`). */
export const answeredAtStop = (metadata: LoginAttemptMetadata) =>
  metadata.route === "password" &&
  metadata.stopAt !== undefined &&
  metadata.stepIndex === metadata.stopAt &&
  metadata.operationId !== undefined;

/** Whether the plan step at `index` lies past such a login's stop. */
export const pastStop = (metadata: LoginAttemptMetadata, index: number) =>
  metadata.route === "password" && metadata.stopAt !== undefined && index > metadata.stopAt;

/**
 * Whether such a login's stop lies just past its plan's last step (ADR 0036): its route
 * fills no password and ends with an `advance`, as a recipe whose page after the identifier
 * is not generated yet. The page that advance leads to is the stop's.
 */
export const stopsPastPlan = (metadata: LoginAttemptMetadata) =>
  metadata.route === "password" && metadata.stopAt === metadata.stepCount;

/** Whether the step in flight is the final `advance` that leads to such a stop. */
export const advancingToStop = (metadata: LoginAttemptMetadata) =>
  stopsPastPlan(metadata) &&
  metadata.operationId !== undefined &&
  metadata.operationEffect === "advance" &&
  metadata.stepIndex + 1 === metadata.stopAt;

/**
 * Whether a login whose result settled as unknown runs in the document its watch began in
 * (ADR 0027), which was already read for that result.
 */
export const settledHere = (run: Execution) =>
  run.metadata.state === "reconciling" &&
  run.metadata.settled === true &&
  run.metadata.watch?.documentId === run.live.document.documentId;

/** Whether a login's watch is over at `now`; a clock set back ends it too (ADR 0027). */
export const watchOver = (metadata: LoginAttemptMetadata, now: number) =>
  metadata.watch !== undefined &&
  (now - metadata.watch.since >= WATCH_MS || now < metadata.watch.since);

/**
 * Whether a login is watched (ADR 0027) in the top document its watch began in, the watch
 * still lasts, and that document took another route in place than the one the login was
 * last read on: that route is read once as the tab's next page (ADR 0027 amendment of
 * 2026-10-25).
 */
export const routedHere = (run: Execution) =>
  run.live.document.frameId === 0 &&
  (run.metadata.state === "watching" || settledHere(run)) &&
  run.metadata.watch?.documentId === run.live.document.documentId &&
  run.metadata.watch.path !== undefined &&
  run.metadata.watch.path !== pathNow(run.live) &&
  // A path too long to keep reads no route, as the watch could not record it.
  pathNow(run.live).length <= WATCH_PATH_MAX &&
  !watchOver(run.metadata, Date.now());

/** The step may have submitted or moved the page, so its result can show a handler. */
export const effectful = (metadata: LoginAttemptMetadata) =>
  metadata.operationKind === "click" ||
  metadata.operationEffect === "advance" ||
  metadata.operationEffect === "submit";
