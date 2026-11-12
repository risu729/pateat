import * as v from "valibot";
import { transition } from "xstate";
import {
  parseLoginRecipe,
  routeSteps,
  sameLoginDocument,
  type ChooserClick,
  type LoginAccount,
  type LoginDocument,
  type LoginItemFacts,
  type LoginRecipe,
  type LoginRouteChoice,
} from "./login";
import {
  type AttemptTiming,
  MAX_ATTEMPT_SUBMISSIONS,
  MAX_ATTEMPT_STEPS,
  watched,
} from "./login-attempt/schema-primitives";
import { type LoginAttemptMetadata, parseAttemptMetadata } from "./login-attempt/metadata";
import { loginAttemptEventSchema } from "./login-attempt/events";
import { sameScope, replaceable, maySubmit } from "./login-attempt/policy";
import { loginAttemptMachine } from "./login-attempt/machine";
import { followPage, awaitPerson, personAnswered } from "./login-attempt/timing";

export function createAttemptMetadata(input: {
  id: string;
  recipe: LoginRecipe;
  policyRevision: number;
  account: LoginAccount;
  /** The route and variant chosen when the login starts. */
  choice: LoginRouteChoice;
  /**
   * For a `passkey` route that answers the start page's request: the password variant it
   * falls back to (ADR 0034).
   */
  fallback?: number;
  facts: LoginItemFacts;
  document: LoginDocument;
  /** The origin of the tab's page, for a frame's login. */
  pageOrigin?: string;
  accountSwitched?: boolean;
  fillOnly?: boolean;
  signInFill?: boolean;
  fillPermissionSource?: "site" | "default";
  /** For a chooser recipe's login (ADR 0028): what it clicks on the list, or `other-shown`. */
  chooser?: ChooserClick;
  /** For an item without a password: where its `password` route stops (ADR 0036). */
  stopAt?: number;
  /**
   * The later step of the chosen `password` variant the login starts at, when its page
   * shows that step and none of the recipe's first steps (ADR 0049).
   */
  startAt?: number;
  /** The login starts at `startAt` with that step's password fields alone (ADR 0049). */
  startPartial?: boolean;
  /** The time the login took before it started, from when its first page was seen. */
  timing: Omit<AttemptTiming, "personSince" | "pageSince">;
}): LoginAttemptMetadata {
  const recipe = parseLoginRecipe(input.recipe);
  if (input.signInFill && (input.choice.route !== "password" || input.fillOnly))
    throw new Error("Sign-in autofill requires its own password-route mode");
  if (input.account.origin !== recipe.origin)
    throw new Error("Attempt origin does not match recipe");
  return parseAttemptMetadata({
    version: 1,
    id: input.id,
    recipeId: recipe.id,
    recipeRevision: recipe.revision,
    ...(recipe.layout === undefined ? {} : { layout: recipe.layout }),
    policyRevision: input.policyRevision,
    account: input.account,
    route: input.choice.route,
    ...(input.choice.route === "password"
      ? { variant: input.choice.variant }
      : input.fallback === undefined
        ? {}
        : { variant: input.fallback }),
    facts: input.facts,
    handlers: [],
    document: input.document,
    ...(input.pageOrigin === undefined ? {} : { pageOrigin: input.pageOrigin }),
    state: "detected",
    stepIndex: input.choice.route === "password" ? (input.startAt ?? 0) : 0,
    stepCount: routeSteps(recipe, input.choice).length,
    submissions: 0,
    // A stop just past the route's last step keeps one more submission for its passkey
    // answer, which the recipe's budget does not count (ADR 0036).
    maxSubmissions: Math.min(
      MAX_ATTEMPT_SUBMISSIONS,
      recipe.maxSubmissions +
        (input.choice.route === "password" &&
        input.stopAt !== undefined &&
        input.stopAt === routeSteps(recipe, input.choice).length
          ? 1
          : 0),
    ),
    retries: 0,
    maxRetries: 2,
    usedOperationIds: [],
    ...(input.accountSwitched ? { accountSwitched: true } : {}),
    ...(input.fillOnly ? { fillOnly: true } : {}),
    ...(input.signInFill
      ? {
          signInFill: true,
          fillSince: Date.now(),
          fillPermissionSource: input.fillPermissionSource ?? "default",
        }
      : {}),
    ...(input.chooser ? { chooser: { click: input.chooser } } : {}),
    ...(input.stopAt === undefined ? {} : { stopAt: input.stopAt }),
    ...(input.startAt === undefined ? {} : { startStep: input.startAt }),
    ...(input.startAt !== undefined && input.startPartial ? { startPartial: true } : {}),
    timing: input.timing,
  });
}

/**
 * Applies one event. `now` starts the watch of a login that becomes watched (ADR 0027); a
 * login that stays watched keeps its watch, and one that no longer is drops it.
 */
export function transitionLoginAttempt(
  value: unknown,
  eventValue: unknown,
  now = Date.now(),
): LoginAttemptMetadata {
  const metadata = parseAttemptMetadata(value);
  if (metadata.route === "sso") throw new Error("SSO parent does not enter native transitions");
  const event = v.parse(loginAttemptEventSchema, eventValue);
  if (metadata.state === "authenticated" || metadata.state === "blocked") return metadata;
  if (metadata.signInFill) {
    const clear = {
      operationId: undefined,
      operationKind: undefined,
      operationEffect: undefined,
      operationPresses: undefined,
      mutationIntent: undefined,
      retryRequired: undefined,
      outcome: undefined,
      settled: undefined,
      watch: undefined,
    };
    // A restarted worker never replays a fill whose persisted intent may have reached
    // the document. No click, submission, result judgement or logout is synthesized.
    if (event.type === "INTERRUPTED")
      return parseAttemptMetadata({
        ...metadata,
        ...clear,
        state: "ready",
        stepIndex: Math.min(
          metadata.stepCount,
          metadata.stepIndex +
            (metadata.operationKind === "fill" && metadata.mutationIntent ? 1 : 0),
        ),
      });
    if (event.type === "NAVIGATED" && sameScope(metadata.document, event.document))
      return parseAttemptMetadata({
        ...metadata,
        ...clear,
        state: "ready",
        document: event.document,
        stepIndex: Math.min(
          metadata.stepCount,
          metadata.stepIndex +
            (metadata.document.documentId !== event.document.documentId &&
            metadata.operationKind === "fill" &&
            metadata.mutationIntent
              ? 1
              : 0),
        ),
      });
    if (event.type === "FILL_EXPIRED")
      return parseAttemptMetadata({
        ...metadata,
        ...clear,
        state: "blocked",
        outcome: "cancelled",
        fillExpired: true,
      });
    if (event.type === "FILL_BASELINE" && metadata.state === "ready")
      return parseAttemptMetadata({
        ...metadata,
        fillBaseline: {
          stepIndex: metadata.stepIndex,
          nextStep: event.nextStep,
          documentId: metadata.document.documentId,
          path: event.path,
          ready: event.ready,
        },
      });
    if (
      event.type === "FILL_PROGRESS" &&
      metadata.state === "ready" &&
      event.stepIndex > metadata.stepIndex &&
      event.stepIndex <= metadata.stepCount
    )
      return parseAttemptMetadata({ ...metadata, ...clear, stepIndex: event.stepIndex });
    if (
      event.type === "HANDLER" &&
      metadata.state === "ready" &&
      sameLoginDocument(metadata.document, event.document) &&
      !metadata.handlers.some((entry) => entry.index === event.handler) &&
      metadata.stepCount + event.steps <= MAX_ATTEMPT_STEPS
    )
      return parseAttemptMetadata({
        ...metadata,
        ...clear,
        handlers: [
          ...metadata.handlers,
          {
            index: event.handler,
            start: metadata.stepIndex,
            ...(event.field === undefined ? {} : { field: event.field }),
          },
        ],
        stepCount: metadata.stepCount + event.steps,
      });
    if (
      event.type === "CONTINUING" &&
      "before" in event &&
      metadata.state === "ready" &&
      replaceable(metadata) &&
      event.before === metadata.stepIndex &&
      !metadata.continuation
    )
      return parseAttemptMetadata({ ...metadata, continuation: { before: event.before } });
    if (
      event.type === "UNCONTINUED" &&
      "before" in event &&
      metadata.continuation &&
      "before" in metadata.continuation &&
      metadata.continuation.before === event.before
    )
      return parseAttemptMetadata({ ...metadata, continuation: undefined });
    if (
      event.type === "FILL_CONTINUING" &&
      metadata.state === "ready" &&
      replaceable(metadata) &&
      event.after === metadata.stepIndex &&
      !metadata.continuation
    )
      return parseAttemptMetadata({ ...metadata, continuation: { after: event.after } });
    if (
      event.type === "FILL_UNCONTINUED" &&
      metadata.continuation &&
      "after" in metadata.continuation &&
      metadata.continuation.after === event.after
    )
      return parseAttemptMetadata({ ...metadata, continuation: undefined });
    if (
      event.type === "CONTINUED" &&
      event.replacesLast !== true &&
      metadata.state === "ready" &&
      replaceable(metadata) &&
      metadata.continuation &&
      "after" in metadata.continuation &&
      metadata.continuation.after === metadata.stepIndex &&
      event.recipeRevision > metadata.recipeRevision &&
      metadata.stepCount + event.steps <= MAX_ATTEMPT_STEPS &&
      metadata.maxSubmissions + event.effects <= MAX_ATTEMPT_SUBMISSIONS &&
      sameLoginDocument(metadata.document, event.document)
    )
      return parseAttemptMetadata({
        ...metadata,
        ...clear,
        recipeRevision: event.recipeRevision,
        stepIndex: metadata.stepIndex + 1,
        stepCount: metadata.stepCount + event.steps,
        maxSubmissions: metadata.maxSubmissions + event.effects,
        continuation: undefined,
      });
    // These paths are for automatic execution, never for passive autofill.
    if (
      ["OBSERVED", "JUDGING", "STOP_JUDGING", "AUTO_SUBMITTED", "ROUTE", "STOP_ANSWERED"].includes(
        event.type,
      )
    )
      return metadata;
  }
  if (
    event.type === "FILL_PROGRESS" ||
    event.type === "FILL_BASELINE" ||
    event.type === "FILL_EXPIRED" ||
    event.type === "FILL_CONTINUING" ||
    event.type === "FILL_UNCONTINUED"
  )
    return metadata;
  const snapshot = loginAttemptMachine.resolveState({ value: metadata.state, context: metadata });
  // A login still at its first step that has submitted nothing, and has nothing in flight
  // that may have, has no result to settle as unknown: the page goes on, at the same step, as
  // one that does not show that step yet, which the step's own bounded wait and the retries
  // decide (ADR 0022). After a fill the person may have submitted the values themselves.
  const unsubmitted =
    event.type === "OBSERVED" &&
    event.result === "unknown" &&
    metadata.submissions === 0 &&
    metadata.stepIndex === (metadata.route === "password" ? (metadata.startStep ?? 0) : 0) &&
    !maySubmit(metadata)
      ? transition(loginAttemptMachine, snapshot, { ...event, result: "continue" })[0]
      : undefined;
  const [next] =
    unsubmitted &&
    (unsubmitted.value === "ready" || unsubmitted.value === "retryable") &&
    unsubmitted.context.stepIndex === metadata.stepIndex
      ? [unsubmitted]
      : transition(loginAttemptMachine, snapshot, event);
  const { watch, ...moved } = {
    ...next.context,
    state: next.value as LoginAttemptMetadata["state"],
  };
  // A watched login waits for the person: for a code or an approval, and for the site's
  // answer to it (ADR 0019), also when its result settled as unknown. An ended login waits
  // for no one. Any other login waiting for a step's result waits for the site.
  const result = followPage(
    watched(moved)
      ? awaitPerson(moved, now)
      : watched(metadata) || moved.state === "authenticated" || moved.state === "blocked"
        ? personAnswered(moved, now)
        : moved,
    now,
  );
  if (!watched(result)) return parseAttemptMetadata(result);
  return parseAttemptMetadata({
    ...result,
    watch: watch ?? {
      since: Math.max(0, Math.trunc(now)),
      documentId: result.document.documentId,
      pages: 0,
    },
  });
}

/**
 * Records that the account switch was not clicked after all: the attempt ends as
 * `wrong-account`, which keeps holding its tab like any other ended attempt.
 */
export function withdrawAccountSwitch(value: unknown): LoginAttemptMetadata {
  const metadata = parseAttemptMetadata(value);
  if (metadata.state !== "blocked" || metadata.outcome !== "account-switched") return metadata;
  return parseAttemptMetadata({ ...metadata, outcome: "wrong-account" });
}

/** Restart always observes; it never restores an actor snapshot with pending actions. */
export function recoverLoginAttempt(value: unknown): LoginAttemptMetadata {
  const metadata = parseAttemptMetadata(value);
  if (metadata.route === "sso")
    return ["authenticated", "blocked"].includes(metadata.state)
      ? metadata
      : parseAttemptMetadata({ ...metadata, state: "blocked", outcome: "interrupted" });
  return transitionLoginAttempt(metadata, { type: "INTERRUPTED" });
}

export {
  attemptTimingSchema,
  type AttemptTiming,
  MAX_ATTEMPT_SUBMISSIONS,
  MAX_JUDGED_PAGES,
  WATCH_PATH_MAX,
  judgedPages,
  pagesLeft,
  loginAttemptStateSchema,
} from "./login-attempt/schema-primitives";

export {
  attemptMetadataSchema,
  type LoginAttemptMetadata,
  parseAttemptMetadata,
} from "./login-attempt/metadata";

export { loginAttemptEventSchema, type LoginAttemptEvent } from "./login-attempt/events";

export { watchedAtStop } from "./login-attempt/policy";

export { loginAttemptMachine } from "./login-attempt/machine";

export {
  addAttemptTime,
  awaitPerson,
  personAnswered,
  followPage,
  type AttemptTimes,
  attemptTimes,
} from "./login-attempt/timing";

export {
  effectfulStep,
  fillOnlyStep,
  fillOnlyStops,
  attemptRouteChoice,
  handlerSlots,
  attemptUsesCode,
  attemptPlan,
  nextLoginOperation,
  validateLoginOperation,
} from "./login-attempt/operations";
