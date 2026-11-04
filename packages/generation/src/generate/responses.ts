import {
  type DeviceModelCall,
  type EntryGenerationResult,
  type GenerationUnavailableReason,
  type LogoutGenerationResult,
  type RecipeCompletionResult,
  type RecipeGenerationResult,
  type SyncRecipeChange,
} from "@pateat/contracts";
import {
  claudeRefusalCategory,
  outputRejection,
  type InferenceErrorCode,
  type InferenceOutcome,
} from "@pateat/inference";
import {
  MAX_OUTPUT_TOKENS,
  ROLE_LIMITS,
  type GenerationBackend,
  type UnsentRequest,
} from "../backend";

type Failure = Extract<RecipeGenerationResult, { status: "failed" }>["error"];
/** An answer given without a model call: a refusal, a failure, or a stored recipe. */
export type UnsentAnswer = Extract<
  RecipeGenerationResult | EntryGenerationResult | RecipeCompletionResult | LogoutGenerationResult,
  { status: "unavailable" | "failed" | "recipe" }
>;

export const roleConfig = {
  limits: ROLE_LIMITS,
  maxOutputTokens: MAX_OUTPUT_TOKENS,
  refusalCategory: claudeRefusalCategory,
};

/**
 * Answers without a model call, logging the request under the answer's code (ADR 0012,
 * owner 2026-10-18 08:04 UTC): the reason or failure code, or `recipe` for a recipe
 * another request stored.
 */
export async function answerUnsent<Answer extends UnsentAnswer>(
  backend: GenerationBackend,
  unsent: UnsentRequest,
  answer: Answer,
) {
  await backend.logUnsent(
    unsent,
    answer.status === "unavailable"
      ? answer.reason
      : answer.status === "failed"
        ? answer.error
        : answer.status,
  );
  return answer;
}

export const unavailable = (reason: GenerationUnavailableReason) =>
  ({ version: 1, status: "unavailable", reason }) as const;
export const failed = (error: Failure) => ({ version: 1, status: "failed", error }) as const;
// Nobody waits on a cancelled request, so it reads as the timeout that usually causes it.
export const failureOf = (error: InferenceErrorCode): Failure =>
  error === "cancelled" ? "timeout" : error;
/** The model call a device with its own key makes next (ADR 0040). */
export const modelCall = (call: { call: DeviceModelCall["call"] }) =>
  ({ version: 1, status: "model-call", call: call.call }) as const;
export const active = (change: SyncRecipeChange | null) =>
  change?.state === "active" ? change : undefined;
/**
 * An active head a generation or judgement answers with: a route recipe, or a chooser
 * recipe (ADR 0028) for an account list or one of its branches. An entry recipe (ADR 0031)
 * or a logout recipe (ADR 0063) is never one.
 */
export const answerable = (
  change: SyncRecipeChange | null,
): Extract<RecipeGenerationResult, { status: "recipe" }>["change"] | undefined => {
  const head = active(change);
  return head && !("entry" in head.recipe) && !("logout" in head.recipe)
    ? { ...head, recipe: head.recipe }
    : undefined;
};

/**
 * The answer of a call that produced no value: failed, with the check that refused the
 * model's output (codes only), or abstained.
 */
export function unsettled<T>(
  outcome: InferenceOutcome<T>,
): { answer: RecipeGenerationResult & EntryGenerationResult } | { value: T } {
  if (outcome.status === "failed") {
    // Which check refused the model's output, so the device can log it (codes only).
    const rejection = outputRejection(outcome);
    return { answer: { ...failed(failureOf(outcome.error)), ...(rejection ? { rejection } : {}) } };
  }
  if (outcome.status === "abstained")
    return {
      answer: {
        version: 1,
        status: "abstained",
        // The generation role abstains only with these; anything else is not evidence.
        reason:
          outcome.reason === "no-login-form" ||
          outcome.reason === "ambiguous" ||
          outcome.reason === "unsafe-instructions"
            ? outcome.reason
            : "insufficient-evidence",
      },
    };
  return { value: outcome.value };
}
