import * as v from "valibot";
import type { LoginAttemptMetadata } from "./metadata";

export const identifier = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(/^[a-zA-Z0-9_.:-]+$/),
);
export const integer = (max: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(max));
const milliseconds = v.pipe(v.number(), v.integer(), v.minValue(0));
/**
 * How long a login has taken so far, for the local log (ADR 0019, amended 2026-10-18) and
 * the login record (ADR 0055): `since` when, in epoch milliseconds, the extension saw the
 * page that started it; the milliseconds it waited for the service (`serviceMs`), of that
 * for the network (`networkMs`), for the person (`personMs`) and for the site's answer to
 * its own steps (`pageMs`); and `personSince` and `pageSince` while it waits for the person
 * or the site now, never both. Epoch stamps rather than timers, so the time stored with the
 * record outlives a worker restart; time not yet stored when the worker stops is lost.
 * Never how long a value took to type, which would tell its length.
 */
export const attemptTimingSchema = v.strictObject({
  since: milliseconds,
  serviceMs: milliseconds,
  networkMs: milliseconds,
  personMs: milliseconds,
  pageMs: milliseconds,
  personSince: v.optional(milliseconds),
  pageSince: v.optional(milliseconds),
});
export type AttemptTiming = v.InferOutput<typeof attemptTimingSchema>;
/** Steps and effects an attempt may hold: its route's, plus those of handlers it entered. */
export const MAX_ATTEMPT_STEPS = 40;
export const MAX_ATTEMPT_SUBMISSIONS = 12;
export const MAX_ENTERED_HANDLERS = 4;
/** Pages the model may judge after one effect step (ADR 0027). */
export const MAX_JUDGED_PAGES = 2;
/** The longest path a watch keeps for its own document; a longer one is not kept. */
export const WATCH_PATH_MAX = 2048;
/** Steps and effects a continuation may add: one page of a recipe (ADR 0018). */
export const MAX_RECIPE_STEPS = 32;
export const MAX_RECIPE_EFFECTS = 8;
/** Pages already sent to be judged after effect step `operationId`. */
export const judgedPages = (
  metadata: Pick<LoginAttemptMetadata, "judged">,
  operationId: string | undefined,
): number =>
  operationId !== undefined && metadata.judged?.operationId === operationId
    ? metadata.judged.pages
    : 0;
/**
 * Pages the model may still judge for the attempt's current effect step: while the login
 * is watched (ADR 0027), the watch's own pages, else those after the step. A login watched
 * at its stop (ADR 0036) has no step in flight and names none.
 */
export const pagesLeft = (
  metadata: Pick<LoginAttemptMetadata, "judged" | "watch">,
  operationId: string | undefined,
): number =>
  MAX_JUDGED_PAGES - (metadata.watch ? metadata.watch.pages : judgedPages(metadata, operationId));
export const loginAttemptStateSchema = v.picklist([
  "detected",
  "ready",
  "executing",
  "submit-intent",
  "awaiting-result",
  "reconciling",
  "retryable",
  /**
   * The page after the login's submission showed a step Pateat leaves to the person, such
   * as a code or an app approval (`challenge`): later pages of the tab are only read, until
   * one proves the sign-in or the watch ends (ADR 0027).
   */
  "watching",
  "authenticated",
  "blocked",
]);
/**
 * Whether a login is watched (ADR 0027): a `password` login whose result stopped at
 * `challenge` or settled as unknown, in the tab's page or in a frame (ADR 0086). Later
 * pages of its tab are read for its result.
 */
export const watched = (metadata: { state: string; settled?: true | undefined }) =>
  metadata.state === "watching" || (metadata.state === "reconciling" && metadata.settled === true);
