import { assign, setup } from "xstate";
import { sameLoginDocument } from "../login";
import {
  watched,
  pagesLeft,
  judgedPages,
  MAX_ATTEMPT_STEPS,
  MAX_ATTEMPT_SUBMISSIONS,
  MAX_ENTERED_HANDLERS,
} from "./schema-primitives";
import { type LoginAttemptMetadata, parseAttemptMetadata } from "./metadata";
import type { LoginAttemptEvent } from "./events";
import {
  beforeStop,
  operationMatches,
  stepBudget,
  valueRejected,
  confirmedNoMutation,
  sameScope,
  leftOrigin,
  leftFrame,
  maySignIn,
  stopsPastPlan,
  effectfulOperation,
  watchedAtStop,
  replaceable,
  atStop,
} from "./policy";
import { record } from "./record";

/**
 * A split `detail` value no input takes is left to the person as a challenge (ADR 0061);
 * a `password` login is then watched for their finish, as after a judged
 * challenge (ADR 0027).
 */
const valueRejectedTransitions = [
  { guard: "valueRejectedWatched", target: "watching", actions: "record" },
  { guard: "valueRejected", target: "blocked", actions: "record" },
] as const;

const observedTransitions = [
  { guard: "observedAuthenticated", target: "authenticated", actions: "record" },
  { guard: "observedWatched", target: "watching", actions: "record" },
  { guard: "observedRejected", target: "blocked", actions: "record" },
  { guard: "observedRetryRequired", target: "retryable", actions: "record" },
  { guard: "observedContinue", target: "ready", actions: "record" },
  { guard: "observedUnknown", target: "reconciling", actions: "record" },
] as const;

/** XState owns legal transitions; packaged coordinator owns storage and DOM side effects. */
function createLoginAttemptMachine() {
  return setup({
    types: {
      context: {} as LoginAttemptMetadata,
      events: {} as LoginAttemptEvent,
      input: {} as LoginAttemptMetadata,
    },
    actions: {
      record: assign(({ context, event }) => record(context, event)),
      submissionLimit: assign({ outcome: "submission-limit" }),
      retryLimit: assign({ outcome: "retry-limit" }),
      invalidNavigation: assign({ outcome: "cancelled" }),
      // A watched login's later page of its origin and tab: only the document changes.
      watchedNavigation: assign(({ context, event }) => ({
        document: event.type === "NAVIGATED" ? event.document : context.document,
      })),
      notListed: assign({ outcome: "account-not-listed" }),
      watchEnded: assign(({ context, event }) => ({
        outcome:
          event.type !== "WATCH_ENDED" || !event.abandoned
            ? context.outcome
            : context.outcome === "challenge"
              ? ("challenge-abandoned" as const)
              : ("watch-abandoned" as const),
      })),
    },
    guards: {
      canPrepare: ({ context, event }) =>
        event.type === "PREPARE" &&
        context.stepIndex < context.stepCount &&
        // Nothing at or after the stop of an item without a password runs (ADR 0036).
        beforeStop(context, context.stepIndex) &&
        !context.usedOperationIds.includes(event.operationId) &&
        context.usedOperationIds.length < 96,
      operationMatches: ({ context, event }) => operationMatches(context, event),
      completedNonClick: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind !== "click" &&
        (context.operationKind !== "fill" ||
          (context.operationEffect === "prepare" && context.mutationIntent === true)),
      preparationFill: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind === "fill" &&
        context.operationEffect === "prepare",
      effectfulFillAvailable: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind === "fill" &&
        context.operationEffect !== "prepare" &&
        context.submissions < stepBudget(context),
      effectfulFill: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind === "fill" &&
        context.operationEffect !== "prepare",
      canSubmit: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind === "click" &&
        context.submissions < stepBudget(context),
      clickMatches: ({ context, event }) =>
        operationMatches(context, event) && context.operationKind === "click",
      // A fill's, or the click a fill left its account check to (ADR 0049 amendment of
      // 2026-11-03).
      wrongAccount: ({ context, event }) =>
        event.type === "WRONG_ACCOUNT" &&
        operationMatches(context, event) &&
        (context.operationKind === "fill" || context.operationKind === "click") &&
        sameLoginDocument(context.document, event.document),
      valueRejected: ({ context, event }) => valueRejected(context, event),
      valueRejectedWatched: ({ context, event }) =>
        event.type === "VALUE_REJECTED" &&
        event.challenge === true &&
        valueRejected(context, event),
      retryAvailable: ({ context, event }) =>
        context.retries < context.maxRetries && !(event.type === "RETRY" && event.final),
      failedPossibleMutation: ({ context, event }) =>
        context.operationKind === "click" ||
        (context.mutationIntent === true && !confirmedNoMutation(context, event)),
      staleFailure: ({ context, event }) =>
        event.type === "FAILED" &&
        ((event.operationId !== undefined && event.operationId !== context.operationId) ||
          (event.document !== undefined && !sameLoginDocument(context.document, event.document))),
      sameScope: ({ context, event }) =>
        event.type === "NAVIGATED" && sameScope(context.document, event.document),
      leftOrigin: ({ context, event }) =>
        event.type === "NAVIGATED" && leftOrigin(context.document, event.document),
      leftPage: ({ context, event }) => event.type === "LEFT" && context.document.frameId === 0,
      leftSignedIn: ({ context, event }) =>
        event.type === "NAVIGATED" &&
        event.signedIn === true &&
        (leftOrigin(context.document, event.document) ||
          leftFrame(context.document, event.document)) &&
        maySignIn(context),
      // A watched login in a frame whose page left ends where it stopped (ADR 0086).
      leftFrameWatched: ({ context, event }) =>
        event.type === "NAVIGATED" &&
        leftFrame(context.document, event.document) &&
        watched(context),
      observedAuthenticated: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "authenticated" &&
        (!event.document || sameScope(context.document, event.document)),
      observedRejected: ({ context, event }) =>
        event.type === "OBSERVED" &&
        ["credential-rejected", "challenge"].includes(event.result) &&
        (!event.document || sameScope(context.document, event.document)),
      // A login of an item without a password that ends at its stop, with nothing in
      // flight, is watched as one stopped at a step left to the person (ADR 0036).
      observedStop: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "challenge" &&
        context.route === "password" &&
        context.stopAt !== undefined &&
        context.stepIndex === context.stopAt &&
        context.operationId === undefined &&
        context.document.frameId === 0 &&
        (!event.document || sameScope(context.document, event.document)),
      // A login that stops at a step left to the person is watched, on any route (owner,
      // 2026-11-08) and in a frame too (ADR 0086).
      observedWatched: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "challenge" &&
        (!event.document || sameScope(context.document, event.document)),
      observedCredentialRejected: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "credential-rejected" &&
        (!event.document || sameScope(context.document, event.document)),
      observedContinue: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "continue" &&
        // A stop past the plan's last step is a place to go on to, though no step is there.
        (context.stepIndex < context.stepCount ||
          (stopsPastPlan(context) && context.stepIndex === context.stopAt)) &&
        !(
          context.operationKind === "fill" &&
          (context.operationEffect === "submit" ||
            ((context.operationEffect ?? "prepare") === "prepare" &&
              context.retryRequired !== true))
        ) &&
        (!(context.operationKind === "click" || context.operationEffect === "advance") ||
          (context.operationId !== undefined &&
            context.mutationIntent === true &&
            context.submissions > 0 &&
            (context.stepIndex + 1 < context.stepCount ||
              // The final advance goes on to a stop just past it (ADR 0036).
              (context.operationEffect === "advance" &&
                stopsPastPlan(context) &&
                context.stepIndex + 1 === context.stopAt)))) &&
        // A login with a stop goes on at most to it (ADR 0036).
        (beforeStop(context, context.stepIndex) ||
          (context.stepIndex === context.stopAt && !effectfulOperation(context))) &&
        (!event.document || sameScope(context.document, event.document)),
      observedRetryRequired: ({ context, event }) =>
        context.retryRequired === true &&
        event.type === "OBSERVED" &&
        event.result === "continue" &&
        context.operationKind !== "click" &&
        context.stepIndex < context.stepCount &&
        (!event.document || sameScope(context.document, event.document)),
      observedUnknown: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "unknown" &&
        (!event.document || sameScope(context.document, event.document)),
      // Only an effect step's result is judged, and only a bounded number of pages: after
      // the step, then again while the login is watched (ADR 0027).
      canJudge: ({ context, event }) =>
        event.type === "JUDGING" &&
        event.operationId !== undefined &&
        operationMatches(context, event) &&
        (context.operationKind === "click" ||
          context.operationEffect === "advance" ||
          context.operationEffect === "submit") &&
        pagesLeft(context, event.operationId) > 0,
      // So are the pages of a login watched at its stop, which has no step in flight to name
      // (ADR 0036).
      canJudgeWatchedStop: ({ context, event }) =>
        event.type === "JUDGING" &&
        event.operationId === undefined &&
        watchedAtStop(context) &&
        pagesLeft(context, undefined) > 0,
      canUnjudge: ({ context, event }) =>
        event.type === "UNJUDGED" &&
        (event.operationId !== undefined || watchedAtStop(context)) &&
        (context.watch ? context.watch.pages : judgedPages(context, event.operationId)) > 0,
      watchEnds: ({ context }) => context.watch !== undefined,
      // One request per final advance, recorded before it is sent (ADR 0018). A login with
      // a stop asks only when the stop lies just past that advance (ADR 0036).
      canContinue: ({ context, event }) =>
        event.type === "CONTINUING" &&
        "operationId" in event &&
        operationMatches(context, event) &&
        (context.stopAt === undefined || stopsPastPlan(context)) &&
        context.operationEffect === "advance" &&
        context.mutationIntent === true &&
        context.submissions > 0 &&
        context.stepIndex + 1 === context.stepCount &&
        !(
          context.continuation !== undefined &&
          "operationId" in context.continuation &&
          context.continuation.operationId === event.operationId
        ),
      canUncontinue: ({ context, event }) =>
        event.type === "UNCONTINUED" &&
        "operationId" in event &&
        context.continuation !== undefined &&
        "operationId" in context.continuation &&
        context.continuation.operationId === event.operationId,
      // One request per final `advance` click whose button stayed disabled while a password
      // input opened, before anything of that click ran (ADR 0018 amendment of 2026-11-03):
      // only a `password` login on its recipe's own steps, with no handler entered, no stop,
      // no chooser and not only filling.
      canContinueBefore: ({ context, event }) =>
        event.type === "CONTINUING" &&
        "before" in event &&
        replaceable(context) &&
        event.before === context.stepIndex &&
        !(
          context.continuation !== undefined &&
          "before" in context.continuation &&
          context.continuation.before === event.before
        ),
      canUncontinueBefore: ({ context, event }) =>
        event.type === "UNCONTINUED" &&
        "before" in event &&
        context.continuation !== undefined &&
        "before" in context.continuation &&
        context.continuation.before === event.before,
      // The page's steps replace the click whose page was sent, within the caps; at least
      // one of them still submits.
      continuedBefore: ({ context, event }) =>
        event.type === "CONTINUED" &&
        event.replacesLast === true &&
        event.stopAt === undefined &&
        event.recipeRevision > context.recipeRevision &&
        replaceable(context) &&
        context.continuation !== undefined &&
        "before" in context.continuation &&
        context.continuation.before === context.stepIndex &&
        context.stepCount - 1 + event.steps <= MAX_ATTEMPT_STEPS &&
        context.maxSubmissions - 1 + event.effects <= MAX_ATTEMPT_SUBMISSIONS &&
        sameScope(context.document, event.document),
      // The continued steps follow the final advance whose page was sent, and stay within
      // the attempt's step and submission caps.
      // A login with a stop just past its plan names its new stop, at or after the first
      // continued step (ADR 0036); one without a stop names none. Only the range is checked
      // here: that the stop is the first continued step filling a password is the
      // runtime's `continuedStop` to get right, since bindings are not visible here.
      continued: ({ context, event }) =>
        event.type === "CONTINUED" &&
        event.replacesLast !== true &&
        event.recipeRevision > context.recipeRevision &&
        (context.stopAt === undefined
          ? event.stopAt === undefined
          : stopsPastPlan(context) &&
            event.stopAt !== undefined &&
            event.stopAt >= context.stepCount &&
            event.stopAt <= context.stepCount + event.steps) &&
        context.operationId !== undefined &&
        context.continuation !== undefined &&
        "operationId" in context.continuation &&
        context.continuation.operationId === context.operationId &&
        context.operationEffect === "advance" &&
        context.mutationIntent === true &&
        context.submissions > 0 &&
        context.stepIndex + 1 === context.stepCount &&
        context.stepCount + event.steps <= MAX_ATTEMPT_STEPS &&
        context.maxSubmissions + event.effects <= MAX_ATTEMPT_SUBMISSIONS &&
        sameScope(context.document, event.document),
      // At a step where the layouts of the recipe part (ADR 0060): after an effect step that
      // may have advanced, as `observedContinue` takes it, or with nothing in flight. The
      // layout's step there must exist, and its budget must hold what was spent already.
      canSwitchLayout: ({ context, event }) => {
        if (event.type !== "LAYOUT") return false;
        const inFlight = context.operationId !== undefined;
        const at = inFlight ? context.stepIndex + 1 : context.stepIndex;
        return (
          context.layout !== undefined &&
          event.layout !== context.layout &&
          event.recipeRevision >= context.recipeRevision &&
          context.route === "password" &&
          context.variant === 0 &&
          context.handlers.length === 0 &&
          context.chooser === undefined &&
          context.stopAt === undefined &&
          context.fillOnly !== true &&
          (inFlight
            ? (context.operationKind === "click" || context.operationEffect === "advance") &&
              context.mutationIntent === true &&
              context.submissions > 0
            : context.retryRequired !== true) &&
          at >= 1 &&
          at < event.steps &&
          // Past the login's own last step only after an advance, whose next page the
          // layout already holds; never after a submission that ended the login's plan.
          (at < context.stepCount || context.operationEffect === "advance") &&
          context.submissions <= event.maxSubmissions &&
          sameScope(context.document, event.document)
        );
      },
      // Before anything was submitted, between steps, once each way: a login back on the
      // password route never takes the passkey route again (ADR 0034).
      canSwitchRoute: ({ context, event }) =>
        event.type === "ROUTE" &&
        event.route !== context.route &&
        !(event.route === "passkey" && context.passkeyLeft === true) &&
        context.variant !== undefined &&
        context.operationId === undefined &&
        context.submissions === 0 &&
        context.handlers.length === 0 &&
        context.fillOnly !== true &&
        // A login with a stop never goes back to the password it lacks (ADR 0036).
        !(event.route === "password" && context.stopAt !== undefined),
      // After the passkey answer, once, to the variant the login recorded.
      canFallBack: ({ context, event }) =>
        event.type === "ROUTE" &&
        event.route === "password" &&
        context.route === "passkey" &&
        context.variant !== undefined &&
        context.operationKind === "click" &&
        context.submissions > 0 &&
        context.handlers.length === 0 &&
        context.stopAt === undefined &&
        // A settled login, watched, only reads its later pages (ADR 0027).
        context.settled !== true,
      newerRevision: ({ context, event }) =>
        event.type === "REVISED" && event.recipeRevision > context.recipeRevision,
      newerPolicy: ({ context, event }) =>
        event.type === "POLICY_REVISED" &&
        watched(context) &&
        event.policyRevision > context.policyRevision,
      // A handler follows only an effect step that may have submitted, runs once per
      // login, and stays within the attempt's step and submission caps.
      canEnterHandler: ({ context, event }) =>
        event.type === "HANDLER" &&
        context.operationId !== undefined &&
        context.mutationIntent === true &&
        context.submissions > 0 &&
        (context.operationKind === "click" ||
          context.operationEffect === "advance" ||
          context.operationEffect === "submit") &&
        !context.handlers.some((entry) => entry.index === event.handler) &&
        context.handlers.length < MAX_ENTERED_HANDLERS &&
        // A handler shown after the stop is left to the person (ADR 0036).
        beforeStop(context, context.stepIndex) &&
        context.stepIndex < context.stepCount &&
        context.stepCount + event.steps <= MAX_ATTEMPT_STEPS &&
        context.maxSubmissions + event.effects <= MAX_ATTEMPT_SUBMISSIONS &&
        sameScope(context.document, event.document),
      // Between a code's fill and the click after it, or with the fill still unanswered:
      // an entered handler's first step, or a route step's (`routeStep`); the page's own
      // submission takes the click's place in the budget. The runtime checks that the
      // steps are a `totp` handler's or a route's fill of the `totp` slot and its click.
      canAutoSubmit: ({ context, event }) =>
        event.type === "AUTO_SUBMITTED" &&
        // A fill-only login never types a code (ADR 0021 D), so no page submits one for it.
        context.fillOnly !== true &&
        !context.usedOperationIds.includes(event.operationId) &&
        context.usedOperationIds.length < 96 &&
        context.submissions < stepBudget(context) &&
        (context.operationId === undefined
          ? context.stepIndex > 0 &&
            context.stepIndex < context.stepCount &&
            beforeStop(context, context.stepIndex) &&
            context.retryRequired !== true &&
            (event.routeStep === true ||
              context.handlers.some((entry) => entry.start === context.stepIndex - 1))
          : context.operationKind === "fill" &&
            context.operationEffect === "prepare" &&
            context.mutationIntent === true &&
            context.stepIndex + 1 < context.stepCount &&
            beforeStop(context, context.stepIndex + 1) &&
            (event.routeStep === true ||
              context.handlers.some((entry) => entry.start === context.stepIndex))),
      // At the stop, with nothing in flight: a `passkey` handler shown beside the stop
      // step's password field goes in before it, as after an effect step (ADR 0036).
      canEnterHandlerAtStop: ({ context, event }) =>
        event.type === "HANDLER" &&
        atStop(context) &&
        !context.handlers.some((entry) => entry.index === event.handler) &&
        context.handlers.length < MAX_ENTERED_HANDLERS &&
        context.stepCount + event.steps <= MAX_ATTEMPT_STEPS &&
        context.maxSubmissions + event.effects <= MAX_ATTEMPT_SUBMISSIONS &&
        sameScope(context.document, event.document),
      // Once per attempt, at a stop step that is in the plan (ADR 0036).
      canJudgeAtStop: ({ context, event }) =>
        event.type === "STOP_JUDGING" &&
        atStop(context) &&
        context.stopAt! < context.stepCount &&
        context.stopJudged !== true,
      // At the stop, with nothing in flight, once the login submitted (ADR 0036).
      canAnswerAtStop: ({ context, event }) =>
        event.type === "STOP_ANSWERED" &&
        atStop(context) &&
        context.submissions < context.maxSubmissions &&
        !context.usedOperationIds.includes(event.operationId) &&
        context.usedOperationIds.length < 96,
    },
  }).createMachine({
    id: "login-attempt",
    initial: "detected",
    context: ({ input }) => parseAttemptMetadata(input),
    on: {
      REVISED: { guard: "newerRevision", actions: "record" },
      POLICY_REVISED: { guard: "newerPolicy", actions: "record" },
      POLICY_CHANGED: { target: ".blocked", actions: "record" },
      CANCEL: { target: ".blocked", actions: "record" },
      NAVIGATED: [
        { guard: "sameScope", target: ".reconciling", actions: "record" },
        // A top-level attempt ends when its tab leaves the origin; it is never resubmitted.
        { guard: "leftSignedIn", target: ".authenticated", actions: "record" },
        { guard: "leftOrigin", target: ".blocked", actions: "record" },
        { guard: "leftFrameWatched", target: ".blocked", actions: "record" },
        { target: ".blocked", actions: "invalidNavigation" },
      ],
      LEFT: { guard: "leftPage", target: ".blocked", actions: "record" },
      INTERRUPTED: { target: ".reconciling", actions: "record" },
    },
    states: {
      detected: { on: { RESOLVE: "ready" } },
      ready: {
        on: {
          PREPARE: { guard: "canPrepare", target: "executing", actions: "record" },
          AUTO_SUBMITTED: { guard: "canAutoSubmit", target: "reconciling", actions: "record" },
          FAILED: [{ guard: "staleFailure" }, { target: "retryable", actions: "record" }],
          OBSERVED: [
            { guard: "observedAuthenticated", target: "authenticated", actions: "record" },
            { guard: "observedStop", target: "watching", actions: "record" },
            { guard: "observedRejected", target: "blocked", actions: "record" },
          ],
          STOP_ANSWERED: { guard: "canAnswerAtStop", target: "reconciling", actions: "record" },
          STOP_JUDGING: { guard: "canJudgeAtStop", actions: "record" },
          HANDLER: { guard: "canEnterHandlerAtStop", target: "ready", actions: "record" },
          ROUTE: { guard: "canSwitchRoute", target: "ready", actions: "record" },
          LAYOUT: { guard: "canSwitchLayout", target: "ready", actions: "record" },
          CONTINUING: { guard: "canContinueBefore", actions: "record" },
          UNCONTINUED: { guard: "canUncontinueBefore", actions: "record" },
          CONTINUED: { guard: "continuedBefore", target: "ready", actions: "record" },
          NOT_LISTED: {
            guard: ({ context }) =>
              context.chooser !== undefined &&
              context.stepIndex === 0 &&
              context.operationId === undefined &&
              context.submissions === 0,
            target: "blocked",
            actions: "notListed",
          },
        },
      },
      executing: {
        on: {
          OPERATION_OK: { guard: "completedNonClick", target: "ready", actions: "record" },
          MUTATION_INTENT: [
            { guard: "preparationFill", actions: "record" },
            { guard: "effectfulFillAvailable", target: "submit-intent", actions: "record" },
            { guard: "effectfulFill", target: "blocked", actions: "submissionLimit" },
          ],
          SUBMIT_INTENT: [
            { guard: "canSubmit", target: "submit-intent", actions: "record" },
            { guard: "clickMatches", target: "blocked", actions: "submissionLimit" },
          ],
          FAILED: [
            { guard: "staleFailure" },
            { guard: "failedPossibleMutation", target: "reconciling", actions: "record" },
            { target: "retryable", actions: "record" },
          ],
          WRONG_ACCOUNT: { guard: "wrongAccount", target: "blocked", actions: "record" },
          VALUE_REJECTED: valueRejectedTransitions,
          AUTO_SUBMITTED: { guard: "canAutoSubmit", target: "reconciling", actions: "record" },
        },
      },
      "submit-intent": {
        on: {
          SUBMITTED: { guard: "operationMatches", target: "awaiting-result" },
          FAILED: [
            { guard: "staleFailure" },
            {
              guard: ({ context, event }) =>
                context.operationKind === "fill" && confirmedNoMutation(context, event),
              target: "retryable",
              actions: "record",
            },
            { target: "reconciling", actions: "record" },
          ],
          WRONG_ACCOUNT: { guard: "wrongAccount", target: "blocked", actions: "record" },
          VALUE_REJECTED: valueRejectedTransitions,
        },
      },
      "awaiting-result": {
        on: {
          OBSERVED: observedTransitions,
          JUDGING: { guard: "canJudge", actions: "record" },
          UNJUDGED: { guard: "canUnjudge", actions: "record" },
          CONTINUING: { guard: "canContinue", actions: "record" },
          UNCONTINUED: { guard: "canUncontinue", actions: "record" },
          CONTINUED: { guard: "continued", target: "ready", actions: "record" },
          HANDLER: { guard: "canEnterHandler", target: "ready", actions: "record" },
          LAYOUT: { guard: "canSwitchLayout", target: "ready", actions: "record" },
          ROUTE: { guard: "canFallBack", target: "ready", actions: "record" },
          FAILED: [{ guard: "staleFailure" }, { target: "reconciling", actions: "record" }],
        },
      },
      reconciling: {
        on: {
          AUTO_SUBMITTED: { guard: "canAutoSubmit", target: "reconciling", actions: "record" },
          OBSERVED: observedTransitions,
          JUDGING: { guard: "canJudge", actions: "record" },
          UNJUDGED: { guard: "canUnjudge", actions: "record" },
          WATCH_ENDED: { guard: "watchEnds", target: "blocked", actions: "watchEnded" },
          CONTINUING: { guard: "canContinue", actions: "record" },
          UNCONTINUED: { guard: "canUncontinue", actions: "record" },
          CONTINUED: { guard: "continued", target: "ready", actions: "record" },
          HANDLER: { guard: "canEnterHandler", target: "ready", actions: "record" },
          LAYOUT: { guard: "canSwitchLayout", target: "ready", actions: "record" },
          ROUTE: { guard: "canFallBack", target: "ready", actions: "record" },
        },
      },
      retryable: {
        on: {
          RETRY: [
            { guard: "retryAvailable", target: "ready", actions: "record" },
            { target: "blocked", actions: "retryLimit" },
          ],
        },
      },
      // Reads only: no step runs. A later page proves the sign-in or a refused password;
      // anything else leaves the login watched until the watch ends (ADR 0027).
      watching: {
        on: {
          OBSERVED: [
            { guard: "observedAuthenticated", target: "authenticated", actions: "record" },
            { guard: "observedCredentialRejected", target: "blocked", actions: "record" },
          ],
          JUDGING: [
            { guard: "canJudge", actions: "record" },
            { guard: "canJudgeWatchedStop", actions: "record" },
          ],
          UNJUDGED: { guard: "canUnjudge", actions: "record" },
          WATCH_ENDED: { target: "blocked", actions: "watchEnded" },
          // A restart or a new page of the tab keeps the watch; it has nothing in flight.
          INTERRUPTED: { actions: [] },
          NAVIGATED: [
            { guard: "sameScope", actions: "watchedNavigation" },
            { guard: "leftSignedIn", target: "authenticated", actions: "record" },
            { guard: "leftOrigin", target: "blocked", actions: "record" },
            { guard: "leftFrameWatched", target: "blocked", actions: "record" },
            { target: "blocked", actions: "invalidNavigation" },
          ],
          LEFT: { guard: "leftPage", target: "blocked", actions: "record" },
        },
      },
      authenticated: { type: "final" },
      blocked: { type: "final" },
    },
  });
}

// The engine has no startup side effects. Schema-only consumers omit XState.
export const loginAttemptMachine = /* @__PURE__ */ createLoginAttemptMachine();
