import { canonicalJson } from "./canonical-json";
import { handlerTargets, MAX_RECIPE_LAYOUTS, type LayoutMeta } from "./login/route-schema";
import {
  isChooserDocument,
  isLoginRecipeDocument,
  layoutMeta,
  newestLayout,
} from "./login/layouts";
import type { RecipeDocument, StoredLoginRecipe } from "./login/document-schema";
import {
  MAX_SSO_LABELS,
  nativeSsoTargets,
  normalizeSsoLabel,
  ssoLayoutMeta,
  ssoTargetKey,
  type SsoEntry,
  type SsoLayout,
  type SsoRoutes,
} from "./sso";

// The layouts of a stored recipe document (ADR 0060) over each of its kinds: sign-in forms,
// lists of accounts and SSO entries (ADR 0085).

/**
 * The key, language and creation time of each layout of a stored recipe, its sign-in form's,
 * then its list's, then its SSO entries'; none for an entry.
 */
export function storedLayouts(recipe: StoredLoginRecipe): LayoutMeta[] {
  return [
    ...(isLoginRecipeDocument(recipe) ? recipe.layouts.map(layoutMeta) : []),
    ...(isChooserDocument(recipe) ? recipe.chooser.layouts.map(layoutMeta) : []),
    ...ssoLayoutMeta(recipe),
  ];
}
/**
 * The stored recipe without the layout of the key, as the next revision (ADR 0060): a
 * recipe's last layout of one kind takes that kind away, so the other kinds stay alone.
 * `undefined` when it has no such layout or that is its last one, which revoking the recipe
 * removes instead.
 */
export function withoutLayout(
  recipe: StoredLoginRecipe,
  key: string,
): StoredLoginRecipe | undefined {
  if ("entry" in recipe || "logout" in recipe) return undefined;
  const layouts = recipe.layouts?.filter((layout) => layout.key !== key);
  const choosers = recipe.chooser?.layouts.filter((layout) => layout.key !== key);
  const sso = recipe.sso?.layouts.filter((layout) => layout.key !== key);
  if (
    layouts?.length === recipe.layouts?.length &&
    choosers?.length === recipe.chooser?.layouts.length &&
    sso?.length === recipe.sso?.layouts.length
  )
    return undefined;
  const { layouts: _layouts, chooser: _chooser, sso: _sso, ...rest } = recipe;
  const next: RecipeDocument = {
    ...rest,
    revision: recipe.revision + 1,
    ...(layouts?.length ? { layouts } : {}),
    ...(recipe.sso && sso?.length ? { sso: { ...recipe.sso, layouts: sso } } : {}),
    ...(recipe.chooser && choosers?.length
      ? { chooser: { ...recipe.chooser, layouts: choosers } }
      : {}),
  };
  return next.layouts || next.chooser || next.sso ? next : undefined;
}
/**
 * A key for a layout created at `createdAt` (ADR 0060): that time in epoch milliseconds,
 * moved on by a millisecond while another layout of the recipe holds it.
 */
export function newLayoutKey(createdAt: number, taken: readonly string[]): string {
  let at = Math.max(0, Math.trunc(createdAt));
  while (taken.includes(String(at))) at += 1;
  return String(at);
}

/** Each route a recipe's chooser layouts hold: their branches and passkey routes. */
const chooserBranches = (recipe: RecipeDocument) =>
  (recipe.chooser?.layouts ?? []).flatMap((layout) =>
    [layout.afterAccount, layout.afterOther, layout.passkey].filter(
      (branch) => branch !== undefined,
    ),
  );
/**
 * Whether a native route of the recipe uses `target` on `path`, so SSO generation never
 * offers it (`nativeSsoTargets`).
 */
export function nativeTargetOn(recipe: RecipeDocument, path: string) {
  const used = nativeSsoTargets(recipe, chooserBranches(recipe), handlerTargets, path);
  return (target: unknown) => used.has(ssoTargetKey(path, target));
}
/**
 * The recipe without its SSO entries on an element a native route uses: SSO entries do
 * not run yet, so they give way to a native route written beside them. A layout left
 * with no entry goes, and the `sso` sibling with its last layout.
 */
export function ssoBesideNative<Recipe extends RecipeDocument>(recipe: Recipe): Recipe {
  const sso = recipe.sso;
  if (!sso) return recipe;
  const native = nativeTargetOn(recipe, sso.path);
  if (sso.layouts.every((layout) => layout.entries.every((entry) => !native(entry.target))))
    return recipe;
  const layouts = sso.layouts
    .map((layout) => ({
      ...layout,
      entries: layout.entries.filter((entry) => !native(entry.target)),
    }))
    .filter((layout) => layout.entries.length > 0);
  const { sso: _sso, ...rest } = recipe;
  return { ...rest, ...(layouts.length ? { sso: { ...sso, layouts } } : {}) } as Recipe;
}
/** Whether each label, ignoring letter case, has an entry in some layout of the family. */
export const ssoCovers = (sso: SsoRoutes | undefined, labels: readonly string[]) =>
  sso !== undefined &&
  labels.every((label) =>
    sso.layouts.some((layout) =>
      layout.entries.some((entry) => normalizeSsoLabel(entry.label) === normalizeSsoLabel(label)),
    ),
  );
/**
 * `entries` with `added` in them: an added entry replaces one of the same label, ignoring
 * letter case, and goes last, unless it is that entry unchanged, which keeps its place;
 * past `MAX_SSO_LABELS` the earliest entries go. An entry of another label on the same
 * element stays, so two labels answered on one button never replace each other's entry
 * on each write.
 */
export function mergeSsoEntries(entries: readonly SsoEntry[], added: readonly SsoEntry[]) {
  const key = (entry: SsoEntry) => canonicalJson([normalizeSsoLabel(entry.label), entry.target]);
  const kept = new Set(entries.map(key));
  const changed = added.filter((entry) => !kept.has(key(entry)));
  const labels = new Set(changed.map((entry) => normalizeSsoLabel(entry.label)));
  return [
    ...entries.filter((entry) => !labels.has(normalizeSsoLabel(entry.label))),
    ...changed,
  ].slice(-MAX_SSO_LABELS);
}
const sameEntries = (left: readonly SsoEntry[], right: readonly SsoEntry[]) =>
  canonicalJson(left) === canonicalJson(right);
/**
 * The recipe with SSO entries generated on `path` (ADR 0026 amendment of 2026-11-12), and
 * the key of the layout that holds them. New labels join the newest layout, so a family
 * grows with the labels asked for instead of a layout each; the layout takes `meta`'s
 * creation time, as its idle retention counts from its newest entries. A repair, whose entries no
 * longer worked, adds the newest layout's entries with the new ones as another layout
 * (up to `MAX_RECIPE_LAYOUTS`, the least recently used going first), keeping the old ones
 * for a page that still shows them. The recipe itself when nothing changes, or when its
 * SSO entries are on another path.
 */
export function withSsoEntries(
  recipe: RecipeDocument,
  path: string,
  meta: Omit<SsoLayout, "entries">,
  added: readonly SsoEntry[],
  options: { repair: boolean; lastUsed?: (key: string) => number | undefined },
): { recipe: RecipeDocument; layout: string } {
  const previous = recipe.sso;
  const newest = previous && newestLayout(previous.layouts);
  if (previous && previous.path !== path) return { recipe, layout: newest!.key };
  const entries = mergeSsoEntries(newest?.entries ?? [], added);
  if (newest && !options.repair) {
    if (sameEntries(entries, newest.entries)) return { recipe, layout: newest.key };
    // The layout is as new as its newest entries, so idle retention counts from them.
    const layouts = previous.layouts.map((layout) =>
      layout === newest
        ? { ...layout, createdAt: Math.max(layout.createdAt, meta.createdAt), entries }
        : layout,
    );
    return { recipe: { ...recipe, sso: { path, layouts } }, layout: newest.key };
  }
  const same = previous?.layouts.find((layout) => sameEntries(layout.entries, entries));
  if (same) return { recipe, layout: same.key };
  const lastUsed = options.lastUsed ?? (() => undefined);
  const used = (layout: SsoLayout) => Math.max(layout.createdAt, lastUsed(layout.key) ?? 0);
  let layouts = [...(previous?.layouts ?? []), { ...meta, entries }];
  if (layouts.length > MAX_RECIPE_LAYOUTS) {
    const least = layouts
      .slice(0, -1)
      .reduce((older, candidate) => (used(candidate) < used(older) ? candidate : older));
    layouts = layouts.filter((layout) => layout !== least);
  }
  return { recipe: { ...recipe, sso: { path, layouts } }, layout: meta.key };
}
