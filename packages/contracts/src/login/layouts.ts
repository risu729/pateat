import type { LoginRecipe, LayoutMeta, LoginRouteBody, LoginLayout } from "./route-schema";
import {
  type LoginChooserRecipe,
  type LoginEntryRecipe,
  type LoginRecipeDocument,
  type StoredLoginRecipe,
  type LoginChooserDocument,
  chooserLayoutRecipe,
  type LoginChooserLayout,
  type RecipeDocument,
  chooserBranch,
  branchMember,
  chooserLayouts,
} from "./document-schema";
import { ssoLayoutMeta } from "../sso";
import { type ChooserBranch, recipeBranchSchema, chooserBranchSchema } from "./branch-schema";
import * as v from "valibot";
import { recipeSlots } from "./routes";

/** Whether a recipe a login runs, or one of its answers, has a login route: its own `steps`. */
export const isLoginRouteRecipe = (
  recipe: LoginRecipe | LoginChooserRecipe | LoginEntryRecipe,
): recipe is LoginRecipe => "steps" in recipe;
/** Whether a stored recipe holds layouts of a sign-in form (ADR 0060). */
export const isLoginRecipeDocument = (recipe: StoredLoginRecipe): recipe is LoginRecipeDocument =>
  "layouts" in recipe && recipe.layouts !== undefined;
/** Whether a stored recipe holds a list of accounts (ADR 0028). */
export const isChooserDocument = (recipe: StoredLoginRecipe): recipe is LoginChooserDocument =>
  "chooser" in recipe && recipe.chooser !== undefined;
/**
 * Whether a route recipe may start a login (ADR 0035): only one generated as `sign-in`. A
 * `confirm` or `unclear` recipe is never run, never taken as a logout and never filled
 * after one.
 */
export const runsLogin = (recipe: Pick<LoginRecipe, "pageKind">): boolean =>
  recipe.pageKind === "sign-in";
/**
 * The path a stored recipe starts on: its entry's (ADR 0031), its chooser's (ADR 0028),
 * its logout's (ADR 0063) or its layouts' first step's, which every layout shares (ADR
 * 0060). The service keeps one generated recipe per origin and start path either way.
 * Each kind of stored recipe is named, so a new kind has to say where it starts.
 */
export function storedRecipeStartPath(recipe: StoredLoginRecipe): string {
  if ("entry" in recipe) return recipe.entry.path;
  if ("logout" in recipe) return recipe.logout.path;
  if (isChooserDocument(recipe)) return recipe.chooser.path;
  if (isLoginRecipeDocument(recipe)) return recipe.layouts[0]!.steps[0]!.path;
  if ("sso" in recipe && recipe.sso) return recipe.sso.path;
  throw new Error(`Unknown stored recipe kind: ${JSON.stringify(recipe)}`);
}
/** A layout's key, language and creation time, without its route. */
export function layoutMeta(layout: LayoutMeta): LayoutMeta {
  return {
    key: layout.key,
    ...(layout.language ? { language: layout.language } : {}),
    createdAt: layout.createdAt,
  };
}
/** A login recipe's route without the members a stored layout holds instead. */
export function routeBodyOf(recipe: LoginRecipe): LoginRouteBody {
  const {
    version: _version,
    id: _id,
    revision: _revision,
    origin: _origin,
    layout: _layout,
    ...route
  } = recipe;
  return route;
}
/**
 * One layout as the recipe a login runs (ADR 0060): its route with the document's ID,
 * revision and origin, and its own key. Only that layout's signed-in markers come with it,
 * so a layout that has none yet still learns its later pages (ADR 0018).
 */
export function layoutRecipe(recipe: LoginRecipeDocument, layout: LoginLayout): LoginRecipe {
  const { key, language: _language, createdAt: _createdAt, ...route } = layout;
  return {
    version: 1,
    id: recipe.id,
    revision: recipe.revision,
    origin: recipe.origin,
    layout: key,
    ...route,
  };
}
/** Every layout of a stored login recipe as a recipe a login runs, in stored order. */
export function recipeLayouts(recipe: LoginRecipeDocument): LoginRecipe[] {
  return recipe.layouts.map((layout) => layoutRecipe(recipe, layout));
}
/** The layout with the key, as a recipe a login runs; `undefined` when it has none. */
export function findLayoutRecipe(
  recipe: LoginRecipeDocument,
  key: string,
): LoginRecipe | undefined {
  const layout = recipe.layouts.find((entry) => entry.key === key);
  return layout && layoutRecipe(recipe, layout);
}
/** The most recently created of some layouts; the later one in order on a tie. */
export function newestLayout<T extends { createdAt: number }>(
  layouts: readonly T[],
): T | undefined {
  return layouts.reduce<T | undefined>(
    (newest, layout) => (!newest || layout.createdAt >= newest.createdAt ? layout : newest),
    undefined,
  );
}
/** A route a login ran, stored back as the layout `meta` names (ADR 0060). */
export function toLoginLayout(recipe: LoginRecipe, meta: LayoutMeta): LoginLayout {
  return { ...layoutMeta(meta), ...routeBodyOf(recipe) };
}
/**
 * The recipe with `layout` in place of the layout of the same key, or added after the
 * others when it has none. Every layout keeps the start page's kind (ADR 0060), so a layout
 * of another kind than the recipe's replaces them all: the page is now that kind. The
 * caller checks the result against the schema, which refuses a fourth layout: replacing
 * the least used one is repair's to decide.
 */
export function withLoginLayout(
  recipe: LoginRecipeDocument,
  layout: LoginLayout,
): LoginRecipeDocument {
  if (recipe.layouts.some((entry) => entry.pageKind !== layout.pageKind))
    return { ...recipe, layouts: [layout] };
  const at = recipe.layouts.findIndex((entry) => entry.key === layout.key);
  return {
    ...recipe,
    layouts:
      at === -1
        ? [...recipe.layouts, layout]
        : recipe.layouts.map((entry, index) => (index === at ? layout : entry)),
  };
}
/** The chooser layout with the key, as a chooser a login runs; `undefined` when it has none. */
export function findChooserLayout(
  recipe: LoginChooserDocument,
  key: string,
): LoginChooserRecipe | undefined {
  const layout = recipe.chooser.layouts.find((entry) => entry.key === key);
  return layout && chooserLayoutRecipe(recipe, layout);
}
/** A chooser a login ran, stored back as the layout `meta` names (ADR 0060). */
export function toChooserLayout(recipe: LoginChooserRecipe, meta: LayoutMeta): LoginChooserLayout {
  const { other, continue: next, afterAccount, afterOther, passkey } = recipe.chooser;
  return {
    ...layoutMeta(meta),
    ...(other ? { other } : {}),
    ...(next ? { continue: next } : {}),
    ...(afterAccount ? { afterAccount: routeBodyOf(afterAccount) } : {}),
    ...(afterOther ? { afterOther: routeBodyOf(afterOther) } : {}),
    ...(passkey ? { passkey: routeBodyOf(passkey) } : {}),
  };
}
/** The chooser with `layout` in place of the layout of the same key, or added after them. */
export function withChooserLayout(
  recipe: LoginChooserDocument,
  layout: LoginChooserLayout,
): LoginChooserDocument {
  const at = recipe.chooser.layouts.findIndex((entry) => entry.key === layout.key);
  return {
    ...recipe,
    chooser: {
      ...recipe.chooser,
      layouts:
        at === -1
          ? [...recipe.chooser.layouts, layout]
          : recipe.chooser.layouts.map((entry, index) => (index === at ? layout : entry)),
    },
  };
}
/**
 * One layout of a stored recipe as the recipe a login runs (ADR 0060): the layout of the
 * key, or without a key the newest one, of the sign-in form (`kind` "form") or the list
 * (`kind` "list") alone when `kind` is given; `undefined` for an entry recipe or a key of
 * no layout. Keys are unique over both kinds.
 */
export function storedLayoutRecipe(
  recipe: StoredLoginRecipe,
  key?: string,
  kind?: "form" | "list",
): LoginRecipe | LoginChooserRecipe | undefined {
  const layouts = isLoginRecipeDocument(recipe) && kind !== "list" ? recipe.layouts : [];
  const choosers = isChooserDocument(recipe) && kind !== "form" ? recipe.chooser.layouts : [];
  const wanted = key ?? newestLayout<LayoutMeta>([...layouts, ...choosers])?.key;
  const layout = layouts.find((entry) => entry.key === wanted);
  if (layout) return layoutRecipe(recipe as LoginRecipeDocument, layout);
  const chooser = choosers.find((entry) => entry.key === wanted);
  return chooser && chooserLayoutRecipe(recipe as LoginChooserDocument, chooser);
}
/**
 * The key, language and creation time of each layout of a stored recipe, its sign-in form's
 * then its list's; none for an entry.
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
 * recipe's last layout of one kind takes that kind away, so the other kind stays alone.
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
/**
 * The branch name of a layout and chooser branch (ADR 0060): the key, then the chooser
 * branch after a colon.
 */
export function recipeBranch(layout: string, branch?: ChooserBranch): string {
  return branch ? `${layout}:${branch}` : layout;
}
/** A branch name's layout key and chooser branch, if it is one (`recipeBranchSchema`). */
export function parseRecipeBranch(
  value: string,
): { layout: string; branch?: ChooserBranch } | undefined {
  if (!v.is(recipeBranchSchema, value)) return undefined;
  const [layout, branch] = value.split(":") as [string, ChooserBranch | undefined];
  return branch ? { layout, branch } : { layout };
}
/**
 * The route a stored recipe runs on a branch name (ADR 0060): a login recipe's layout, or
 * the route of a chooser layout's branch with that chooser (absent until generated). A
 * name of no layout of the recipe, a chooser branch of a recipe without a list or a sign-in
 * layout's name on a recipe without one answers `undefined`.
 */
export function storedBranchRoute(
  recipe: StoredLoginRecipe,
  value: string,
): { route: LoginRecipe | undefined; chooser?: LoginChooserRecipe } | undefined {
  const named = parseRecipeBranch(value);
  if (!named) return undefined;
  if (!named.branch) {
    const route = isLoginRecipeDocument(recipe)
      ? findLayoutRecipe(recipe, named.layout)
      : undefined;
    return route && { route };
  }
  if (!isChooserDocument(recipe)) return undefined;
  const chooser = findChooserLayout(recipe, named.layout);
  return chooser && { route: chooserBranch(chooser, named.branch), chooser };
}
/**
 * The chooser with one branch replaced by `next`, as the revision `next` carries: the
 * other branches, if any, move to that revision unchanged, since every branch has its
 * chooser's revision.
 */
export function withChooserBranch(
  recipe: LoginChooserRecipe,
  branch: ChooserBranch,
  next: LoginRecipe,
): LoginChooserRecipe {
  const others = chooserBranchSchema.options.flatMap((name) => {
    const other = name === branch ? undefined : chooserBranch(recipe, name);
    return other ? [[branchMember[name], { ...other, revision: next.revision }] as const] : [];
  });
  return {
    ...recipe,
    revision: next.revision,
    chooser: { ...recipe.chooser, ...Object.fromEntries(others), [branchMember[branch]]: next },
  };
}
/**
 * The slots a stored recipe's routes fill, over all its layouts (ADR 0060): its sign-in
 * form's and its list's branches'; none for an entry.
 */
export function storedRecipeSlots(recipe: StoredLoginRecipe): string[] {
  if ("entry" in recipe || "logout" in recipe) return [];
  const routes = [
    ...(isLoginRecipeDocument(recipe) ? recipeLayouts(recipe) : []),
    ...(isChooserDocument(recipe)
      ? chooserLayouts(recipe).flatMap((chooser) =>
          [
            chooser.chooser.afterAccount,
            chooser.chooser.afterOther,
            chooser.chooser.passkey,
          ].filter((branch) => branch !== undefined),
        )
      : []),
  ];
  return [...new Set(routes.flatMap(recipeSlots))];
}
