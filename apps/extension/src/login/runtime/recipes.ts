import * as v from "valibot";
import {
  attemptPlan,
  builtInLoginSlots,
  findLoginBinding,
  loginFieldSource,
  loginObservationSchema,
  TOTP_HANDLER_SLOT,
  type LoginBindingTemplate,
  type LoginAttemptMetadata,
  type LoginObservation,
  type ChooserBranch,
  type LoginChooserRecipe,
  type LoginRecipe,
  type LoginRoute,
  type LoginStep,
  type LoginTarget,
  type LocalSettings,
  type EntryGenerationRequest,
  type LoginEntryRecipe,
  type RecipeGenerationRequest,
  type SavedLoginBinding,
  type SemanticSlot,
  type VaultConnectionMetadata,
  type VaultItemMetadata,
} from "@pateat/contracts";

/**
 * Where one recipe starts: its start path and the first step of each of its routes and
 * variants, all on that path (ADR 0027).
 */
/**
 * Where a recipe starts: its first steps, or for a chooser recipe (ADR 0028) no steps and
 * `list`, the list's own buttons, when it shows the list of accounts.
 */
export type LoginRecipeStart = { path: string; steps: LoginStep[]; list?: LoginTarget[] };
/**
 * Cached recipes. Account bindings come from synced settings (`settings.bindings`,
 * ADR 0013); neither carries values.
 */
export interface LoginRecipes {
  /** The recipe for a document, or an attempt's own recipe by ID after navigation. */
  recipe(origin: string, path: string, recipeId?: string): Promise<LoginRecipe | undefined>;
  /** Where every recipe for the origin starts; a document watches for its first steps. */
  starts(origin: string): Promise<LoginRecipeStart[]>;
  /**
   * The chooser recipe (ADR 0028) whose list shows on the path, or a chooser login's own
   * recipe by ID after navigation.
   */
  chooser?(
    origin: string,
    path: string,
    recipeId?: string,
  ): Promise<LoginChooserRecipe | undefined>;
  /** The origin's entry recipes (ADR 0031): a start path and the link pressed there. */
  entries(origin: string): Promise<LoginEntryRecipe[]>;
}
export const noLoginRecipes: LoginRecipes = {
  recipe: async () => undefined,
  starts: async () => [],
  entries: async () => [],
};

/**
 * Why a page is not sent now: no paired service, its request is in flight, or a request
 * for it reached the model within the retry window (ADR 0016).
 */
export type GenerationHold = "not-connected" | "sending" | "sent";
/**
 * What came of one page offered for generation: the model's recipe, with the fields its
 * custom slots name remembered for `slotFields` and the recipe cache pulled once (a failed
 * pull is not reported, so the cache may not hold it yet: a continuation's login takes the
 * returned recipe itself), or its abstention, a failure or refusal with its code, or why
 * nothing was sent, for the local log. `retry` marks a page left free to send again: its
 * request did not reach the model, or it was not sent because no service is paired,
 * storage could not be written or a request for it is still in flight (ADR 0016); a
 * continuation's login then gives its request back for a later document to send (ADR
 * 0018). A continuation of a revoked or since-changed recipe is not marked.
 */
export type GenerationOutcome =
  /** A route recipe, or a chooser recipe for a list of accounts (ADR 0028). */
  | { outcome: "recipe"; recipe: LoginRecipe | LoginChooserRecipe }
  | {
      outcome: "abstained" | "failed" | "unavailable" | "skipped";
      reason: string;
      retry?: true;
    }
  | {
      outcome: "failed";
      reason: "invalid-output";
      /** Which check refused the model's output (`json`, `schema` or `plan`). */
      check: "json" | "schema" | "plan";
      /** The plan check's code or the output format's issue. */
      detail?: string;
      /** For an output format issue: where in the output it was. */
      path?: string;
      /** Refused output came from a model call, so the page is never left free. */
      retry?: never;
    };

/** What came of a page sent as a site's sign-in entry (ADR 0031): its entry recipe, or not. */
export type EntryGenerationOutcome =
  | { outcome: "recipe"; recipe: LoginEntryRecipe }
  | Exclude<GenerationOutcome, { outcome: "recipe" }>;

/** An outcome's fields for the local log: never the recipe itself or `retry`. */
export function outcomeFields(answer: GenerationOutcome | EntryGenerationOutcome) {
  if (answer.outcome === "recipe") return { outcome: answer.outcome };
  if (!("check" in answer)) return { outcome: answer.outcome, reason: answer.reason };
  const { outcome, reason, check, detail, path } = answer;
  return {
    outcome,
    reason,
    check,
    ...(detail === undefined ? {} : { detail }),
    ...(path === undefined ? {} : { path }),
  };
}

/**
 * A page's description as generation may send it (ADR 0016), or why not as a value-free
 * code for the log's `detail` (ADR 0019): `invalid-observation` when it fails its check,
 * the extractor's `gap` when it is incomplete (`incomplete` without one), and for a
 * complete one `origin-changed` or `path-changed` when it describes another origin or path
 * than expected, or `list-mismatch` when `list` is given and the description lists
 * accounts on a page not announced as a list, or none on one that was.
 */
export function acceptedObservation(
  described: { readonly observation: unknown; readonly gap?: string | undefined },
  expected: { readonly origin: string; readonly path: string; readonly list?: boolean },
): { observation: LoginObservation } | { detail: string } {
  const parsed = v.safeParse(loginObservationSchema, described.observation);
  if (!parsed.success) return { detail: "invalid-observation" };
  const observation = parsed.output;
  if (!observation.complete) return { detail: described.gap ?? "incomplete" };
  if (observation.origin !== expected.origin) return { detail: "origin-changed" };
  if (observation.path !== expected.path) return { detail: "path-changed" };
  if (expected.list !== undefined && (observation.accounts !== undefined) !== expected.list)
    return { detail: "list-mismatch" };
  return { observation };
}

/** The service's recipe generation routes (ADR 0016, ADR 0018). */
export interface LoginGeneration {
  /** `true` when a page may be sent, else why not. */
  available(origin: string, path: string): Promise<true | GenerationHold>;
  /**
   * Sends one page: a recipe's first page, or with `base` the page after the final
   * `advance` step of that revision, which continues it. A continuation pulls recipes only,
   * so the login it belongs to is not stopped by a settings write. `sent` is called just
   * before the request leaves the device, for the local log (ADR 0019).
   */
  generate(request: RecipeGenerationRequest, sent?: () => void): Promise<GenerationOutcome>;
  /**
   * Sends a page without a login form, without slots (ADR 0031); its answer names the
   * page's sign-in entry. Claimed and held as `generate` claims a first page.
   */
  generateEntry(
    request: EntryGenerationRequest,
    sent?: () => void,
  ): Promise<EntryGenerationOutcome>;
  /**
   * Which vault field each custom slot of a recipe generated from this device names, from
   * the request that produced it (ADR 0027); nothing for a recipe it did not generate.
   */
  slotFields(recipeId: string): Promise<LoginBindingTemplate | undefined>;
  /**
   * Sends a page no recipe check explained after an effect step, so the service can
   * learn a signed-in marker or a handler (ADR 0027). `recipe` is the newer
   * revision with a handler added, already in the recipe cache. `sent` is called just
   * before the request leaves the device.
   */
  judge(
    recipeId: string,
    revision: number,
    route: LoginRoute,
    observation: LoginObservation,
    sent?: () => void,
    /** For a chooser login (ADR 0028): the branch whose route is judged. */
    branch?: ChooserBranch,
    /**
     * The description left out a disabled field that may not be a sign-in field: the
     * service keeps the model's abstention as `partial`, so a page of the path described
     * in full is judged again (ADR 0029).
     */
    partial?: true,
    /**
     * The page of a login's stop before its item's missing password, which still shows the
     * stop step's password field: the service keeps only a `passkey` handler from it (ADR
     * 0036, owner 2026-10-13 05:39 UTC).
     */
    stop?: true,
  ): Promise<{
    /**
     * `retry` for a temporary refusal before any model call, which gives the page back:
     * no paired service, a rejected device, an unreachable or busy service, the service's
     * own request limit, or a request that failed before the model. `unclear` covers
     * every other answer, including permanent refusals and failed model calls.
     */
    verdict: "signed-in" | "rejected" | "challenge" | "unclear" | "retry";
    /** For `retry` and `unclear`: the refusal or failure code, for the local log. */
    reason?: string;
    /** A chooser login's is the whole chooser (ADR 0028). */
    recipe?: LoginRecipe | LoginChooserRecipe;
  }>;
}

/**
 * Slot meanings sent for generation, each read from the vault item's built-in field of
 * the same name by `defaultLoginBinding`.
 */
export const generationSlots: { slot: SemanticSlot; fieldId: string }[] = [
  { slot: builtInLoginSlots.username, fieldId: "login.username" },
  { slot: builtInLoginSlots.password, fieldId: "login.password" },
  { slot: builtInLoginSlots.totp, fieldId: "login.totp-code" },
];
/**
 * Whether a matching item offers a generation slot's built-in field. The password counts
 * only when it holds a value and is not excluded (ADR 0027); the TOTP field counts when
 * present, so the TOTP flag never decides what the model is offered.
 */
export function offersGenerationField(
  settings: LocalSettings,
  entry: { connectionId: string; item: VaultItemMetadata },
  fieldId: string,
): boolean {
  const field = entry.item.fields.find((candidate) => candidate.id === fieldId);
  if (!field) return false;
  if (fieldId !== "login.password") return true;
  return (
    field.empty !== true &&
    !settings.connections.some(
      (connection) =>
        connection.connectionId === entry.connectionId &&
        connection.excludedFields.some(
          (ref) => ref.itemId === entry.item.id && ref.fieldId === fieldId,
        ),
    )
  );
}
/**
 * The field a `totp` handler fills for the login's item (ADR 0027): its built-in TOTP
 * field, or the synthetic probe item's `totp` field. Undefined when the item has none, or
 * when the item's saved binding for the recipe names another field for `totp`: Pateat
 * cannot make a code from a custom field yet, so it never types such a field's raw value,
 * which could be a TOTP seed.
 */
export function codeFieldOf(
  connection: VaultConnectionMetadata,
  itemId: string,
  bindings: readonly SavedLoginBinding[],
  recipe: LoginRecipe,
): string | undefined {
  const item = connection.items.find((entry) => entry.id === itemId);
  if (!item) return undefined;
  if (connection.provider === "dummy")
    return item.fields.some((field) => field.id === "totp") ? "totp" : undefined;
  if (connection.provider !== "bitwarden" || !connection.userId) return undefined;
  const saved = findLoginBinding(bindings, recipe, {
    provider: connection.provider,
    userId: connection.userId,
    itemId,
  });
  if (saved?.slots.some((entry) => entry.slot === TOTP_HANDLER_SLOT && entry.field !== "totp"))
    return undefined;
  return item.fields.some((field) => field.id === "login.totp-code")
    ? "login.totp-code"
    : undefined;
}
/**
 * Why an item's password fact is false, for the log (ADR 0027): the item's password is
 * missing or empty (`password-empty`), or it holds one that the account may not fill,
 * directly or through a field linked to it (`password-not-allowed`). Never a value.
 */
export function passwordMiss(
  item: Pick<VaultItemMetadata, "fields"> | undefined,
  allowedFieldIds: readonly string[],
): "password-not-allowed" | "password-empty" {
  const held = item?.fields.some((field) => field.id === "login.password" && field.empty !== true);
  return item &&
    held &&
    !allowedFieldIds.some((allowed) => loginFieldSource(item, allowed) === "login.password")
    ? "password-not-allowed"
    : "password-empty";
}
/**
 * Where the plan step at `index` stands in a TOTP code's entry (ADR 0027): the code fill
 * of an entered `totp` handler or of a route step that fills only the `totp` slot, or
 * the click on its button that follows the fill on the same path. A route's code fill
 * counts only when that click, a submit, follows it.
 */
export function codeStep(
  recipe: LoginRecipe,
  metadata: LoginAttemptMetadata,
  index: number,
): "fill" | "click" | undefined {
  const plan = attemptPlan(recipe, metadata);
  const entry = plan?.[index];
  if (!entry) return undefined;
  const before = plan![index - 1];
  if (entry.handler !== undefined) {
    if (recipe.handlers?.[entry.handler]?.kind !== "totp") return undefined;
    if (entry.step.kind === "fill") return "fill";
    return entry.step.kind === "click" &&
      before?.handler === entry.handler &&
      before.step.kind === "fill"
      ? "click"
      : undefined;
  }
  const routeCode = (at: { step: LoginStep; handler?: number } | undefined) =>
    at?.handler === undefined &&
    at?.step.kind === "fill" &&
    at.step.fields.length === 1 &&
    at.step.fields[0]!.slot === TOTP_HANDLER_SLOT;
  const after = plan![index + 1];
  if (routeCode(entry))
    return after?.handler === undefined &&
      after?.step.kind === "click" &&
      after.step.purpose === "submit" &&
      after.step.path === entry.step.path
      ? "fill"
      : undefined;
  return entry.step.kind === "click" &&
    entry.step.purpose === "submit" &&
    routeCode(before) &&
    before!.step.path === entry.step.path
    ? "click"
    : undefined;
}
