import * as v from "valibot";
import { assign, createActor, setup, transition } from "xstate";
import {
  loginAccountSchema,
  loginDocumentSchema,
  loginOperationSchema,
  loginOutcomeSchema,
  loginStepEffect,
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
    operationEffect: v.optional(v.picklist(["prepare", "advance", "submit"])),
    mutationIntent: v.optional(v.literal(true)),
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
      metadata.operationKind === "click" ||
      (metadata.operationKind === "fill" &&
        ["advance", "submit"].includes(metadata.operationEffect ?? "prepare")),
    "Submission state requires an effectful operation",
  ),
  v.check(
    (metadata) =>
      (metadata.operationEffect === undefined && metadata.mutationIntent === undefined) ||
      metadata.operationKind === "fill" ||
      metadata.operationKind === "click",
    "Mutation metadata requires a fill or click operation",
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
    effect: v.optional(v.picklist(["prepare", "advance", "submit"])),
  }),
  v.strictObject({ type: v.literal("MUTATION_INTENT"), operationId: identifier }),
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
    mutation: v.optional(v.picklist(["none", "possible"])),
    operationId: v.optional(identifier),
    document: v.optional(loginDocumentSchema),
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
const confirmedNoMutation = (context: LoginAttemptMetadata, event: LoginAttemptEvent) =>
  event.type === "FAILED" &&
  event.mutation === "none" &&
  operationMatches(context, event) &&
  event.document !== undefined &&
  sameLoginDocument(context.document, event.document);

function record(
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
        };
      return {
        document: event.document ?? context.document,
        outcome: event.result === "unknown" ? "unknown-submit" : event.result,
      };
    case "NAVIGATED":
      return {
        document: sameScope(context.document, event.document) ? event.document : context.document,
        outcome:
          context.mutationIntent ||
          context.operationKind === "fill" ||
          (context.operationKind === "click" && context.submissions > 0)
            ? "unknown-submit"
            : "interrupted",
      };
    case "INTERRUPTED":
      return {
        outcome:
          context.mutationIntent ||
          context.operationKind === "fill" ||
          (context.operationKind === "click" && context.submissions > 0)
            ? "unknown-submit"
            : "interrupted",
      };
    case "FAILED":
      return {
        outcome: event.reason,
        // A trusted preflight failure proves that this fill never initiated its
        // reserved effect. Keep its used ID and the independent retry budget.
        submissions:
          confirmedNoMutation(context, event) &&
          context.mutationIntent === true &&
          context.operationKind === "fill" &&
          ["advance", "submit"].includes(context.operationEffect ?? "prepare")
            ? context.submissions - 1
            : context.submissions,
        mutationIntent: confirmedNoMutation(context, event) ? undefined : context.mutationIntent,
        retryRequired:
          context.operationKind !== "click" &&
          (!context.mutationIntent || confirmedNoMutation(context, event))
            ? true
            : context.retryRequired,
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
        context.submissions < context.maxSubmissions,
      effectfulFill: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind === "fill" &&
        context.operationEffect !== "prepare",
      canSubmit: ({ context, event }) =>
        operationMatches(context, event) &&
        context.operationKind === "click" &&
        context.submissions < context.maxSubmissions,
      clickMatches: ({ context, event }) =>
        operationMatches(context, event) && context.operationKind === "click",
      retryAvailable: ({ context }) => context.retries < context.maxRetries,
      failedPossibleMutation: ({ context, event }) =>
        context.operationKind === "click" ||
        (context.mutationIntent === true && !confirmedNoMutation(context, event)),
      staleFailure: ({ context, event }) =>
        event.type === "FAILED" &&
        ((event.operationId !== undefined && event.operationId !== context.operationId) ||
          (event.document !== undefined && !sameLoginDocument(context.document, event.document))),
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
          FAILED: [{ guard: "staleFailure" }, { target: "retryable", actions: "record" }],
          OBSERVED: [
            { guard: "observedAuthenticated", target: "authenticated", actions: "record" },
            { guard: "observedRejected", target: "blocked", actions: "record" },
          ],
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
        },
      },
      "awaiting-result": {
        on: {
          OBSERVED: observedTransitions,
          FAILED: [{ guard: "staleFailure" }, { target: "reconciling", actions: "record" }],
        },
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
  if (
    !step ||
    (loginStepEffect(step) !== undefined &&
      loginStepEffect(step) !== "prepare" &&
      metadata.submissions >= metadata.maxSubmissions)
  )
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
    loginStepEffect(operation.step) !== undefined && loginStepEffect(operation.step) !== "prepare"
      ? metadata.state === "submit-intent"
      : metadata.state === "executing";
  return (
    readyToExecute &&
    (!(operation.step.kind === "fill" || operation.step.kind === "click") ||
      metadata.mutationIntent === true) &&
    operation.attemptId === metadata.id &&
    operation.operationId === metadata.operationId &&
    operation.stepIndex === metadata.stepIndex &&
    operation.step.kind === metadata.operationKind &&
    loginStepEffect(operation.step) === metadata.operationEffect &&
    operation.policyRevision === policyRevision &&
    metadata.policyRevision === policyRevision &&
    sameLoginDocument(operation.document, document) &&
    sameLoginDocument(metadata.document, document) &&
    now < operation.expiresAt &&
    operation.expiresAt <= now + 15000
  );
}
