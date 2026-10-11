import * as v from "valibot";
import { genericSlotIdSchema, loginObservationSchema, semanticSlotsSchema } from "./observation";
import { loginRecipeSchema, loginRouteSchema, recipeSlots } from "./login";
import { syncRecipeIdSchema } from "./sync";

// Contracts for the service's recipe generation routes (ADR 0018). Requests carry the
// value-free observation and slot meanings only: never values, bindings or item IDs.

const slotReference = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(64),
  v.regex(/^[a-zA-Z0-9_.:-]+$/u),
);
const unique = (values: string[]) => new Set(values).size === values.length;

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
  /** This recipe revision's page on this path was already judged once (ADR 0027). */
  "already-judged",
  /** The recipe's pages were judged 20 times this UTC day (ADR 0027). */
  "judgement-limit",
  /** The page still shows the route's fill fields or the completion marker (ADR 0027). */
  "not-judgeable",
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

export const recipeGenerationResultSchema = v.pipe(
  v.variant("status", [
    v.strictObject({
      version: v.literal(1),
      status: v.literal("recipe"),
      change: activeChange,
      /**
       * Each recipe slot this call named for a custom-field offer, and the request slot it
       * fills (ADR 0027). The extension turns it into a binding; the recipe itself never
       * carries field names. Absent when the answer is a recipe another request produced.
       */
      customSlots: v.optional(
        v.pipe(
          v.array(v.strictObject({ slot: genericSlotIdSchema, offered: slotReference })),
          v.minLength(1),
          // One page plan fills at most 8 fields in each of up to 4 variants, and a request
          // offers at most 16 custom fields (ADR 0027).
          v.maxLength(16),
          v.check((entries) => unique(entries.map((entry) => entry.slot)), "Duplicate slots"),
          v.check(
            (entries) => unique(entries.map((entry) => entry.offered)),
            "Duplicate offered slots",
          ),
        ),
      ),
    }),
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
  ]),
  v.check(
    (result) =>
      result.status !== "recipe" ||
      (result.customSlots ?? []).every((entry) =>
        recipeSlots(result.change.recipe).includes(entry.slot),
      ),
    "Custom slots must be recipe slots",
  ),
);

/**
 * `POST /v1/recipes/:recipeId/completion`: a page shown after an effect step of the given
 * revision that no recipe check explained, judged at most once per revision and path so
 * the service can learn the recipe's completion or a handler (ADR 0018, ADR 0027).
 */
export const recipeCompletionRequestSchema = v.strictObject({
  version: v.literal(1),
  revision: writtenRevision,
  /** The login's route; the service checks the stored recipe has it. */
  route: loginRouteSchema,
  observation: loginObservationSchema,
});

export const recipeCompletionResultSchema = v.variant("status", [
  /** `change` is the recipe with its learned completion; absent when it already had one. */
  v.strictObject({
    version: v.literal(1),
    status: v.literal("signed-in"),
    change: v.optional(activeChange),
  }),
  v.strictObject({ version: v.literal(1), status: v.literal("rejected") }),
  /**
   * `change` is the recipe with a handler added for the judged page; the login that sent
   * the page may take it over (ADR 0027).
   */
  v.strictObject({
    version: v.literal(1),
    status: v.literal("challenge"),
    change: v.optional(activeChange),
  }),
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
