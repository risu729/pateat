import * as v from "valibot";
import { isLoginRouteRecipe, runsLogin, type LoginRecipe, type StoredLoginRecipe } from "./login";
import {
  savedLoginBindingSchema,
  type DetailLink,
  type LocalSettings,
  type SavedLoginBinding,
  type VaultFieldReference,
} from "./settings";

// Recipe lookup and binding resolution over synced data (ADR 0013). Recipes and
// bindings come from the service cache; these functions only read them.

/**
 * Every recipe with a login route for one exact origin that may start a login, in cache
 * order. An entry recipe (ADR 0031) or a chooser recipe (ADR 0028) is left out: nothing
 * starts either yet, and neither starts or resumes a login. So is a route recipe generated
 * as `confirm` or `unclear` (ADR 0035).
 */
export function loginRecipesForOrigin(
  recipes: readonly StoredLoginRecipe[],
  origin: string,
): LoginRecipe[] {
  return recipes.filter(
    (recipe): recipe is LoginRecipe =>
      isLoginRouteRecipe(recipe) && recipe.origin === origin && runsLogin(recipe),
  );
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
  recipes: readonly StoredLoginRecipe[],
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

/** An item's custom fields of one name, ordered by their vault index. */
function sameNameFields(fields: readonly LocalItemField[], name: string): string[] {
  return fields
    .flatMap((field) => {
      const index = customFieldId.exec(field.id)?.[1];
      return index !== undefined && field.name === name
        ? [{ id: field.id, index: Number(index) }]
        : [];
    })
    .sort((left, right) => left.index - right.index)
    .map((field) => field.id);
}

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
  const named = sameNameFields(fields, reference.custom);
  if (reference.position === undefined) {
    if (named.length > 1) return { reason: "field-ambiguous" };
    return named[0] ? { fieldId: named[0] } : { reason: "field-missing" };
  }
  // An added or removed duplicate needs review again. Swapping two same-name fields
  // keeps the count and is not detected; ADR 0013 records this limitation.
  if (named.length !== reference.count) return { reason: "field-count-changed" };
  return { fieldId: named[reference.position - 1]! };
}

/**
 * The current field ID of a linked detail's source field on one live item (ADR 0061): an
 * identity's or card's built-in field as it is, or a custom field as a binding reference
 * resolves. Undefined when the item lacks it, or several fields share its name.
 */
export function resolveDetailSourceField(
  field: DetailLink["source"]["field"],
  fields: readonly LocalItemField[],
): string | undefined {
  if (typeof field === "string")
    return fields.some((entry) => entry.id === field) ? field : undefined;
  const resolved = resolveField(field, fields);
  return "fieldId" in resolved ? resolved.fieldId : undefined;
}

/**
 * Resolves the binding's entries for `slots`, the slots of the route a login takes (ADR
 * 0027), against one live item, or refuses on the first slot that cannot be resolved
 * exactly. The binding must hold every one of `slots`; entries for other slots, such as
 * another variant's, are ignored and never resolved. `fields` must be the item's full
 * field list, not a filtered one. Eligibility and exclusions are checked later.
 */
export function resolveBindingFields(
  binding: Pick<SavedLoginBinding, "slots">,
  slots: readonly string[],
  fields: readonly LocalItemField[],
): BindingFieldResolution {
  const used = binding.slots.filter((entry) => slots.includes(entry.slot));
  if (used.length !== slots.length) return { ok: false, reason: "binding-slots-mismatch" };
  const resolvedSlots: { slot: string; fieldId: string }[] = [];
  for (const entry of used) {
    const resolved = resolveField(entry.field, fields);
    if ("reason" in resolved) return { ok: false, slot: entry.slot, reason: resolved.reason };
    resolvedSlots.push({ slot: entry.slot, fieldId: resolved.fieldId });
  }
  return { ok: true, slots: resolvedSlots };
}

/**
 * The reference that names one custom field of a live item on every device (ADR 0013),
 * the inverse of `resolveField`: its name, with its position and count when the
 * item has several custom fields of that name, counted over the whole item as resolution
 * counts them. A built-in, unnamed or unknown field has none.
 */
export function customFieldReference(
  fields: readonly LocalItemField[],
  fieldId: string,
): Exclude<VaultFieldReference, string> | undefined {
  const name = fields.find((field) => field.id === fieldId)?.name;
  if (!name || !customFieldId.test(fieldId)) return undefined;
  const named = sameNameFields(fields, name);
  return named.length === 1
    ? { custom: name }
    : { custom: name, position: named.indexOf(fieldId) + 1, count: named.length };
}

const builtinSlots = new Set<string>(["username", "password", "totp"]);

/**
 * The binding an automatic account choice uses before AI generation maps slots (ADR
 * 0013): each of `slots`, the slots of the route a login takes, named `username`,
 * `password` or `totp` reads the item's built-in field of that name. Slots with any other
 * name have no automatic binding, and neither has a recipe whose origin or IDs do not fit
 * the binding schema.
 */
export function defaultLoginBinding(
  slots: readonly string[],
  recipe: Pick<LoginRecipe, "id" | "origin">,
  account: {
    provider: string;
    userId: string;
    itemId: string;
    itemName: string;
    /** The chosen vault connection's label. */
    accountName?: string;
  },
): SavedLoginBinding | undefined {
  if (!slots.every((slot) => builtinSlots.has(slot))) return undefined;
  const { accountName, ...owner } = account;
  const binding = v.safeParse(savedLoginBindingSchema, {
    recipeId: recipe.id,
    origin: recipe.origin,
    ...owner,
    ...loginDisplayNames(account.itemId, account.itemName, accountName),
    slots: slots.map((slot) => ({ slot, field: slot })),
  });
  return binding.success ? binding.output : undefined;
}

/**
 * The item and account names a saved binding or site default carries, for display only:
 * the item's label, else its ID, and the connection's label, each cut to 200 characters.
 */
export function loginDisplayNames(
  itemId: string,
  itemName: string | undefined,
  accountName: string | undefined,
): { itemName: string; accountName?: string } {
  return {
    itemName: (itemName || itemId).slice(0, 200),
    ...(accountName ? { accountName: accountName.slice(0, 200) } : {}),
  };
}

/** Slot references a binding can be built from: another item's binding, or a generated map. */
export type LoginBindingTemplate = readonly { slot: string; field: VaultFieldReference }[];

/**
 * Builds an item's binding from templates when it has none saved (ADR 0027): each slot
 * named `username`, `password` or `totp` reads the item's built-in field of that name,
 * and every other slot takes the template's reference to a custom field by name. The
 * templates are tried in order, and the first one whose references all resolve on this
 * item wins. Without one, the answer is the first resolution refusal, or
 * `binding-not-found` when no template covers every slot. `slots` is the slot list the
 * binding must cover; eligibility and exclusions are checked later, as for a saved binding.
 */
export function templateLoginBinding(
  slots: readonly string[],
  recipe: Pick<LoginRecipe, "id" | "origin">,
  account: {
    provider: string;
    userId: string;
    itemId: string;
    itemName: string;
    /** The chosen vault connection's label. */
    accountName?: string;
  },
  templates: readonly LoginBindingTemplate[],
  fields: readonly LocalItemField[],
):
  | { ok: true; binding: SavedLoginBinding }
  | { ok: false; reason: "binding-not-found" }
  | { ok: false; slot: string; reason: FieldRefusal } {
  const { accountName, ...owner } = account;
  const built = fromTemplates(slots, templates, fields, (bound) => {
    const binding = v.safeParse(savedLoginBindingSchema, {
      recipeId: recipe.id,
      origin: recipe.origin,
      ...owner,
      ...loginDisplayNames(account.itemId, account.itemName, accountName),
      slots: bound,
    });
    return binding.success ? binding.output : undefined;
  });
  return built.ok ? { ok: true, binding: built.value } : built;
}

/**
 * The template loop of `templateLoginBinding`: each of `slots` named `username`,
 * `password` or `totp` reads the item's built-in field of that name, and every other slot
 * takes the template's reference. The first template whose references all resolve on the
 * item and that `build` accepts wins; without one, the first resolution refusal, or
 * `binding-not-found` when no template covers every slot.
 */
function fromTemplates<T>(
  slots: readonly string[],
  templates: readonly LoginBindingTemplate[],
  fields: readonly LocalItemField[],
  build: (bound: { slot: string; field: VaultFieldReference }[]) => T | undefined,
):
  | { ok: true; value: T }
  | { ok: false; reason: "binding-not-found" }
  | { ok: false; slot: string; reason: FieldRefusal } {
  let refusal: { ok: false; slot: string; reason: FieldRefusal } | undefined;
  for (const template of templates) {
    const references = slots.map((slot) => ({
      slot,
      field: builtinSlots.has(slot)
        ? (slot as "username" | "password" | "totp")
        : template.find((entry) => entry.slot === slot)?.field,
    }));
    if (references.some((entry) => entry.field === undefined)) continue;
    const bound = references as { slot: string; field: VaultFieldReference }[];
    const failed = bound.flatMap((entry) => {
      const resolved = resolveField(entry.field, fields);
      return "reason" in resolved ? [{ slot: entry.slot, reason: resolved.reason }] : [];
    })[0];
    if (failed) {
      refusal ??= { ok: false, ...failed };
      continue;
    }
    const value = build(bound);
    if (value !== undefined) return { ok: true, value };
  }
  return refusal ?? { ok: false, reason: "binding-not-found" };
}

/** The slots of `slots` that a binding holds no entry for. */
export function bindingGaps(
  binding: Pick<SavedLoginBinding, "slots">,
  slots: readonly string[],
): string[] {
  return slots.filter((slot) => !binding.slots.some((entry) => entry.slot === slot));
}

/**
 * A saved binding with its gaps, the slots of `slots` it holds no entry for, filled as for
 * an item without a saved binding (ADR 0027, amended 2026-10-19): a gap named `username`,
 * `password` or `totp` reads the item's built-in field of that name, and the other gaps
 * take a template's references by name, the first template whose references for every
 * such gap resolve on the item winning. `templates` are those `templateLoginBinding` would
 * get: the recipe's other saved bindings of the origin, then the generated slot map. The
 * saved entries are kept as they are and in their order, and the filled ones follow in
 * `slots` order; `widened` says whether any was added. A gap named `username`, `password`
 * or `totp` whose built-in field the saved binding already names directly under another
 * slot refuses `binding-slots-mismatch`; a custom field linked to that built-in field is
 * not detected. A gap left unfilled refuses `binding-slots-mismatch` too, as a saved
 * binding that lacks a slot did before; a template
 * reference that does not resolve on the item refuses with its field's reason when no
 * template fills every gap. The result is resolved by `resolveBindingFields` like any.
 */
export function fillLoginBinding(
  saved: SavedLoginBinding,
  slots: readonly string[],
  templates: readonly LoginBindingTemplate[],
  fields: readonly LocalItemField[],
):
  | { ok: true; binding: SavedLoginBinding; widened: boolean }
  | { ok: false; reason: "binding-slots-mismatch" }
  | { ok: false; slot: string; reason: FieldRefusal } {
  const gaps = bindingGaps(saved, slots);
  if (gaps.length === 0) return { ok: true, binding: saved, widened: false };
  // A built-in gap whose field the binding already names directly under another slot would
  // type that value twice. Only direct references are compared.
  if (gaps.some((slot) => saved.slots.some((entry) => entry.field === slot)))
    return { ok: false, reason: "binding-slots-mismatch" };
  // Built-in gaps alone need no template.
  const sources = gaps.every((slot) => builtinSlots.has(slot)) ? [[]] : templates;
  const filled = fromTemplates(gaps, sources, fields, (bound) => {
    const binding = v.safeParse(savedLoginBindingSchema, {
      ...saved,
      slots: [...saved.slots, ...bound],
    });
    return binding.success ? binding.output : undefined;
  });
  if (filled.ok) return { ok: true, binding: filled.value, widened: true };
  return "slot" in filled ? filled : { ok: false, reason: "binding-slots-mismatch" };
}

/** Synced bindings are unique per recipe, origin and vault item. */
export function sameLoginBinding(left: SavedLoginBinding, right: SavedLoginBinding): boolean {
  return (
    left.recipeId === right.recipeId &&
    left.origin === right.origin &&
    left.provider === right.provider &&
    left.userId === right.userId &&
    left.itemId === right.itemId
  );
}

const maxSavedEntries = 1000;

/**
 * An account choice without a binding: the account a login on a route that fills nothing,
 * such as `passkey`, authenticated with (ADR 0027). Named as a binding names it.
 */
export type LoginChoiceAccount = Omit<SavedLoginBinding, "recipeId" | "slots">;

/**
 * Whether `wider` starts with every entry of `binding` as it is and in its order, and adds
 * at least one after them: the binding a login filled the gaps of (ADR 0027, amended
 * 2026-10-19).
 */
function widensLoginBinding(binding: SavedLoginBinding, wider: SavedLoginBinding): boolean {
  return (
    sameLoginBinding(binding, wider) &&
    wider.slots.length > binding.slots.length &&
    binding.slots.every((entry, index) => {
      const other = wider.slots[index];
      return (
        other !== undefined &&
        other.slot === entry.slot &&
        sameFieldReference(other.field, entry.field)
      );
    })
  );
}

function sameFieldReference(left: VaultFieldReference, right: VaultFieldReference): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return (
    left.custom === right.custom && left.position === right.position && left.count === right.count
  );
}

/**
 * Saves an account choice after an `authenticated` outcome: the site default for the
 * binding's origin and the binding itself, each only when none exists yet. A saved
 * choice therefore keeps winning, and a binding written by the owner or by AI
 * generation is never replaced; it is only widened: a binding that keeps each of its
 * entries and adds slots the login filled (ADR 0027, amended 2026-10-19) takes its place,
 * with the saved one's display names. When the origin's saved default names another
 * account, nothing is saved unless `replace` is set: an account the user picked to become
 * the default (ADR 0021) replaces it. When a list is full, nothing is saved. A new default
 * names the binding's provider account and item and copies its display names. A choice
 * without slots (`LoginChoiceAccount`) saves the site default only. Returns the same
 * object when nothing changes, so the caller can skip the write.
 */
export function saveLoginChoice(
  settings: LocalSettings,
  binding: SavedLoginBinding | LoginChoiceAccount,
  options: { replace?: boolean } = {},
): LocalSettings {
  const saved = settings.siteDefaults.find((site) => site.origin === binding.origin);
  const sameAccount =
    saved &&
    saved.itemId === binding.itemId &&
    saved.provider === binding.provider &&
    saved.userId === binding.userId;
  if (saved && !sameAccount && !options.replace) return settings;
  const kept = sameAccount ? saved : undefined;
  // A choice without slots has no binding to add, as if one were already saved.
  const existing =
    "slots" in binding
      ? settings.bindings.find((entry) => sameLoginBinding(entry, binding))
      : undefined;
  const widened = existing && "slots" in binding && widensLoginBinding(existing, binding);
  const bindings = widened
    ? settings.bindings.map((entry) =>
        entry === existing ? { ...existing, slots: binding.slots } : entry,
      )
    : settings.bindings;
  const hasBinding = !("slots" in binding) || existing !== undefined;
  if (kept && hasBinding && !widened) return settings;
  if (
    (!saved && settings.siteDefaults.length >= maxSavedEntries) ||
    (!hasBinding && bindings.length >= maxSavedEntries)
  )
    return settings;
  return {
    ...settings,
    siteDefaults: kept
      ? settings.siteDefaults
      : [
          ...settings.siteDefaults.filter((site) => site.origin !== binding.origin),
          {
            origin: binding.origin,
            provider: binding.provider,
            userId: binding.userId,
            itemId: binding.itemId,
            itemName: binding.itemName,
            ...(binding.accountName ? { accountName: binding.accountName } : {}),
          },
        ],
    bindings: hasBinding || !("slots" in binding) ? bindings : [...bindings, binding],
  };
}
