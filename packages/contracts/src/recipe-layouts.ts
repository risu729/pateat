import {
  isChooserDocument,
  isLoginRecipeDocument,
  layoutMeta,
  type LayoutMeta,
  type RecipeDocument,
  type StoredLoginRecipe,
} from "./login";
import { ssoLayoutMeta } from "./sso";

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
