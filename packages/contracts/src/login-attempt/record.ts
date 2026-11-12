import { watched, judgedPages, MAX_ATTEMPT_SUBMISSIONS } from "./schema-primitives";
import type { LoginAttemptMetadata } from "./metadata";
import type { LoginAttemptEvent } from "./events";
import {
  leftOrigin,
  leftFrame,
  maySignIn,
  maySubmit,
  sameScope,
  confirmedNoMutation,
  stopsPastPlan,
} from "./policy";

export function record(
  context: LoginAttemptMetadata,
  event: LoginAttemptEvent,
): Partial<LoginAttemptMetadata> {
  switch (event.type) {
    case "PREPARE":
      return {
        operationId: event.operationId,
        operationKind: event.kind,
        operationEffect:
          event.effect ??
          (event.kind === "fill" ? "prepare" : event.kind === "click" ? "submit" : undefined),
        operationPresses: event.presses,
        mutationIntent: undefined,
        usedOperationIds: [...context.usedOperationIds, event.operationId],
        outcome: undefined,
      };
    case "SUBMIT_INTENT":
      return { submissions: context.submissions + 1, mutationIntent: true };
    case "MUTATION_INTENT":
      return {
        mutationIntent: true,
        submissions: context.submissions + (context.operationEffect === "prepare" ? 0 : 1),
      };
    case "OPERATION_OK":
      return {
        stepIndex: context.stepIndex + 1,
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
        outcome: undefined,
      };
    case "OBSERVED":
      if (event.result === "continue")
        return {
          stepIndex:
            context.operationKind === "click" || context.operationEffect === "advance"
              ? context.stepIndex + 1
              : context.stepIndex,
          document: event.document ?? context.document,
          operationId: undefined,
          operationKind: undefined,
          operationEffect: undefined,
          mutationIntent: undefined,
          outcome: undefined,
          settled: undefined,
        };
      return {
        document: event.document ?? context.document,
        outcome: event.result === "unknown" ? "unknown-submit" : event.result,
        ...(event.unconfirmed ? { unconfirmed: true } : {}),
        settled: event.result === "unknown" ? true : undefined,
      };
    case "NAVIGATED":
      // A frame's page that left without a sign-in confirmed is recorded here only for a
      // watched login, which ends where it stopped; any other ends `cancelled`.
      if (
        leftOrigin(context.document, event.document) ||
        leftFrame(context.document, event.document)
      )
        // The result of a submission on the previous origin cannot be observed here, unless
        // the runtime confirmed the sign-in. A watched login ends where it stopped, as when
        // its watch ends: it never signed in, so its first step showing again is no logout
        // (ADR 0027, 2026-10-13).
        return {
          outcome:
            event.signedIn && maySignIn(context)
              ? "authenticated"
              : watched(context)
                ? context.outcome
                : !maySubmit(context)
                  ? "interrupted"
                  : "left-origin",
        };
      return {
        document: sameScope(context.document, event.document) ? event.document : context.document,
        outcome: maySubmit(context) ? "unknown-submit" : "interrupted",
      };
    case "LEFT":
      // As a move to another origin without a sign-in confirmed there.
      return {
        outcome: watched(context)
          ? context.outcome
          : !maySubmit(context)
            ? "interrupted"
            : "left-origin",
      };
    case "INTERRUPTED":
      return { outcome: maySubmit(context) ? "unknown-submit" : "interrupted" };
    case "FAILED": {
      // A trusted preflight failure proves that this fill never initiated its reserved
      // effect, but only before the page said it took the step (`SUBMITTED`).
      const unsent = confirmedNoMutation(context, event) && context.state !== "awaiting-result";
      return {
        outcome: event.reason,
        // Keep its used ID and the independent retry budget.
        submissions:
          unsent &&
          context.mutationIntent === true &&
          context.operationKind === "fill" &&
          ["advance", "submit"].includes(context.operationEffect ?? "prepare")
            ? context.submissions - 1
            : context.submissions,
        mutationIntent: unsent ? undefined : context.mutationIntent,
        retryRequired:
          context.operationKind !== "click" && (!context.mutationIntent || unsent)
            ? true
            : context.retryRequired,
      };
    }
    case "WRONG_ACCOUNT": {
      // Like a confirmed preflight failure, the reserved fill effect never started.
      const submissions =
        context.mutationIntent === true && (context.operationEffect ?? "prepare") !== "prepare"
          ? context.submissions - 1
          : context.submissions;
      return {
        // A switch starts a fresh attempt with a full budget, so it is recorded only once
        // per sign-in and only before anything was submitted.
        outcome:
          event.switched && !context.accountSwitched && submissions === 0
            ? "account-switched"
            : "wrong-account",
        submissions,
        mutationIntent: undefined,
      };
    }
    case "VALUE_REJECTED":
      if (event.stage !== "before-fill") return { outcome: "fill-rejected" };
      return {
        outcome: event.challenge ? "challenge" : "value-mismatch",
        // As with a wrong account, the reserved fill effect never started.
        submissions:
          context.mutationIntent === true && (context.operationEffect ?? "prepare") !== "prepare"
            ? context.submissions - 1
            : context.submissions,
        mutationIntent: undefined,
      };
    case "REVISED":
      return { recipeRevision: event.recipeRevision };
    case "POLICY_REVISED":
      return { policyRevision: event.policyRevision };
    case "JUDGING":
      if (context.watch) return { watch: { ...context.watch, pages: context.watch.pages + 1 } };
      if (event.operationId === undefined) return {};
      return {
        judged: {
          operationId: event.operationId,
          pages: judgedPages(context, event.operationId) + 1,
        },
      };
    case "UNJUDGED":
      if (context.watch) return { watch: { ...context.watch, pages: context.watch.pages - 1 } };
      if (event.operationId === undefined) return {};
      return {
        judged: {
          operationId: event.operationId,
          pages: judgedPages(context, event.operationId) - 1,
        },
      };
    case "CONTINUING":
      return {
        continuation:
          "before" in event ? { before: event.before } : { operationId: event.operationId },
      };
    case "UNCONTINUED":
      return { continuation: undefined };
    case "CONTINUED":
      // The replaced click never ran: the login stays at its step, now the page's first.
      if (event.replacesLast)
        return {
          recipeRevision: event.recipeRevision,
          stepCount: context.stepCount - 1 + event.steps,
          maxSubmissions: context.maxSubmissions - 1 + event.effects,
          document: event.document,
          continuation: undefined,
          retryRequired: undefined,
        };
      return {
        recipeRevision: event.recipeRevision,
        stepIndex: context.stepIndex + 1,
        stepCount: context.stepCount + event.steps,
        // A stop past the plan moves to the continued steps; the submission kept for its
        // answer is kept only while the stop still lies past the plan's last step (ADR 0036).
        ...(event.stopAt === undefined ? {} : { stopAt: event.stopAt }),
        maxSubmissions:
          context.maxSubmissions +
          event.effects -
          (event.stopAt !== undefined && event.stopAt < context.stepCount + event.steps ? 1 : 0),
        document: event.document,
        continuation: undefined,
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
        outcome: undefined,
        retryRequired: undefined,
        settled: undefined,
      };
    case "LAYOUT":
      return {
        layout: event.layout,
        recipeRevision: event.recipeRevision,
        // The effect step in flight is done: its page shows the layout's next step.
        stepIndex: context.operationId === undefined ? context.stepIndex : context.stepIndex + 1,
        stepCount: event.steps,
        maxSubmissions: event.maxSubmissions,
        document: event.document,
        continuation: undefined,
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
        outcome: undefined,
        retryRequired: undefined,
        settled: undefined,
      };
    case "HANDLER": {
      // After an effect step the handler's steps follow it; at a stop, with nothing in
      // flight, they go in at the stop step itself (ADR 0036).
      const start = context.operationId === undefined ? context.stepIndex : context.stepIndex + 1;
      return {
        handlers: [
          ...context.handlers,
          {
            index: event.handler,
            start,
            ...(event.field === undefined ? {} : { field: event.field }),
          },
        ],
        // The handler's steps go in before the stop, which moves along with the plan.
        ...(context.route === "password" && context.stopAt !== undefined
          ? { stopAt: context.stopAt + event.steps }
          : {}),
        stepIndex: start,
        stepCount: context.stepCount + event.steps,
        maxSubmissions: context.maxSubmissions + event.effects,
        document: event.document,
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
        outcome: undefined,
        retryRequired: undefined,
        settled: undefined,
      };
    }
    case "STOP_JUDGING":
      return { stopJudged: true };
    case "AUTO_SUBMITTED":
      return {
        // A fill still in flight is done, so the step is its handler's click.
        stepIndex: context.operationKind === "fill" ? context.stepIndex + 1 : context.stepIndex,
        operationId: event.operationId,
        operationKind: "click",
        operationEffect: "submit",
        mutationIntent: true,
        submissions: context.submissions + 1,
        usedOperationIds: [...context.usedOperationIds, event.operationId],
        outcome: undefined,
        retryRequired: undefined,
        settled: undefined,
      };
    case "STOP_ANSWERED":
      return {
        // The step stays the stop: nothing after it runs.
        operationId: event.operationId,
        operationKind: "click",
        operationEffect: "submit",
        mutationIntent: true,
        submissions: context.submissions + 1,
        usedOperationIds: [...context.usedOperationIds, event.operationId],
        outcome: undefined,
        retryRequired: undefined,
        settled: undefined,
      };
    case "ROUTE":
      return {
        route: event.route,
        ...(event.route === "password" ? { passkeyLeft: true as const } : {}),
        // A login that started at a later step goes back to it (ADR 0049).
        stepIndex: event.route === "password" ? (context.startStep ?? 0) : 0,
        stepCount: event.steps,
        // The passkey answer does not spend the password route's budget. The submission a
        // stop past the plan's last step keeps for its answer stays with the password route.
        maxSubmissions: Math.min(
          MAX_ATTEMPT_SUBMISSIONS,
          context.maxSubmissions +
            (event.route === "password" ? context.submissions : 0) -
            (stopsPastPlan(context) ? 1 : 0),
        ),
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
        outcome: undefined,
        retryRequired: undefined,
        settled: undefined,
      };
    case "RETRY":
      return {
        retries: context.retries + 1,
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
        outcome: undefined,
        retryRequired: undefined,
      };
    case "POLICY_CHANGED":
      // Only an operation still being sent, or one whose check failed before it went out
      // (`reconciling`), can be undelivered: one the page said it took (`SUBMITTED`), and a
      // watched login's, was delivered, whatever the runtime names.
      if (
        event.undelivered === undefined ||
        event.undelivered !== context.operationId ||
        !["executing", "submit-intent", "reconciling"].includes(context.state)
      )
        return { outcome: "policy-changed" };
      return {
        outcome: "policy-changed",
        // As with a wrong account, the reserved effect never started; a click reserves a
        // submission whatever its purpose.
        submissions:
          context.mutationIntent === true &&
          (context.operationKind === "click" ||
            (context.operationEffect ?? "prepare") !== "prepare")
            ? context.submissions - 1
            : context.submissions,
        operationId: undefined,
        operationKind: undefined,
        operationEffect: undefined,
        mutationIntent: undefined,
      };
    case "CANCEL":
      return { outcome: "cancelled" };
    default:
      return {};
  }
}
