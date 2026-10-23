import * as v from "valibot";
import {
  isLoginRecipeDocument,
  newestLayout,
  passwordVariants,
  recipeLayouts,
  routeSteps,
  runsLogin,
  sameLoginTarget,
  type LoginRecipe,
  type LoginStep,
  type LoginTarget,
  type LoginRecipeDocument,
  type RecipeLanguage,
  type StoredLoginRecipe,
} from "./login";
import type { LoginObservation } from "./observation";
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
 * Every login recipe for one exact origin with a layout that may start a login, in cache
 * order. An entry recipe (ADR 0031) or a chooser recipe (ADR 0028) is left out: neither is
 * a login recipe with layouts. So is a recipe whose every layout was generated as `confirm`
 * or `unclear` (ADR 0035).
 */
export function loginRecipesForOrigin(
  recipes: readonly StoredLoginRecipe[],
  origin: string,
): LoginRecipeDocument[] {
  return recipes.filter(
    (recipe): recipe is LoginRecipeDocument =>
      isLoginRecipeDocument(recipe) &&
      recipe.origin === origin &&
      recipe.layouts.some((layout) => runsLogin(layout)),
  );
}

/** One layout a new login may run (ADR 0060), with what the choice between layouts reads. */
export type LayoutCandidate<Recipe> = {
  recipe: Recipe;
  language?: RecipeLanguage | undefined;
  createdAt: number;
};

/**
 * Each layout of a stored login recipe that may start a login as a candidate, in stored
 * order: a layout generated as `confirm` or `unclear` never runs (ADR 0035).
 */
export function loginLayoutCandidates(recipe: LoginRecipeDocument): LayoutCandidate<LoginRecipe>[] {
  return recipeLayouts(recipe).flatMap((projected, index) =>
    runsLogin(projected)
      ? [
          {
            recipe: projected,
            ...(recipe.layouts[index]!.language
              ? { language: recipe.layouts[index]!.language }
              : {}),
            createdAt: recipe.layouts[index]!.createdAt,
          },
        ]
      : [],
  );
}

/** The elements a step needs to show; a step that waits for an element to go names none. */
const shownTargets = (step: LoginStep): LoginTarget[] =>
  step.kind === "fill"
    ? step.fields.map((field) => field.target)
    : step.kind === "click" || step.present
      ? [step.target]
      : [];

/** The passkey route's steps and each password variant's, in that order. */
const startRoutes = (recipe: LoginRecipe): LoginStep[][] => [
  ...(recipe.passkey ? [routeSteps(recipe, { route: "passkey" })] : []),
  ...passwordVariants(recipe).map((variant) => variant.steps),
];

/**
 * The elements a layout's start page shows (ADR 0060): those of every route's and
 * variant's steps on the recipe's start path, each once, the passkey button first; a
 * `passkey` route without a button names the first step's element. A new
 * login counts which of them show and which are missing to tell layouts of one start path
 * apart.
 */
export function layoutStartTargets(recipe: LoginRecipe): LoginTarget[] {
  const start = recipe.steps[0]!.path;
  const targets = startRoutes(recipe)
    .flat()
    .filter((step) => step.path === start)
    .flatMap(shownTargets);
  return targets.filter(
    (target, index) => targets.findIndex((other) => sameLoginTarget(other, target)) === index,
  );
}

/**
 * The elements of each route's and variant's first step (ADR 0060), when it is on the
 * start path: a layout whose page shows every element of one of them can start a login.
 * A first step that waits for an element to go names none, so it shows no start.
 */
export function layoutFirstSteps(recipe: LoginRecipe): LoginTarget[][] {
  const start = recipe.steps[0]!.path;
  return startRoutes(recipe).flatMap((steps) =>
    steps[0]?.path === start ? [shownTargets(steps[0])] : [],
  );
}

/**
 * What a page shows of one layout (ADR 0060): whether every element of one of its first
 * steps shows (`starts`), and how many of its start-page elements show and are missing.
 */
export type LayoutShown = { starts: boolean; shown: number; missing: number };

/**
 * `LayoutShown` for one layout from what the page shows of each element: `true` shown,
 * `false` missing, `undefined` not asked, which counts as neither.
 */
export function layoutShown(
  firstSteps: readonly (readonly LoginTarget[])[],
  targets: readonly LoginTarget[],
  shows: (target: LoginTarget) => boolean | undefined,
): LayoutShown {
  const states = targets.map(shows);
  return {
    starts: firstSteps.some(
      (step) => step.length > 0 && step.every((target) => shows(target) === true),
    ),
    shown: states.filter((state) => state === true).length,
    missing: states.filter((state) => state === false).length,
  };
}

/** Negative when `left` fits the page better: one that starts, then fewer missing, then more shown. */
const compareShown = (left: LayoutShown, right: LayoutShown) =>
  Number(right.starts) - Number(left.starts) ||
  left.missing - right.missing ||
  right.shown - left.shown;

/**
 * The layouts a new login may run, best first (ADR 0060): only those that fit the page
 * best (`shown`, one entry per candidate): a layout one of whose first steps shows whole,
 * then the fewest missing start-page elements, then the most shown. Among those, a layout
 * of the page's language comes before the others, then the newest first. The caller takes
 * the first whose plan for the account passes, which puts the plan between the elements
 * and the language; when none passes, the first one's refusal stands. A `mixed` or unknown
 * page language prefers none.
 */
export function rankLayouts<Recipe>(
  candidates: readonly LayoutCandidate<Recipe>[],
  shown: readonly LayoutShown[],
  language?: LoginObservation["language"],
): LayoutCandidate<Recipe>[] {
  const none: LayoutShown = { starts: false, shown: 0, missing: 0 };
  const of = (index: number) => shown[index] ?? none;
  const best = candidates
    .map((_, index) => of(index))
    .reduce<LayoutShown | undefined>(
      (top, entry) => (!top || compareShown(entry, top) < 0 ? entry : top),
      undefined,
    );
  const speaks = (candidate: LayoutCandidate<Recipe>) =>
    language !== undefined && language !== "mixed" && candidate.language === language ? 1 : 0;
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter(({ index }) => best !== undefined && compareShown(of(index), best) === 0)
    .sort(
      (left, right) =>
        speaks(right.candidate) - speaks(left.candidate) ||
        right.candidate.createdAt - left.candidate.createdAt ||
        right.index - left.index,
    )
    .map(({ candidate }) => candidate);
}

/**
 * Whether the page's language can change `rankLayouts`'s order: the best-fitting layouts
 * are of more than one language. Only then is the page's language read.
 */
export function languageDecides<Recipe>(ranked: readonly LayoutCandidate<Recipe>[]): boolean {
  return new Set(ranked.map((candidate) => candidate.language)).size > 1;
}

export type LoginRecipeSelection =
  | {
      ok: true;
      /** The newest layout, which a login takes when nothing tells the layouts apart. */
      recipe: LoginRecipe;
      /** Every layout of the recipe, for the choice of ADR 0060. */
      layouts: LayoutCandidate<LoginRecipe>[];
      stepIndex: number;
    }
  | { ok: false; reason: "recipe-not-found" | "recipe-ambiguous" };

/**
 * Chooses the recipe and step a new attempt starts on. For now only a recipe's first
 * step can start an attempt, and two recipes starting on one page refuse rather than
 * guess. The layouts of the one recipe that starts there are all offered (ADR 0060); the
 * runtime chooses between them from what the page shows.
 */
export function selectLoginRecipe(
  recipes: readonly StoredLoginRecipe[],
  origin: string,
  path: string,
): LoginRecipeSelection {
  const starting = loginRecipesForOrigin(recipes, origin).filter(
    (recipe) => recipe.layouts[0]?.steps[0]?.path === path,
  );
  if (starting.length > 1) return { ok: false, reason: "recipe-ambiguous" };
  const [recipe] = starting;
  if (!recipe) return { ok: false, reason: "recipe-not-found" };
  const layouts = loginLayoutCandidates(recipe);
  return { ok: true, recipe: newestLayout(layouts)!.recipe, layouts, stepIndex: 0 };
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
 * display fallback such as "Custom field 2", so it can never be bound by name. `empty` and
 * `totpSeed` are the catalog's value-free flags, which only the `totp` slot's automatic
 * reference reads (`totpFieldReference`).
 */
export type LocalItemField = {
  id: string;
  name: string | null;
  empty?: true | undefined;
  totpSeed?: true | undefined;
};
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
 * The field the `totp` slot reads when no saved entry names one (ADR 0027, owner
 * 2026-10-23): the item's built-in TOTP field when it holds a value (not flagged
 * `empty`); otherwise its one named custom field the catalog flags as holding a TOTP key
 * (`totpSeed`, set only on Text and Hidden fields), by its reference; otherwise the
 * built-in field. Several flagged fields leave the built-in field, which then holds no
 * value.
 */
export function totpFieldReference(fields: readonly LocalItemField[]): VaultFieldReference {
  const builtin = fields.find((field) => field.id === builtinFieldIds.totp);
  if (builtin && builtin.empty !== true) return "totp";
  const seeds = fields.filter((field) => field.totpSeed === true && customFieldId.test(field.id));
  const reference = seeds.length === 1 ? customFieldReference(fields, seeds[0]!.id) : undefined;
  return reference ?? "totp";
}

/**
 * Whether binding `slot` to `field` breaks the TOTP key rule (ADR 0027, owner
 * 2026-10-23): a slot other than `totp` on a custom field the catalog flags as holding a
 * TOTP key (`totpSeed`), whose value is never filled as text, or the `totp` slot on a
 * custom field without that flag, which holds no key to make a code from. A login refuses
 * such a binding before any step (`totp-field-mismatch`), and a template that would build
 * one is skipped.
 */
export function totpFieldMismatch(slot: string, field: LocalItemField | undefined): boolean {
  if (!field) return false;
  return slot === "totp"
    ? customFieldId.test(field.id) && field.totpSeed !== true
    : field.totpSeed === true;
}

/** The reference a built-in slot reads by default: `totp` by `totpFieldReference`. */
function builtinReference(
  slot: "username" | "password" | "totp",
  fields: readonly LocalItemField[],
): VaultFieldReference {
  return slot === "totp" ? totpFieldReference(fields) : slot;
}

/**
 * The binding an automatic account choice uses before AI generation maps slots (ADR
 * 0013): each of `slots`, the slots of the route a login takes, named `username` or
 * `password` reads the item's built-in field of that name, and `totp` the field
 * `totpFieldReference` picks from `fields`, the item's full field list (the built-in field
 * without it). Slots with any other name have no automatic binding, and neither has a
 * recipe whose origin or IDs do not fit the binding schema.
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
  fields: readonly LocalItemField[] = [],
): SavedLoginBinding | undefined {
  if (!slots.every((slot) => builtinSlots.has(slot))) return undefined;
  const { accountName, ...owner } = account;
  const binding = v.safeParse(savedLoginBindingSchema, {
    recipeId: recipe.id,
    origin: recipe.origin,
    ...owner,
    ...loginDisplayNames(account.itemId, account.itemName, accountName),
    slots: slots.map((slot) => ({
      slot,
      field: builtinReference(slot as "username" | "password" | "totp", fields),
    })),
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
 * named `username`, `password` or `totp` reads the item's field as `defaultLoginBinding`
 * picks it, and every other slot takes the template's reference to a custom field by name. The
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
 * `password` or `totp` reads the item's field as `defaultLoginBinding` picks it, and every
 * other slot takes the template's reference. A template whose binding `totpFieldMismatch`
 * refuses is skipped. The first template whose references all resolve on the
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
        ? builtinReference(slot as "username" | "password" | "totp", fields)
        : template.find((entry) => entry.slot === slot)?.field,
    }));
    if (references.some((entry) => entry.field === undefined)) continue;
    const bound = references as { slot: string; field: VaultFieldReference }[];
    const resolutions = bound.map((entry) => ({
      slot: entry.slot,
      resolved: resolveField(entry.field, fields),
    }));
    const failed = resolutions.flatMap(({ slot, resolved }) =>
      "reason" in resolved ? [{ slot, reason: resolved.reason }] : [],
    )[0];
    if (failed) {
      refusal ??= { ok: false, ...failed };
      continue;
    }
    // A template that would fill a TOTP key as text, or make a code from a field holding
    // none, is passed over for the next one.
    if (
      resolutions.some(
        ({ slot, resolved }) =>
          "fieldId" in resolved &&
          totpFieldMismatch(
            slot,
            fields.find((field) => field.id === resolved.fieldId),
          ),
      )
    )
      continue;
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
 * `password` or `totp` reads the item's field as `defaultLoginBinding` picks it, and the
 * other gaps
 * take a template's references by name, the first template whose references for every
 * such gap resolve on the item winning. `templates` are those `templateLoginBinding` would
 * get: the recipe's other saved bindings of the origin, then the generated slot map. The
 * saved entries are kept as they are and in their order, and the filled ones follow in
 * `slots` order; `widened` says whether any was added. A gap named `username`, `password`
 * or `totp` whose field the saved binding already names directly under another slot
 * refuses `binding-slots-mismatch`; a custom field linked to that built-in field is
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
  const named = (slot: string) => {
    const reference = JSON.stringify(
      builtinReference(slot as "username" | "password" | "totp", fields),
    );
    return saved.slots.some((entry) => JSON.stringify(entry.field) === reference);
  };
  if (gaps.some((slot) => builtinSlots.has(slot) && named(slot)))
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
