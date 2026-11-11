import { WATCH_PATH_MAX, holdsOrigin, type LoginAttemptMetadata } from "@pateat/contracts";
import { HOLD_MS, SITE_WAIT_MS, WATCH_MS } from "./constants";
import { type Execution } from "./types";
import { pathNow } from "./steps";

/** Whether a record holds its origin against other tabs at `now` (ADR 0022). */
export const holdsSite = (entry: LoginAttemptMetadata, now: number) =>
  holdsOrigin(entry) &&
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

export const terminal = (metadata: LoginAttemptMetadata) =>
  ["authenticated", "blocked"].includes(metadata.state);

/** A passive run may yield only at its explicit read-only wait, never during planning or filling. */
export const passiveFillWaiting = (
  metadata: LoginAttemptMetadata,
  run?: Pick<Execution, "metadata" | "fillWaiting">,
): boolean =>
  metadata.signInFill === true &&
  metadata.state === "ready" &&
  metadata.operationId === undefined &&
  metadata.mutationIntent !== true &&
  metadata.submissions === 0 &&
  metadata.watch === undefined &&
  (!run || (run.metadata.id === metadata.id && run.fillWaiting === true));

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

/**
 * When a login's wait for the site's answer to its step ran out, if it did by `now` (ADR
 * 0022, amended 2026-11-03): `SITE_WAIT_MS` after it began, or `now` when the clock was set
 * back before its start. Undefined while it may still last, or when none runs.
 */
export const siteWaitOver = (metadata: LoginAttemptMetadata, now: number) => {
  if (metadata.signInFill && !terminal(metadata)) {
    const since = metadata.fillSince ?? 0;
    return now < since ? now : now >= since + WATCH_MS ? since + WATCH_MS : undefined;
  }
  const since = metadata.timing.pageSince;
  if (since === undefined || terminal(metadata)) return undefined;
  if (now < since) return now;
  return now >= since + SITE_WAIT_MS ? since + SITE_WAIT_MS : undefined;
};

/** Whether a login's watch is over at `now`; a clock set back ends it too (ADR 0027). */
export const watchOver = (metadata: LoginAttemptMetadata, now: number) =>
  metadata.watch !== undefined &&
  (now - metadata.watch.since >= WATCH_MS || now < metadata.watch.since);

/** The watch's end, including a clock reset, unless the login already ended. */
export const watchEndedAt = (metadata: LoginAttemptMetadata, now: number) =>
  !terminal(metadata) && watchOver(metadata, now)
    ? Math.min(now, metadata.watch!.since + WATCH_MS)
    : undefined;

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

/**
 * Whether a watched login's top document, whose judged page described nothing as a page
 * still loading does, has since shown something to describe while the watch still lasts:
 * that page is read once as the tab's next page (ADR 0027 amendment of 2026-11-04), in
 * the document the watch began in or a later one.
 */
export const describedHere = (run: Execution) =>
  run.live.document.frameId === 0 &&
  run.described === run.live.document.documentId &&
  (run.metadata.state === "watching" ||
    (run.metadata.state === "reconciling" && run.metadata.settled === true)) &&
  !watchOver(run.metadata, Date.now());

/** The step may have submitted or moved the page, so its result can show a handler. */
export const effectful = (metadata: LoginAttemptMetadata) =>
  metadata.operationKind === "click" ||
  metadata.operationEffect === "advance" ||
  metadata.operationEffect === "submit";
