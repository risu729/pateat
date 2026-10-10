import * as v from "valibot";
import { assign, createActor, setup, transition } from "xstate";
import {
  loginAccountSchema,
  loginDocumentSchema,
  loginOperationSchema,
  loginOutcomeSchema,
  parseLoginRecipe,
  sameLoginDocument,
  type LoginAccount,
  type LoginDocument,
  type LoginOperation,
  type LoginRecipe,
} from "./login";

const identifier = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(120),
  v.regex(/^[a-zA-Z0-9_.:-]+$/),
);
const integer = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(max));
export const loginAttemptStateSchema = v.picklist([
  "detected",
  "ready",
  "executing",
  "submit-intent",
  "awaiting-result",
  "reconciling",
  "retryable",
  "authenticated",
  "blocked",
]);
/** Allowlisted metadata only. Never persist an XState snapshot or resolved field values. */
export const attemptMetadataSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    id: identifier,
    recipeId: identifier,
    recipeRevision: integer(Number.MAX_SAFE_INTEGER - 1),
    policyRevision: integer(Number.MAX_SAFE_INTEGER - 1),
    account: loginAccountSchema,
    document: loginDocumentSchema,
    state: loginAttemptStateSchema,
    stepIndex: integer(32),
    stepCount: v.pipe(integer(32), v.minValue(1)),
    submissions: integer(8),
    maxSubmissions: v.pipe(integer(8), v.minValue(1)),
    retries: integer(2),
    maxRetries: v.literal(2),
    retryRequired: v.optional(v.literal(true)),
    usedOperationIds: v.pipe(
      v.array(identifier),
      v.maxLength(96),
      v.check((ids) => new Set(ids).size === ids.length, "Duplicate operation IDs"),
    ),
    operationId: v.optional(identifier),
    operationKind: v.optional(v.picklist(["fill", "click", "wait", "assert"])),
    outcome: v.optional(loginOutcomeSchema),
  }),
  v.check(
    (metadata) =>
      metadata.document.origin === metadata.account.origin &&
      metadata.stepIndex <= metadata.stepCount &&
      metadata.submissions <= metadata.maxSubmissions,
    "Inconsistent attempt scope or budget",
  ),
  v.check(
    (metadata) => (metadata.operationId === undefined) === (metadata.operationKind === undefined),
    "Incomplete operation identity",
  ),
  v.check(
    (metadata) =>
      metadata.operationId === undefined ||
      metadata.usedOperationIds.includes(metadata.operationId),
    "Operation ID is not recorded",
  ),
  v.check(
    (metadata) =>
      !["executing", "submit-intent", "awaiting-result"].includes(metadata.state) ||
      metadata.operationId !== undefined,
    "Missing in-flight operation",
  ),
  v.check(
    (metadata) =>
      !["submit-intent", "awaiting-result"].includes(metadata.state) ||
      metadata.operationKind === "click",
    "Only clicks have submission state",
  ),
);
export type LoginAttemptMetadata = v.InferOutput<typeof attemptMetadataSchema>;
export const parseAttemptMetadata = (value: unknown): LoginAttemptMetadata =>
  v.parse(attemptMetadataSchema, value);

export const loginAttemptEventSchema = v.variant("type", [
  v.strictObject({ type: v.literal("RESOLVE") }),
  v.strictObject({
    type: v.literal("PREPARE"),
    operationId: identifier,
    kind: v.picklist(["fill", "click", "wait", "assert"]),
  }),
  v.strictObject({ type: v.literal("OPERATION_OK"), operationId: identifier }),
  v.strictObject({ type: v.literal("SUBMIT_INTENT"), operationId: identifier }),
  v.strictObject({ type: v.literal("SUBMITTED"), operationId: identifier }),
  v.strictObject({
    type: v.literal("OBSERVED"),
    result: v.picklist([
      "continue",
      "authenticated",
      "credential-rejected",
      "challenge",
      "unknown",
    ]),
    document: v.optional(loginDocumentSchema),
  }),
  v.strictObject({ type: v.literal("NAVIGATED"), document: loginDocumentSchema }),
  v.strictObject({ type: v.literal("INTERRUPTED") }),
  v.strictObject({
    type: v.literal("FAILED"),
    reason: v.picklist(["structural-mismatch", "timeout"]),
  }),
  v.strictObject({ type: v.literal("RETRY") }),
  v.strictObject({ type: v.literal("POLICY_CHANGED") }),
  v.strictObject({ type: v.literal("CANCEL") }),
]);
export type LoginAttemptEvent = v.InferOutput<typeof loginAttemptEventSchema>;
const sameScope = (left: LoginDocument, right: LoginDocument) =>
  left.origin === right.origin && left.tabId === right.tabId && left.frameId === right.frameId;
const operationMatches = (context: LoginAttemptMetadata, event: LoginAttemptEvent) =>
  "operationId" in event && event.operationId === context.operationId;

function record(
  context: LoginAttemptMetadata,
  event: LoginAttemptEvent,
): Partial<LoginAttemptMetadata> {
  switch (event.type) {
    case "PREPARE":
      return {
        operationId: event.operationId,
        operationKind: event.kind,
        usedOperationIds: [...context.usedOperationIds, event.operationId],
        outcome: undefined,
      };
    case "SUBMIT_INTENT":
      return { submissions: context.submissions + 1 };
    case "OPERATION_OK":
      return {
        stepIndex: context.stepIndex + 1,
        operationId: undefined,
        operationKind: undefined,
        outcome: undefined,
      };
    case "OBSERVED":
      if (event.result === "continue")
        return {
          stepIndex: context.operationKind === "click" ? context.stepIndex + 1 : context.stepIndex,
          document: event.document ?? context.document,
          operationId: undefined,
          operationKind: undefined,
          outcome: undefined,
        };
      return {
        document: event.document ?? context.document,
        outcome: event.result === "unknown" ? "unknown-submit" : event.result,
      };
    case "NAVIGATED":
      return {
        document: sameScope(context.document, event.document) ? event.document : context.document,
        outcome:
          context.operationKind === "click" && context.submissions > 0
            ? "unknown-submit"
            : "interrupted",
      };
    case "INTERRUPTED":
      return {
        outcome:
          context.operationKind === "click" && context.submissions > 0
            ? "unknown-submit"
            : "interrupted",
      };
    case "FAILED":
      return {
        outcome: event.reason,
        retryRequired: context.operationKind !== "click" ? true : context.retryRequired,
      };
    case "RETRY":
      return {
        retries: context.retries + 1,
        operationId: undefined,
        operationKind: undefined,
        outcome: undefined,
        retryRequired: undefined,
      };
    case "POLICY_CHANGED":
      return { outcome: "policy-changed" };
    case "CANCEL":
      return { outcome: "cancelled" };
    default:
      return {};
  }
}

const observedTransitions = [
  { guard: "observedAuthenticated", target: "authenticated", actions: "record" },
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
    },
    guards: {
      canPrepare: ({ context, event }) =>
        event.type === "PREPARE" &&
        context.stepIndex < context.stepCount &&
        !context.usedOperationIds.includes(event.operationId) &&
        context.usedOperationIds.length < 96,
      operationMatches: ({ context, event }) => operationMatches(context, event),
      completedNonClick: ({ context, event }) =>
        operationMatches(context, event) && context.operationKind !== "click",
      canSubmit: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind === "click" &&
        context.submissions < context.maxSubmissions,
      clickMatches: ({ context, event }) =>
        operationMatches(context, event) && context.operationKind === "click",
      retryAvailable: ({ context }) => context.retries < context.maxRetries,
      failedClick: ({ context }) => context.operationKind === "click",
      sameScope: ({ context, event }) =>
        event.type === "NAVIGATED" && sameScope(context.document, event.document),
      observedAuthenticated: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "authenticated" &&
        (!event.document || sameScope(context.document, event.document)),
      observedRejected: ({ context, event }) =>
        event.type === "OBSERVED" &&
        ["credential-rejected", "challenge"].includes(event.result) &&
        (!event.document || sameScope(context.document, event.document)),
      observedContinue: ({ context, event }) =>
        event.type === "OBSERVED" &&
        event.result === "continue" &&
        context.stepIndex < context.stepCount &&
        (context.operationKind !== "click" ||
          (context.operationId !== undefined &&
            context.submissions > 0 &&
            context.stepIndex + 1 < context.stepCount)) &&
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
    },
  }).createMachine({
    id: "login-attempt",
    initial: "detected",
    context: ({ input }) => parseAttemptMetadata(input),
    on: {
      POLICY_CHANGED: { target: ".blocked", actions: "record" },
      CANCEL: { target: ".blocked", actions: "record" },
      NAVIGATED: [
        { guard: "sameScope", target: ".reconciling", actions: "record" },
        { target: ".blocked", actions: "invalidNavigation" },
      ],
      INTERRUPTED: { target: ".reconciling", actions: "record" },
    },
    states: {
      detected: { on: { RESOLVE: "ready" } },
      ready: {
        on: {
          PREPARE: { guard: "canPrepare", target: "executing", actions: "record" },
          FAILED: { target: "retryable", actions: "record" },
          OBSERVED: [
            { guard: "observedAuthenticated", target: "authenticated", actions: "record" },
            { guard: "observedRejected", target: "blocked", actions: "record" },
          ],
        },
      },
      executing: {
        on: {
          OPERATION_OK: { guard: "completedNonClick", target: "ready", actions: "record" },
          SUBMIT_INTENT: [
            { guard: "canSubmit", target: "submit-intent", actions: "record" },
            { guard: "clickMatches", target: "blocked", actions: "submissionLimit" },
          ],
          FAILED: [
            { guard: "failedClick", target: "reconciling", actions: "record" },
            { target: "retryable", actions: "record" },
          ],
        },
      },
      "submit-intent": {
        on: {
          SUBMITTED: { guard: "operationMatches", target: "awaiting-result" },
          FAILED: { target: "reconciling", actions: "record" },
        },
      },
      "awaiting-result": {
        on: { OBSERVED: observedTransitions, FAILED: { target: "reconciling", actions: "record" } },
      },
      reconciling: { on: { OBSERVED: observedTransitions } },
      retryable: {
        on: {
          RETRY: [
            { guard: "retryAvailable", target: "ready", actions: "record" },
            { target: "blocked", actions: "retryLimit" },
          ],
        },
      },
      authenticated: { type: "final" },
      blocked: { type: "final" },
    },
  });
}

// The engine has no startup side effects. Schema-only consumers omit XState.
export const loginAttemptMachine = /* @__PURE__ */ createLoginAttemptMachine();

export function createAttemptMetadata(input: {
  id: string;
  recipe: LoginRecipe;
  policyRevision: number;
  account: LoginAccount;
  document: LoginDocument;
}): LoginAttemptMetadata {
  const recipe = parseLoginRecipe(input.recipe);
  if (input.account.origin !== recipe.origin)
    throw new Error("Attempt origin does not match recipe");
  return parseAttemptMetadata({
    version: 1,
    id: input.id,
    recipeId: recipe.id,
    recipeRevision: recipe.revision,
    policyRevision: input.policyRevision,
    account: input.account,
    document: input.document,
    state: "detected",
    stepIndex: 0,
    stepCount: recipe.steps.length,
    submissions: 0,
    maxSubmissions: recipe.maxSubmissions,
    retries: 0,
    maxRetries: 2,
    usedOperationIds: [],
  });
}

export function transitionLoginAttempt(value: unknown, eventValue: unknown): LoginAttemptMetadata {
  const metadata = parseAttemptMetadata(value);
  const event = v.parse(loginAttemptEventSchema, eventValue);
  if (metadata.state === "authenticated" || metadata.state === "blocked") return metadata;
  const snapshot = loginAttemptMachine.resolveState({ value: metadata.state, context: metadata });
  const [next] = transition(loginAttemptMachine, snapshot, event);
  return parseAttemptMetadata({ ...next.context, state: next.value });
}

export function createLoginAttempt(value: unknown) {
  const metadata = parseAttemptMetadata(value);
  const actor = createActor(loginAttemptMachine, {
    input: metadata,
    snapshot: loginAttemptMachine.resolveState({ value: metadata.state, context: metadata }),
  });
  return Object.assign(actor, {
    getMetadata(): LoginAttemptMetadata {
      const snapshot = actor.getSnapshot();
      return parseAttemptMetadata({ ...snapshot.context, state: snapshot.value });
    },
  });
}

/** Restart always observes; it never restores an actor snapshot with pending actions. */
export function recoverLoginAttempt(value: unknown): LoginAttemptMetadata {
  const metadata = parseAttemptMetadata(value);
  return transitionLoginAttempt(metadata, { type: "INTERRUPTED" });
}

export function nextLoginOperation(
  value: unknown,
  recipeValue: unknown,
  document: LoginDocument,
  operationId: string,
  now = Date.now(),
): LoginOperation | undefined {
  const metadata = parseAttemptMetadata(value);
  const recipe = parseLoginRecipe(recipeValue);
  if (
    metadata.state !== "ready" ||
    metadata.retryRequired === true ||
    !sameLoginDocument(metadata.document, document) ||
    metadata.recipeId !== recipe.id ||
    metadata.recipeRevision !== recipe.revision ||
    metadata.account.origin !== recipe.origin ||
    metadata.usedOperationIds.includes(operationId)
  )
    return undefined;
  const step = recipe.steps[metadata.stepIndex];
  if (!step || (step.kind === "click" && metadata.submissions >= metadata.maxSubmissions))
    return undefined;
  return v.parse(loginOperationSchema, {
    version: 1,
    attemptId: metadata.id,
    operationId,
    policyRevision: metadata.policyRevision,
    document,
    stepIndex: metadata.stepIndex,
    step,
    expiresAt: now + 15000,
  });
}

/** Browser identity and current policy must be rechecked immediately before execution. */
export function validateLoginOperation(
  operation: LoginOperation,
  metadata: LoginAttemptMetadata,
  document: LoginDocument,
  policyRevision: number,
  now = Date.now(),
): boolean {
  const parsedOperation = v.safeParse(loginOperationSchema, operation);
  const parsedMetadata = v.safeParse(attemptMetadataSchema, metadata);
  const parsedDocument = v.safeParse(loginDocumentSchema, document);
  if (!parsedOperation.success || !parsedMetadata.success || !parsedDocument.success) return false;
  const readyToExecute =
    operation.step.kind === "click"
      ? metadata.state === "submit-intent"
      : metadata.state === "executing";
  return (
    readyToExecute &&
    operation.attemptId === metadata.id &&
    operation.operationId === metadata.operationId &&
    operation.stepIndex === metadata.stepIndex &&
    operation.step.kind === metadata.operationKind &&
    operation.policyRevision === policyRevision &&
    metadata.policyRevision === policyRevision &&
    sameLoginDocument(operation.document, document) &&
    sameLoginDocument(metadata.document, document) &&
    now < operation.expiresAt &&
    operation.expiresAt <= now + 15000
  );
}
