import * as v from "valibot";
import type { LoginRecipe, LayoutMeta, LoginRouteBody, LoginLayout } from "./route-schema";
import {
  type LoginChooserRecipe,
  type LoginEntryRecipe,
  type LoginRecipeDocument,
  type StoredLoginRecipe,
  type LoginChooserDocument,
  chooserLayoutRecipe,
  type LoginChooserLayout,
  chooserBranch,
  branchMember,
  chooserLayouts,
} from "./document-schema";
import { type ChooserBranch, recipeBranchSchema, chooserBranchSchema } from "./branch-schema";
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
/**
 * Every path a stored recipe starts on: its start path, then a recipe document's other
 * start paths (`starts`, ADR 0060 amendment of 2026-11-18). An entry or logout recipe has
 * its own path only.
 */
export function storedRecipeStartPaths(recipe: StoredLoginRecipe): string[] {
  return [
    storedRecipeStartPath(recipe),
    ...("starts" in recipe && recipe.starts ? recipe.starts : []),
  ];
}
/**
 * The start path a page on `path` stands for in a stored recipe: the start path itself
 * for a page on one of the recipe's other start paths (ADR 0060 amendment of 2026-11-18),
 * so the service reads that page as one of the start path; any other path as it is.
 */
export function startPathFor(recipe: StoredLoginRecipe, path: string): string {
  return "starts" in recipe && recipe.starts?.includes(path) ? storedRecipeStartPath(recipe) : path;
}
/**
 * The path a projection a login runs starts on: a chooser's list's (ADR 0028), or else its
 * first step's, which every variant and its passkey route share.
 */
export function projectionStartPath(recipe: LoginRecipe | LoginChooserRecipe): string {
  return "chooser" in recipe ? recipe.chooser.path : recipe.steps[0]!.path;
}
/** A route with every path that is `from` in its steps, variants, passkey and handlers `to`. */
function routeOnPath<Route extends LoginRouteBody>(route: Route, from: string, to: string): Route {
  const at = <Entry extends { path: string }>(entry: Entry): Entry =>
    entry.path === from ? { ...entry, path: to } : entry;
  return {
    ...route,
    steps: route.steps.map(at),
    ...(route.alternatives
      ? {
          alternatives: route.alternatives.map((variant) => ({
            ...variant,
            steps: variant.steps.map(at),
          })),
        }
      : {}),
    ...(route.passkey ? { passkey: at(route.passkey) } : {}),
    ...(route.handlers ? { handlers: route.handlers.map(at) } : {}),
  };
}
/**
 * A projection a login runs, on another path its recipe starts on (`starts`, ADR 0060
 * amendment of 2026-11-18): every path that is the projection's start path becomes `path`,
 * in its steps, its variants' steps, its passkey route and its handlers, and for a chooser
 * in its list's path and each branch's. Steps and handlers on other paths keep theirs, and
 * so do signed-in markers, a link's path among them, which prove a sign-in on any path. On
 * its own start path the projection is returned as it is.
 */
export function projectionOn<Recipe extends LoginRecipe | LoginChooserRecipe>(
  recipe: Recipe,
  path: string,
): Recipe {
  const from = projectionStartPath(recipe);
  if (from === path) return recipe;
  if (!("chooser" in recipe)) return routeOnPath(recipe as LoginRecipe, from, path) as Recipe;
  const { afterAccount, afterOther, passkey } = recipe.chooser;
  return {
    ...recipe,
    chooser: {
      ...recipe.chooser,
      path,
      ...(afterAccount ? { afterAccount: routeOnPath(afterAccount, from, path) } : {}),
      ...(afterOther ? { afterOther: routeOnPath(afterOther, from, path) } : {}),
      ...(passkey ? { passkey: routeOnPath(passkey, from, path) } : {}),
    },
  };
}
/** Whether a stored recipe starts on `path`: its start path or one of its `starts`. */
export const startsOnPath = (recipe: StoredLoginRecipe, path: string): boolean =>
  storedRecipeStartPaths(recipe).includes(path);
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
