import type { LoginRecipe } from "./login";
import type { SavedLoginBinding, VaultFieldReference } from "./settings";

// Recipe lookup and binding resolution over synced data (ADR 0012). Recipes and
// bindings come from the service cache; these functions only read them.

/** Every recipe for one exact origin, in cache order. */
export function loginRecipesForOrigin(
  recipes: readonly LoginRecipe[],
  origin: string,
): LoginRecipe[] {
  return recipes.filter((recipe) => recipe.origin === origin);
}

export type LoginRecipeSelection =
  | { ok: true; recipe: LoginRecipe; stepIndex: number }
  | { ok: false; reason: "recipe-not-found" | "recipe-ambiguous" };

/**
 * Chooses the recipe and step a new attempt starts on. For now only a recipe's first
 * step can start an attempt, and two recipes starting on one page refuse rather than
 * guess. On-screen step detection can replace this without changing stored data.
 */
export function selectLoginRecipe(
  recipes: readonly LoginRecipe[],
  origin: string,
  path: string,
): LoginRecipeSelection {
  const starting = loginRecipesForOrigin(recipes, origin).filter(
    (recipe) => recipe.steps[0]?.path === path,
  );
  if (starting.length > 1) return { ok: false, reason: "recipe-ambiguous" };
  const [recipe] = starting;
  return recipe ? { ok: true, recipe, stepIndex: 0 } : { ok: false, reason: "recipe-not-found" };
}

/** A resumed attempt's own recipe: same origin, ID and revision, or nothing. */
export function findLoginRecipe(
  recipes: readonly LoginRecipe[],
  origin: string,
  recipeId: string,
  revision: number,
): LoginRecipe | undefined {
  return recipes.find(
    (recipe) => recipe.origin === origin && recipe.id === recipeId && recipe.revision === revision,
  );
}

/** The synced binding of one recipe for one vault item, if any. */
export function findLoginBinding(
  bindings: readonly SavedLoginBinding[],
  recipe: Pick<LoginRecipe, "id" | "origin">,
  account: { provider: string; userId: string; itemId: string },
): SavedLoginBinding | undefined {
  return bindings.find(
    (entry) =>
      entry.recipeId === recipe.id &&
      entry.origin === recipe.origin &&
      entry.provider === account.provider &&
      entry.userId === account.userId &&
      entry.itemId === account.itemId,
  );
}

/** A live item's fields as the local catalog lists them. */
export type LocalItemField = { id: string; label: string };
export type BindingFieldResolution =
  | { ok: true; slots: { slot: string; fieldId: string }[] }
  | {
      ok: false;
      slot: string;
      reason: "field-missing" | "field-ambiguous" | "field-count-changed";
    };

const builtinFieldIds = {
  username: "login.username",
  password: "login.password",
  totp: "login.totp-code",
} as const;

/** Maps device-independent references to this device's current field IDs. */
function resolveField(
  reference: VaultFieldReference,
  fields: readonly LocalItemField[],
): { fieldId: string } | { reason: "field-missing" | "field-ambiguous" | "field-count-changed" } {
  if (typeof reference === "string") {
    const fieldId = builtinFieldIds[reference];
    return fields.some((field) => field.id === fieldId) ? { fieldId } : { reason: "field-missing" };
  }
  const named = fields.filter(
    (field) => field.id.startsWith("custom.") && field.label === reference.custom,
  );
  if (reference.position === undefined) {
    if (named.length > 1) return { reason: "field-ambiguous" };
    return named[0] ? { fieldId: named[0].id } : { reason: "field-missing" };
  }
  // Reordered, added or removed duplicates must be reviewed again, never guessed.
  if (named.length !== reference.count) return { reason: "field-count-changed" };
  return { fieldId: named[reference.position - 1]!.id };
}

/**
 * Resolves every slot of a binding against one live item, or refuses on the first
 * slot that cannot be resolved exactly. Eligibility and exclusions are checked later.
 */
export function resolveBindingFields(
  binding: Pick<SavedLoginBinding, "slots">,
  fields: readonly LocalItemField[],
): BindingFieldResolution {
  const slots: { slot: string; fieldId: string }[] = [];
  for (const entry of binding.slots) {
    const resolved = resolveField(entry.field, fields);
    if ("reason" in resolved) return { ok: false, slot: entry.slot, reason: resolved.reason };
    slots.push({ slot: entry.slot, fieldId: resolved.fieldId });
  }
  return { ok: true, slots };
}
