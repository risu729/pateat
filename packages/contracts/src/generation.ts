import * as v from "valibot";
import {
  fillRoles,
  genericSlotIdSchema,
  loginObservationSchema,
  semanticSlotsSchema,
  type LoginObservation,
} from "./observation";
import {
  chooserBranchSchema,
  loginChooserRecipeSchema,
  loginEntryRecipeSchema,
  loginRecipeSchema,
  loginRouteSchema,
  storedRecipeSlots,
} from "./login";
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
const sameIdentity = (change: {
  recipeId: string;
  revision: number;
  recipe: { id: string; revision: number };
}) => change.recipe.id === change.recipeId && change.recipe.revision === change.revision;
/**
 * The active variant of `syncRecipeChangeSchema`, with the same identity check: a route
 * recipe, or a chooser recipe (ADR 0028) for an account list or one of its branches.
 */
const activeChange = v.pipe(
  v.strictObject({
    recipeId: syncRecipeIdSchema,
    revision: writtenRevision,
    state: v.literal("active"),
    // An entry recipe (ADR 0031) answers only an entry request (`activeEntryChange`).
    recipe: v.union([loginRecipeSchema, loginChooserRecipeSchema]),
  }),
  v.check((change) => sameIdentity(change), "Recipe identity does not match its sync revision"),
);
/** The same for an entry recipe (ADR 0031), which only an entry request is answered with. */
const activeEntryChange = v.pipe(
  v.strictObject({
    recipeId: syncRecipeIdSchema,
    revision: writtenRevision,
    state: v.literal("active"),
    recipe: loginEntryRecipeSchema,
  }),
  v.check((change) => sameIdentity(change), "Recipe identity does not match its sync revision"),
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
  /**
   * This recipe revision's page on this origin and path was already judged once with the
   * current judge prompt (ADR 0027), and the model could not decide it.
   */
  "already-judged",
  /**
   * As `already-judged`, and that judgement was `signed-in`, so a page of another origin
   * that a login moved to completes it again (ADR 0022).
   */
  "judged-signed-in",
  /**
   * As `already-judged`, and that judgement was `challenge`: the page asks for a step the
   * person takes, so it never completes a login (ADR 0029).
   */
  "judged-challenge",
  /** As `judged-challenge`, for a judgement of `rejected` (ADR 0029). */
  "judged-rejected",
  /**
   * As `already-judged`, and that request has no verdict: it failed, or it is still being
   * judged after the owner's lock expired (ADR 0029).
   */
  "judgement-unanswered",
  /** The recipe's pages were judged 20 times this UTC day (ADR 0027). */
  "judgement-limit",
  /**
   * The page still shows the route's fill fields, its passkey button on its path, or a
   * signed-in marker (ADR 0027, ADR 0029).
   */
  "not-judgeable",
  "recipe-revoked",
  "recipe-conflict",
  /** The owner's recipe count or bytes would exceed the service limit. */
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

const rejectionCode = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,47}$/u));
/**
 * Why the service refused the model's output as `invalid-output`, as codes only: `json`
 * when the output was not JSON; `schema` with the type of the first Valibot issue of the
 * output format, such as `max-length`, and where it was, as the output's keys in kebab
 * case and array indexes joined by dots (empty at the top, and ending before a key the
 * format does not define at that place, the issue then being `unknown-key`); or `plan`
 * with the code of the plan check that refused it, such as `incompatible-role`. Never
 * the output's text.
 */
export const generationOutputRejectionSchema = v.variant("check", [
  v.strictObject({ check: v.literal("json") }),
  v.strictObject({
    check: v.literal("schema"),
    issue: rejectionCode,
    path: v.pipe(
      v.string(),
      v.regex(/^(?:(?:[a-z][a-z-]{0,31}|\d{1,3})(?:\.(?:[a-z][a-z-]{0,31}|\d{1,3})){0,7})?$/u),
    ),
  }),
  v.strictObject({ check: v.literal("plan"), reason: rejectionCode }),
]);

/**
 * `POST /v1/recipes/generate`: one page; `base` continues a recipe after an advance. With
 * `branch`, `base` is a chooser recipe (ADR 0028) and the page is the next one of that
 * branch: its first page, after the click on the list, or a later one.
 */
export const recipeGenerationRequestSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    observation: loginObservationSchema,
    slots: semanticSlotsSchema,
    base: v.optional(v.strictObject({ recipeId: syncRecipeIdSchema, revision: writtenRevision })),
    branch: v.optional(chooserBranchSchema),
  }),
  v.check((request) => !request.branch || request.base !== undefined, "A branch needs a base"),
);

/**
 * Whether an observation can be sent without slots, as a page's sign-in entry (ADR 0031):
 * it shows no field to fill and lists no accounts (ADR 0028).
 */
export const isEntryObservation = (observation: LoginObservation) =>
  observation.accounts === undefined &&
  !observation.candidates.some((candidate) =>
    (fillRoles as readonly string[]).includes(candidate.role),
  );

/**
 * `POST /v1/recipes/generate` without `slots`: an entry request (ADR 0031), a page without
 * a login form whose answer names the link that opens the site's login page. Nothing of
 * the vault is offered, so the page shows no field to fill, and it never continues a
 * recipe (`base`, `branch`). Every other request offers slots.
 */
export const entryGenerationRequestSchema = v.pipe(
  v.strictObject({ version: v.literal(1), observation: loginObservationSchema }),
  v.check(
    (request) => isEntryObservation(request.observation),
    "An entry request's page shows no field and lists no accounts",
  ),
);

/**
 * Every body `POST /v1/recipes/generate` takes: a page with slots, or an entry request.
 * Strict objects keep them apart, so a request without slots is always an entry request.
 */
export const generationRequestSchema = v.union([
  recipeGenerationRequestSchema,
  entryGenerationRequestSchema,
]);

/** Answers that are not a recipe, shared by page and entry requests. */
const generationAnswers = [
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
    /** For `invalid-output`: which check refused the model's output, and why. */
    rejection: v.optional(generationOutputRejectionSchema),
  }),
  v.strictObject({
    version: v.literal(1),
    status: v.literal("unavailable"),
    reason: generationUnavailableReasonSchema,
  }),
] as const;
const rejectsOnlyInvalidOutput = (result: {
  status: string;
  error?: string;
  rejection?: unknown;
}) =>
  result.status !== "failed" || result.rejection === undefined || result.error === "invalid-output";

/**
 * The answer to a request with slots: a recipe with a login route or a chooser recipe,
 * never an entry recipe (ADR 0031).
 */
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
    ...generationAnswers,
  ]),
  v.check((result) => rejectsOnlyInvalidOutput(result), "Only invalid output has a rejection"),
  v.check(
    (result) =>
      result.status !== "recipe" ||
      (result.customSlots ?? []).every((entry) =>
        storedRecipeSlots(result.change.recipe).includes(entry.slot),
      ),
    "Custom slots must be recipe slots",
  ),
);

/**
 * The answer to an entry request (ADR 0031): the entry recipe of the page's origin and
 * path, which fills nothing and so maps no custom slot, never another kind of recipe.
 */
export const entryGenerationResultSchema = v.pipe(
  v.variant("status", [
    v.strictObject({
      version: v.literal(1),
      status: v.literal("recipe"),
      change: activeEntryChange,
    }),
    ...generationAnswers,
  ]),
  v.check((result) => rejectsOnlyInvalidOutput(result), "Only invalid output has a rejection"),
);

/**
 * `POST /v1/recipes/:recipeId/completion`: a page shown after an effect step of the given
 * revision that no recipe check explained, judged at most once per revision, origin, path
 * and judge prompt version so the service can learn a signed-in marker or a handler (ADR
 * 0018, ADR 0027, ADR 0029). The page is on the recipe's origin, or on another HTTPS origin
 * that a `password` login's tab moved to right after the submission: of its site, or of
 * another site right after a second factor (ADR 0022).
 */
export const recipeCompletionRequestSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    revision: writtenRevision,
    /** The login's route; the service checks the stored recipe has it. */
    route: loginRouteSchema,
    /** For a chooser recipe (ADR 0028): the branch the login took, whose route is judged. */
    branch: v.optional(chooserBranchSchema),
    observation: loginObservationSchema,
    /**
     * The description left out a disabled field that may not be a sign-in field (ADR 0029):
     * a page the model cannot decide is judged again when the path is next described in
     * full.
     */
    partial: v.optional(v.literal(true)),
    /**
     * The page is a `password` login's stop before its item's missing password, with no
     * passkey request in time, still showing the stop step's password field (ADR 0036, owner
     * 2026-10-13 05:39 UTC). The service judges such a page though it shows the route's
     * password field, and keeps only a `passkey` handler from it. Like the `passkey` route's
     * name, it tells the service that the login's item has no password but a passkey.
     */
    stop: v.optional(v.literal(true)),
  }),
  v.check(
    (request) => request.stop !== true || (request.route === "password" && !request.branch),
    "A stop is a password login's without a chooser",
  ),
);

/**
 * `POST /v1/recipes/:recipeId/page-sample`: the signed-in page of a login of the given
 * revision that its signed-in marker completed without a model call, kept in the request
 * log for evaluation and never sent to a model (ADR 0029, owner 2026-10-18 08:05 UTC). The
 * page is on the recipe's origin and described as the judge's page is. The service keeps
 * one per recipe and branch in `PAGE_SAMPLE_INTERVAL_MS` and answers 201 when it kept this
 * one, 204 when it already had one.
 */
export const recipePageSampleRequestSchema = v.strictObject({
  version: v.literal(1),
  revision: writtenRevision,
  /** The login's route, as the judge is told it; the service checks the revision has it. */
  route: loginRouteSchema,
  /** For a chooser recipe (ADR 0028): the branch the login took. */
  branch: v.optional(chooserBranchSchema),
  observation: loginObservationSchema,
});

export const recipeCompletionResultSchema = v.variant("status", [
  /**
   * `change` is the recipe with the page's marker added (ADR 0029); absent when the recipe
   * has that marker or four already.
   */
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
export type EntryGenerationRequest = v.InferOutput<typeof entryGenerationRequestSchema>;
export type EntryGenerationResult = v.InferOutput<typeof entryGenerationResultSchema>;
export type RecipeCompletionRequest = v.InferOutput<typeof recipeCompletionRequestSchema>;
export type RecipeCompletionResult = v.InferOutput<typeof recipeCompletionResultSchema>;
export type RecipePageSampleRequest = v.InferOutput<typeof recipePageSampleRequestSchema>;
export type GenerationOutputRejection = v.InferOutput<typeof generationOutputRejectionSchema>;
export type GenerationUnavailableReason = v.InferOutput<typeof generationUnavailableReasonSchema>;
