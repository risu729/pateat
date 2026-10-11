import * as v from "valibot";
import { loginObservationSchema, semanticSlotsSchema } from "./observation";
import { loginRecipeSchema } from "./login";
import { syncRecipeIdSchema } from "./sync";

// Contracts for the service's recipe generation routes (ADR 0018). Requests carry the
// value-free observation and slot meanings only: never values, bindings or item IDs.

const writtenRevision = v.pipe(
  v.number(),
  v.integer(),
  v.minValue(1),
  v.maxValue(Number.MAX_SAFE_INTEGER - 1),
);
/** The active variant of `syncRecipeChangeSchema`, with the same identity check. */
const activeChange = v.pipe(
  v.strictObject({
    recipeId: syncRecipeIdSchema,
    revision: writtenRevision,
    state: v.literal("active"),
    recipe: loginRecipeSchema,
  }),
  v.check(
    (change) => change.recipe.id === change.recipeId && change.recipe.revision === change.revision,
    "Recipe identity does not match its sync revision",
  ),
);

/** Reasons the service did not call the model at all. */
export const generationUnavailableReasonSchema = v.picklist([
  "credentials-not-configured",
  "credentials-rejected",
  "issuer-unavailable",
  /** The token exchange did not complete: network, timeout or an Anthropic error. */
  "token-exchange-failed",
  "monthly-limit",
  "daily-limit",
  "busy",
  "recently-tried",
  "recipe-revoked",
  "recipe-conflict",
  /** A new recipe would exceed the owner's active recipe limit. */
  "recipe-limit",
]);
export const generationFailureSchema = v.picklist([
  "incomplete-observation",
  "invalid-request",
  "input-too-large",
  "invalid-output",
  "refused",
  "truncated",
  "timeout",
  "rate-limited",
  "provider-error",
  "recipe-invalid",
]);

/** `POST /v1/recipes/generate`: one page; `base` continues a recipe after an advance. */
export const recipeGenerationRequestSchema = v.strictObject({
  version: v.literal(1),
  observation: loginObservationSchema,
  slots: semanticSlotsSchema,
  base: v.optional(v.strictObject({ recipeId: syncRecipeIdSchema, revision: writtenRevision })),
});

export const recipeGenerationResultSchema = v.variant("status", [
  v.strictObject({ version: v.literal(1), status: v.literal("recipe"), change: activeChange }),
  v.strictObject({
    version: v.literal(1),
    status: v.literal("abstained"),
    reason: v.picklist([
      "no-login-form",
      "ambiguous",
      "insufficient-evidence",
      "unsafe-instructions",
    ]),
  }),
  v.strictObject({
    version: v.literal(1),
    status: v.literal("failed"),
    error: generationFailureSchema,
  }),
  v.strictObject({
    version: v.literal(1),
    status: v.literal("unavailable"),
    reason: generationUnavailableReasonSchema,
  }),
]);

/**
 * `POST /v1/recipes/:recipeId/completion`: the page shown after the final submission of
 * the given revision, sent once so the service can learn the recipe's completion.
 */
export const recipeCompletionRequestSchema = v.strictObject({
  version: v.literal(1),
  revision: writtenRevision,
  observation: loginObservationSchema,
});

export const recipeCompletionResultSchema = v.variant("status", [
  v.strictObject({ version: v.literal(1), status: v.literal("signed-in"), change: activeChange }),
  v.strictObject({ version: v.literal(1), status: v.literal("rejected") }),
  v.strictObject({ version: v.literal(1), status: v.literal("challenge") }),
  v.strictObject({ version: v.literal(1), status: v.literal("unclear") }),
  v.strictObject({
    version: v.literal(1),
    status: v.literal("failed"),
    error: generationFailureSchema,
  }),
  v.strictObject({
    version: v.literal(1),
    status: v.literal("unavailable"),
    reason: generationUnavailableReasonSchema,
  }),
]);

export type RecipeGenerationRequest = v.InferOutput<typeof recipeGenerationRequestSchema>;
export type RecipeGenerationResult = v.InferOutput<typeof recipeGenerationResultSchema>;
export type RecipeCompletionRequest = v.InferOutput<typeof recipeCompletionRequestSchema>;
export type RecipeCompletionResult = v.InferOutput<typeof recipeCompletionResultSchema>;
export type GenerationUnavailableReason = v.InferOutput<typeof generationUnavailableReasonSchema>;
