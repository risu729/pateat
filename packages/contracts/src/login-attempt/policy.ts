import { sameLoginDocument, type LoginDocument } from "../login";
import type { LoginAttemptMetadata } from "./metadata";
import type { LoginAttemptEvent } from "./events";

export const sameScope = (left: LoginDocument, right: LoginDocument) =>
  left.origin === right.origin && left.tabId === right.tabId && left.frameId === right.frameId;
/** A top-level page of the same tab on another origin replaced the attempt's page. */
export const leftOrigin = (left: LoginDocument, right: LoginDocument) =>
  left.frameId === 0 &&
  right.frameId === 0 &&
  left.tabId === right.tabId &&
  left.origin !== right.origin;
/**
 * A new top-level page of the same tab replaced the page around the attempt's frame, as
 * after a sign-in in a frame that hands its result to its page (ADR 0086), whatever origin
 * the new page has.
 */
export const leftFrame = (left: LoginDocument, right: LoginDocument) =>
  left.frameId !== 0 && right.frameId === 0 && left.tabId === right.tabId;
/**
 * Whether a login of an item without a password is watched at its stop with nothing in
 * flight (ADR 0036): its watch's pages are judged, though no step names them.
 */
export const watchedAtStop = (
  context: Pick<LoginAttemptMetadata, "state" | "watch" | "stopAt" | "stepIndex" | "operationId">,
): boolean =>
  context.state === "watching" &&
  context.watch !== undefined &&
  context.stopAt !== undefined &&
  context.stepIndex === context.stopAt &&
  context.operationId === undefined;
/**
 * The current operation may have submitted or changed the page. A fill whose failure
 * confirmed that it changed nothing, or that failed before its intent, waits to be tried
 * again and did not (ADR 0022).
 */
export const maySubmit = (context: LoginAttemptMetadata) =>
  context.mutationIntent === true ||
  (context.operationKind === "fill" && context.retryRequired !== true) ||
  (context.operationKind === "click" && context.submissions > 0);
/**
 * Whether the login stands, with nothing in flight, at its plan's last step on a `password`
 * route of its recipe's own steps, with no handler entered, no stop, no chooser and not
 * only filling: the only step whose click a continued page may replace (ADR 0018
 * amendment of 2026-11-03). That the step is an `advance` click is the runtime's to check.
 */
export const replaceable = (context: LoginAttemptMetadata) =>
  context.operationId === undefined &&
  context.retryRequired !== true &&
  context.route === "password" &&
  context.variant === 0 &&
  context.handlers.length === 0 &&
  context.chooser === undefined &&
  context.stopAt === undefined &&
  context.fillOnly !== true &&
  context.stepIndex + 1 === context.stepCount;
export const operationMatches = (context: LoginAttemptMetadata, event: LoginAttemptEvent) =>
  "operationId" in event && event.operationId === context.operationId;
/**
 * Whether the plan step at `index` comes before the login's stop (ADR 0036): always, but
 * on the `password` route of a login with a stop.
 */
export const beforeStop = (
  context: Pick<LoginAttemptMetadata, "route" | "stopAt">,
  index: number,
): boolean =>
  context.route !== "password" || context.stopAt === undefined || index < context.stopAt;
/**
 * Whether a login of an item without a password stands at its stop (ADR 0036) with nothing
 * in flight, after it submitted the steps before it, and may still act there: answer the
 * page's passkey request, judge the page or enter a `passkey` handler before the stop.
 */
export const atStop = (context: LoginAttemptMetadata) =>
  context.route === "password" &&
  context.stopAt !== undefined &&
  context.stepIndex === context.stopAt &&
  context.operationId === undefined &&
  context.retryRequired !== true &&
  context.fillOnly !== true &&
  context.submissions > 0;
/**
 * Whether a move to another origin may complete the login (ADR 0022): its current
 * operation may have submitted, or it stands at its stop after a submission (ADR 0036).
 */
export const maySignIn = (context: LoginAttemptMetadata) => maySubmit(context) || atStop(context);
/**
 * Whether the login's stop lies just past its plan's last step (ADR 0036): its route fills
 * no password and ends with an `advance`, so no step is there.
 */
export const stopsPastPlan = (
  context: Pick<LoginAttemptMetadata, "route" | "stopAt" | "stepCount">,
) => context.route === "password" && context.stopAt === context.stepCount;
/**
 * The submissions the attempt's steps may spend. A stop just past the plan's last step
 * keeps one of `maxSubmissions` for its passkey answer (`STOP_ANSWERED`, ADR 0036), which
 * a recipe's budget never counts: no step, handler or page's own submission spends it.
 */
export const stepBudget = (
  context: Pick<LoginAttemptMetadata, "route" | "stopAt" | "stepCount" | "maxSubmissions">,
) => context.maxSubmissions - (stopsPastPlan(context) ? 1 : 0);
/** The current operation is a click or a fill that advances or submits. */
export const effectfulOperation = (context: LoginAttemptMetadata) =>
  context.operationKind === "click" ||
  context.operationEffect === "advance" ||
  context.operationEffect === "submit";
export const confirmedNoMutation = (context: LoginAttemptMetadata, event: LoginAttemptEvent) =>
  event.type === "FAILED" &&
  event.mutation === "none" &&
  operationMatches(context, event) &&
  event.document !== undefined &&
  sameLoginDocument(context.document, event.document);

/** A fill's values the page would not accept, for this fill (ADR 0010). */
export const valueRejected = (context: LoginAttemptMetadata, event: LoginAttemptEvent) =>
  event.type === "VALUE_REJECTED" &&
  operationMatches(context, event) &&
  context.operationKind === "fill" &&
  sameLoginDocument(context.document, event.document) &&
  // Only a preparing fill is checked after filling; an effectful one has submitted,
  // unless it is a code the page kept a character of out.
  (event.stage === "before-fill" ||
    (event.stage === "after-fill"
      ? context.operationEffect === "prepare"
      : context.operationEffect === "submit")) &&
  !(event.challenge === true && event.stage !== "before-fill");
