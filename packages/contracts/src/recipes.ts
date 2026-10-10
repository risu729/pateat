import * as v from "valibot";
import type { LoginRecipe } from "./login";
import {
  savedLoginBindingSchema,
  type LocalSettings,
  type SavedLoginBinding,
  type VaultFieldReference,
} from "./settings";

// Recipe lookup and binding resolution over synced data (ADR 0013). Recipes and
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

/**
 * One field of a live item, in the item's own field order. `name` is the field's raw
 * vault name: a custom field without a name (or with an empty one) has `null`, never a
 * display fallback such as "Custom field 2", so it can never be bound by name.
 */
export type LocalItemField = { id: string; name: string | null };
type FieldRefusal = "field-missing" | "field-ambiguous" | "field-count-changed";
export type BindingFieldResolution =
  | { ok: true; slots: { slot: string; fieldId: string }[] }
  | { ok: false; reason: "binding-slots-mismatch" }
  | { ok: false; slot: string; reason: FieldRefusal };

const builtinFieldIds = {
  username: "login.username",
  password: "login.password",
  totp: "login.totp-code",
} as const;
const customFieldId = /^custom\.[^.]+\.(\d+)$/;

/** Maps a device-independent reference to this device's current field ID. */
function resolveField(
  reference: VaultFieldReference,
  fields: readonly LocalItemField[],
): { fieldId: string } | { reason: FieldRefusal } {
  if (typeof reference === "string") {
    const fieldId = builtinFieldIds[reference];
    return fields.some((field) => field.id === fieldId) ? { fieldId } : { reason: "field-missing" };
  }
  // Same-name fields are counted over the whole item, ordered by their vault index.
  const named = fields
    .flatMap((field) => {
      const index = customFieldId.exec(field.id)?.[1];
      return index !== undefined && field.name === reference.custom
        ? [{ id: field.id, index: Number(index) }]
        : [];
    })
    .sort((left, right) => left.index - right.index);
  if (reference.position === undefined) {
    if (named.length > 1) return { reason: "field-ambiguous" };
    return named[0] ? { fieldId: named[0].id } : { reason: "field-missing" };
  }
  // An added or removed duplicate needs review again. Swapping two same-name fields
  // keeps the count and is not detected (ADR 0013).
  if (named.length !== reference.count) return { reason: "field-count-changed" };
  return { fieldId: named[reference.position - 1]!.id };
}

/**
 * Resolves every slot of a binding against one live item, or refuses on the first
 * slot that cannot be resolved exactly. The binding must cover exactly the recipe's
 * slots, and `fields` must be the item's full field list, not a filtered one.
 * Eligibility and exclusions are checked later.
 */
export function resolveBindingFields(
  binding: Pick<SavedLoginBinding, "slots">,
  recipe: Pick<LoginRecipe, "slots">,
  fields: readonly LocalItemField[],
): BindingFieldResolution {
  const bound = new Set(binding.slots.map((entry) => entry.slot));
  if (bound.size !== recipe.slots.length || recipe.slots.some((slot) => !bound.has(slot))) {
    return { ok: false, reason: "binding-slots-mismatch" };
  }
  const slots: { slot: string; fieldId: string }[] = [];
  for (const entry of binding.slots) {
    const resolved = resolveField(entry.field, fields);
    if ("reason" in resolved) return { ok: false, slot: entry.slot, reason: resolved.reason };
    slots.push({ slot: entry.slot, fieldId: resolved.fieldId });
  }
  return { ok: true, slots };
}

const builtinSlots = new Set<string>(["username", "password", "totp"]);

/**
 * The binding an automatic account choice uses before AI generation maps slots (ADR
 * 0013): each slot named `username`, `password` or `totp` reads the item's built-in
 * field of that name. A recipe with any other slot has no automatic binding.
 */
export function defaultLoginBinding(
  recipe: Pick<LoginRecipe, "id" | "origin" | "slots">,
  account: { provider: string; userId: string; itemId: string; itemName: string },
): SavedLoginBinding | undefined {
  if (!recipe.slots.every((slot) => builtinSlots.has(slot))) return undefined;
  const binding = v.safeParse(savedLoginBindingSchema, {
    recipeId: recipe.id,
    origin: recipe.origin,
    ...account,
    slots: recipe.slots.map((slot) => ({ slot, field: slot })),
  });
  return binding.success ? binding.output : undefined;
}

/**
 * Saves an account choice after an `authenticated` outcome: the site default for the
 * binding's origin and the binding itself, each only when none exists yet. A saved
 * choice therefore keeps winning, and a binding written by the owner or by AI
 * generation is never replaced. Returns the same object when nothing changes.
 */
export function saveLoginChoice(
  settings: LocalSettings,
  binding: SavedLoginBinding,
  connectionId: string,
): LocalSettings {
  const hasDefault = settings.siteDefaults.some((site) => site.origin === binding.origin);
  const bindings = settings.bindings ?? [];
  const hasBinding = bindings.some(
    (entry) =>
      entry.recipeId === binding.recipeId &&
      entry.provider === binding.provider &&
      entry.userId === binding.userId &&
      entry.itemId === binding.itemId,
  );
  if (hasDefault && hasBinding) return settings;
  return {
    ...settings,
    siteDefaults: hasDefault
      ? settings.siteDefaults
      : [
          ...settings.siteDefaults,
          { origin: binding.origin, connectionId, itemId: binding.itemId },
        ],
    bindings: hasBinding ? bindings : [...bindings, binding],
  };
}
