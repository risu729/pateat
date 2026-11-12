import * as v from "valibot";
import {
  handlerSteps,
  loginDocumentSchema,
  loginOperationSchema,
  keypadStep,
  loginStepEffect,
  parseLoginRecipe,
  passwordVariants,
  routeSlots,
  routeSteps,
  passwordOnly,
  sameLoginDocument,
  TOTP_HANDLER_SLOT,
  type LoginDocument,
  type LoginOperation,
  type LoginRecipe,
  type LoginRouteChoice,
  type LoginStep,
} from "../login";
import { type LoginAttemptMetadata, parseAttemptMetadata, attemptMetadataSchema } from "./metadata";
import { beforeStop, stepBudget } from "./policy";

/** A step that may advance or submit the page: a click, or a fill whose event may. */
export const effectfulStep = (step: LoginStep): boolean => {
  const effect = loginStepEffect(step);
  return effect !== undefined && effect !== "prepare";
};
/**
 * What a fill-only login takes of `step` (ADR 0021 D): nothing of a step with an effect or
 * of a fill on a page's software keyboard, whose presses the page may act on (ADR 0067),
 * and a fill without its TOTP code, whose input may submit at its last digit as a PIN pad
 * does (ADR 0027 amendment of 2026-10-23); nothing of a fill of the code alone.
 */
export function fillOnlyStep(step: LoginStep): LoginStep | undefined {
  if (effectfulStep(step) || keypadStep(step)) return undefined;
  if (step.kind !== "fill") return step;
  const fields = step.fields.filter((field) => field.slot !== TOTP_HANDLER_SLOT);
  if (fields.length === 0) return undefined;
  return fields.length === step.fields.length ? step : { ...step, fields };
}
/** A step a fill-only login never takes any of (`fillOnlyStep`). */
export const fillOnlyStops = (step: LoginStep): boolean => fillOnlyStep(step) === undefined;

/** The route and variant an attempt recorded when it started. */
export function attemptRouteChoice(
  metadata: Pick<LoginAttemptMetadata, "route" | "variant">,
): LoginRouteChoice {
  if (metadata.route === "passkey") return { route: "passkey" };
  if (metadata.route === "sso") throw new Error("SSO parent has no native execution route");
  // The schema requires a variant for the password route.
  return { route: metadata.route, variant: metadata.variant ?? 0 };
}

/**
 * The slots the attempt's entered handlers fill beside its route's (ADR 0027): `totp` once
 * it entered a `totp` handler. A login's binding covers them too; they are never saved.
 */
export function handlerSlots(
  recipe: LoginRecipe,
  metadata: Pick<LoginAttemptMetadata, "handlers">,
): string[] {
  return metadata.handlers.some((entry) => recipe.handlers?.[entry.index]?.kind === "totp")
    ? [TOTP_HANDLER_SLOT]
    : [];
}
/**
 * Whether the login types a TOTP code already: its route fills the `totp` slot, or it
 * entered a `totp` handler. A login types one code at most, so a wrong code is never
 * retried into a lockout (ADR 0027).
 */
export function attemptUsesCode(
  recipe: LoginRecipe,
  metadata: Pick<LoginAttemptMetadata, "route" | "variant" | "handlers">,
): boolean {
  return (
    routeSlots(recipe, attemptRouteChoice(metadata)).includes(TOTP_HANDLER_SLOT) ||
    handlerSlots(recipe, metadata).length > 0
  );
}

/**
 * The attempt's steps: its route's steps, with each entered handler's steps inserted at
 * its `start`, in the order they were entered. `handler` is the recipe handler index of a
 * handler's step. Undefined when an entered handler is missing from the recipe.
 */
export function attemptPlan(
  recipe: LoginRecipe,
  metadata: Pick<
    LoginAttemptMetadata,
    "route" | "variant" | "handlers" | "startStep" | "startPartial"
  >,
): { step: LoginStep; handler?: number }[] | undefined {
  // A login that started with its step's password alone fills only that there.
  const started = (step: LoginStep | undefined): LoginStep | undefined =>
    metadata.startPartial && step?.kind === "fill" ? passwordOnly(step) : step;
  // A page's own passkey request answered on a later start stands on that step (ADR 0049).
  const from =
    metadata.route === "passkey" && metadata.startStep !== undefined
      ? started(passwordVariants(recipe)[metadata.variant ?? 0]?.steps[metadata.startStep])
      : undefined;
  const plan: { step: LoginStep; handler?: number }[] = routeSteps(
    recipe,
    attemptRouteChoice(metadata),
    from,
  ).map((step) => ({ step }));
  if (metadata.route === "password" && metadata.startStep !== undefined && metadata.startPartial) {
    const step = started(plan[metadata.startStep]?.step);
    if (!step) return undefined;
    plan[metadata.startStep] = { step };
  }
  for (const entry of metadata.handlers) {
    const handler = recipe.handlers?.[entry.index];
    if (!handler || entry.start > plan.length) return undefined;
    plan.splice(
      entry.start,
      0,
      ...handlerSteps(handler, entry.field).map((step) => ({ step, handler: entry.index })),
    );
  }
  return plan;
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
    metadata.layout !== recipe.layout ||
    metadata.account.origin !== recipe.origin ||
    metadata.usedOperationIds.includes(operationId)
  )
    return undefined;
  // The machine cannot see the recipe, so the plan's length checks the recorded handlers.
  const plan = attemptPlan(recipe, metadata);
  const step = plan?.length === metadata.stepCount ? plan[metadata.stepIndex]?.step : undefined;
  if (
    !step ||
    // The step that fills the password of an item without one, and every later step, never
    // runs (ADR 0036).
    !beforeStop(metadata, metadata.stepIndex) ||
    // A fill-only attempt never takes a step with an effect, a keypad or a code (ADR 0021 D).
    ((metadata.fillOnly === true || metadata.signInFill === true) && fillOnlyStops(step)) ||
    (effectfulStep(step) && metadata.submissions >= stepBudget(metadata))
  )
    return undefined;
  return v.parse(loginOperationSchema, {
    version: 1,
    attemptId: metadata.id,
    operationId,
    policyRevision: metadata.policyRevision,
    document,
    stepIndex: metadata.stepIndex,
    // A fill-only attempt fills a step's other fields without its code.
    step: metadata.fillOnly === true || metadata.signInFill === true ? fillOnlyStep(step) : step,
    ...(metadata.signInFill ? { signInFill: true } : {}),
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
    !(
      (metadata.fillOnly === true || metadata.signInFill === true) &&
      fillOnlyStep(operation.step) !== operation.step
    ) &&
    operation.signInFill === metadata.signInFill &&
    beforeStop(metadata, operation.stepIndex) &&
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
