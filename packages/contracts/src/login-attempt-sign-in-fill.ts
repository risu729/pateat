import { sameLoginDocument, type LoginDocument } from "./login";
import type { LoginAttemptEvent, LoginAttemptMetadata } from "./login-attempt";

/** What a passive sign-in fill's transition reads of the attempt machine's own rules. */
export type SignInFillRules = {
  /** The event's document is in the attempt's tab, frame and origin. */
  sameScope: (left: LoginDocument, right: LoginDocument) => boolean;
  /**
   * The attempt stands, with nothing in flight, at its plan's last step of its own
   * recipe's `password` route, the only step a continued page may replace (ADR 0018).
   */
  replaceable: boolean;
  maxSteps: number;
  maxSubmissions: number;
};

/**
 * The next record of a profile or site sign-in fill (ADR 0035) for `event`, unparsed;
 * `metadata` itself for an event that changes nothing in this mode, or undefined for one
 * the attempt machine decides as for any login. It never synthesizes a click, a
 * submission, a result judgement or a logout.
 */
export function signInFillTransition(
  metadata: LoginAttemptMetadata,
  event: LoginAttemptEvent,
  rules: SignInFillRules,
): LoginAttemptMetadata | Record<string, unknown> | undefined {
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
    return {
      ...metadata,
      ...clear,
      state: "ready",
      stepIndex: Math.min(
        metadata.stepCount,
        metadata.stepIndex + (metadata.operationKind === "fill" && metadata.mutationIntent ? 1 : 0),
      ),
    };
  if (event.type === "NAVIGATED" && rules.sameScope(metadata.document, event.document))
    return {
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
    };
  if (event.type === "FILL_EXPIRED")
    return {
      ...metadata,
      ...clear,
      state: "blocked",
      outcome: "cancelled",
      fillExpired: true,
    };
  // Its last safe field is filled and nothing it could still fill can follow: the person
  // continues the site's steps, and the attempt holds no page of the tab after them.
  if (event.type === "FILL_DONE")
    return {
      ...metadata,
      ...clear,
      state: "blocked",
      outcome: "cancelled",
      fillDone: true,
    };
  if (event.type === "FILL_BASELINE" && metadata.state === "ready")
    return {
      ...metadata,
      fillBaseline: {
        stepIndex: metadata.stepIndex,
        nextStep: event.nextStep,
        documentId: metadata.document.documentId,
        path: event.path,
        ready: event.ready,
      },
    };
  if (
    event.type === "FILL_PROGRESS" &&
    metadata.state === "ready" &&
    event.stepIndex > metadata.stepIndex &&
    event.stepIndex <= metadata.stepCount
  )
    return { ...metadata, ...clear, stepIndex: event.stepIndex };
  if (
    event.type === "HANDLER" &&
    metadata.state === "ready" &&
    sameLoginDocument(metadata.document, event.document) &&
    !metadata.handlers.some((entry) => entry.index === event.handler) &&
    metadata.stepCount + event.steps <= rules.maxSteps
  )
    return {
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
    };
  if (
    event.type === "CONTINUING" &&
    "before" in event &&
    metadata.state === "ready" &&
    rules.replaceable &&
    event.before === metadata.stepIndex &&
    !metadata.continuation
  )
    return { ...metadata, continuation: { before: event.before } };
  if (
    event.type === "UNCONTINUED" &&
    "before" in event &&
    metadata.continuation &&
    "before" in metadata.continuation &&
    metadata.continuation.before === event.before
  )
    return { ...metadata, continuation: undefined };
  if (
    event.type === "FILL_CONTINUING" &&
    metadata.state === "ready" &&
    rules.replaceable &&
    event.after === metadata.stepIndex &&
    !metadata.continuation
  )
    return { ...metadata, continuation: { after: event.after } };
  if (
    event.type === "FILL_UNCONTINUED" &&
    metadata.continuation &&
    "after" in metadata.continuation &&
    metadata.continuation.after === event.after
  )
    return { ...metadata, continuation: undefined };
  if (
    event.type === "CONTINUED" &&
    event.replacesLast !== true &&
    metadata.state === "ready" &&
    rules.replaceable &&
    metadata.continuation &&
    "after" in metadata.continuation &&
    metadata.continuation.after === metadata.stepIndex &&
    event.recipeRevision > metadata.recipeRevision &&
    metadata.stepCount + event.steps <= rules.maxSteps &&
    metadata.maxSubmissions + event.effects <= rules.maxSubmissions &&
    sameLoginDocument(metadata.document, event.document)
  )
    return {
      ...metadata,
      ...clear,
      recipeRevision: event.recipeRevision,
      stepIndex: metadata.stepIndex + 1,
      stepCount: metadata.stepCount + event.steps,
      maxSubmissions: metadata.maxSubmissions + event.effects,
      continuation: undefined,
    };
  // These paths are for automatic execution, never for passive autofill.
  if (
    ["OBSERVED", "JUDGING", "STOP_JUDGING", "AUTO_SUBMITTED", "ROUTE", "STOP_ANSWERED"].includes(
      event.type,
    )
  )
    return metadata;
  return undefined;
}
