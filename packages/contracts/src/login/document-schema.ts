import * as v from "valibot";
import {
  identifier,
  revision,
  loginOriginSchema,
  path,
  loginAttributeTargetSchema,
  loginTextTargetSchema,
  loginAccessibleNameTargetSchema,
  loginTargetSchema,
  loginMarkerTargetSchema,
  unique,
  type LoginTarget,
  sameLoginTarget,
} from "./targets";
import {
  recipeLayoutKeySchema,
  loginRecipeSchema,
  recipeLanguageSchema,
  layoutCreatedAt,
  loginRouteBodySchema,
  loginLayoutSchema,
  MAX_RECIPE_LAYOUTS,
  variantsOf,
  targetKey,
  handlerTargets,
  routeSlotCount,
  markersOffOrigin,
  fitsDocumentBytes,
  type LoginLayout,
  type LoginRecipe,
  type LoginRouteBody,
} from "./route-schema";
import { createSsoRoutesSchema } from "../sso";
import type { ChooserBranch, ChooserClick } from "./branch-schema";

/**
 * A recipe whose only member is `entry` (ADR 0031): the start path of a page without a
 * login form, and the control there that opens the site's login page, such as "Login" on
 * a top page the site sent the visitor to before signing in. It has no slots, steps,
 * submission budget or login route members, reads no vault field and never gains steps.
 * Only an `<a href>` link is to be pressed, which a `text` target names by its rendered
 * text as an `accountSwitch` does; its target is an `id`, `name`, `test-id` or `text`
 * locator, never `autocomplete` or `label`, which name only inputs, nor `accessible-name`,
 * which names only a `password` handler's button or a route step's click.
 *
 * The service generates it for an entry request (`entryGenerationRequestSchema`) and
 * stores it; devices cache it, but nothing sends such a request or presses it yet, it
 * starts no login and its path is not a path where a login recipe starts.
 */
export const loginEntryRecipeSchema = v.strictObject({
  version: v.literal(1),
  id: identifier,
  revision,
  origin: loginOriginSchema,
  entry: v.strictObject({
    path,
    // A link or button locator; `autocomplete` and `label` name only inputs, which are never
    // pressed, and `accessible-name` only a `password` handler's button or a route click.
    target: v.variant("by", [
      loginAttributeTargetSchema.options[0],
      loginAttributeTargetSchema.options[1],
      loginTextTargetSchema,
    ]),
  }),
});
/**
 * A list control's locator: never `autocomplete` or `label`, which name only inputs, nor
 * `accessible-name`, which names only a `password` handler's button or a route step's click.
 */
const chooserTargetSchema = v.variant("by", [
  loginAttributeTargetSchema.options[0],
  loginAttributeTargetSchema.options[1],
  loginTextTargetSchema,
]);
/** A chooser recipe's members, before the checks that relate them. */
const chooserRecipeEntriesSchema = v.strictObject({
  version: v.literal(1),
  id: identifier,
  revision,
  origin: loginOriginSchema,
  /** The layout this chooser was projected from (ADR 0060). */
  layout: v.optional(recipeLayoutKeySchema),
  chooser: v.strictObject({
    path,
    other: v.optional(chooserTargetSchema),
    continue: v.optional(chooserTargetSchema),
    afterAccount: v.optional(loginRecipeSchema),
    afterOther: v.optional(loginRecipeSchema),
    passkey: v.optional(loginRecipeSchema),
  }),
});
/**
 * A recipe that starts on a page listing accounts to choose from (ADR 0028), as a login
 * runs it: one layout of a stored chooser (`chooserLayoutRecipe`, ADR 0060), such as
 * Cloudflare's saved profiles. `chooser.path` is where the list shows. `other` is the
 * button that continues without a listed account ("Sign in with another profile"), and
 * `continue` the one that continues with the one account a page shows beside it ("Log
 * back in" on Wise). The entry to click is never stored: it is found on the page from
 * the chosen item's username each time.
 *
 * Each branch is the route recipe for the page the click leads to, after a listed or
 * shown account (`afterAccount`) or after `other` (`afterOther`), under the chooser's own
 * ID, origin, revision and layout. A branch is absent until a login takes it and its page
 * is generated as an ADR 0018 continuation.
 *
 * `passkey` is the passkey button shown beside the list (ADR 0079): a passkey-only route
 * (ADR 0053) on the list's path, which an item with a discoverable passkey takes instead
 * of the list, under the same ID, origin, revision and layout.
 *
 * A login on the list runs `chooserRoute` for what it clicks there, so a branch is held
 * only when that route is a recipe for every click that leads to it. With the click on
 * the list in front, a branch has at most 31 steps, at most 7 of them clicks or fills
 * that advance or submit, nothing that proves or hands off the sign-in on the button it
 * clicks there, and no `passkeyOnly`; `chooserRoute` decides each case.
 */
export const loginChooserRecipeSchema = v.pipe(
  chooserRecipeEntriesSchema,
  v.check(
    ({ id, revision: current, origin, layout, chooser }) =>
      [chooser.afterAccount, chooser.afterOther, chooser.passkey].every(
        (branch) =>
          !branch ||
          (branch.id === id &&
            branch.revision === current &&
            branch.origin === origin &&
            branch.layout === layout),
      ),
    "A chooser branch has the chooser's ID, revision, origin and layout",
  ),
  v.check(
    ({ chooser }) =>
      !chooser.other ||
      !chooser.continue ||
      JSON.stringify(chooser.other) !== JSON.stringify(chooser.continue),
    "The chooser's other and continue buttons differ",
  ),
  v.check(
    ({ chooser }) => !chooser.afterOther || chooser.other !== undefined,
    "A chooser has an other-account branch only with its button",
  ),
  v.check(
    ({ chooser }) => !chooser.passkey || passkeyBesideList(chooser, chooser.passkey),
    "A chooser's passkey route is a passkey-only route on its path",
  ),
  // A branch runs only as `chooserRoute` builds it, so every click that leads to it must
  // make a recipe of it.
  v.check(
    (recipe) => chooserClicks(recipe).every((click) => chooserRoute(recipe, click) !== undefined),
    "A chooser branch cannot run after the click that leads to it",
  ),
);
/** How many clicks a logout recipe holds (ADR 0063): a switch runs at most 3 rounds. */
export const MAX_LOGOUT_TARGETS = 3;
/**
 * What a logout recipe's click does (ADR 0063): `menu` opens a menu or panel that holds the
 * logout control, `logout` signs the person out (a site may then ask to confirm), and
 * `confirm` confirms a sign-out a dialog or page asks about.
 */
export const logoutPurposeSchema = v.picklist(["menu", "logout", "confirm"]);
/**
 * A logout click's locator: a control by `id`, `name`, `test-id`, its rendered text, or,
 * for a control that shows no text of its own (an icon-only account menu, or a menu item),
 * its `aria-label` or `title` (`accessible-name`); never `autocomplete` or `label`, which
 * name only inputs.
 */
export const logoutTargetSchema = v.variant("by", [
  loginAttributeTargetSchema.options[0],
  loginAttributeTargetSchema.options[1],
  loginTextTargetSchema,
  loginAccessibleNameTargetSchema,
]);
/**
 * A recipe whose only member is `logout` (ADR 0063): how a signed-in page of the origin
 * signs out, for switching to another account from the toolbar popup. `path` is the page
 * the first click is on; each target is a click on the path the page then shows, in order,
 * such as the account menu, then "Sign out" in it, then the confirmation. It reads no vault
 * field, starts no login and its path is never a path where a login recipe starts. The
 * service keys it apart from a login, chooser or entry recipe of the same origin and path.
 */
export const loginLogoutRecipeSchema = v.pipe(
  v.strictObject({
    version: v.literal(1),
    id: identifier,
    revision,
    origin: loginOriginSchema,
    logout: v.strictObject({
      path,
      targets: v.pipe(
        v.array(
          v.strictObject({
            kind: v.literal("click"),
            path,
            target: logoutTargetSchema,
            purpose: logoutPurposeSchema,
          }),
        ),
        v.minLength(1),
        v.maxLength(MAX_LOGOUT_TARGETS),
      ),
    }),
  }),
  v.check(
    ({ logout }) => logout.targets[0]!.path === logout.path,
    "A logout recipe starts with a click on its path",
  ),
  v.check(
    ({ logout }) =>
      logout.targets.every(
        (target, index) =>
          target.purpose !== "confirm" ||
          (index === logout.targets.length - 1 && logout.targets[index - 1]?.purpose === "logout"),
      ),
    "Only a last click right after the logout confirms it",
  ),
);
/**
 * One layout of a stored chooser (ADR 0060): its list's buttons and the routes of its
 * branches, with its stable key, language and creation time. A list whose buttons are
 * named by their text gets another layout on a day the site shows another language.
 */
export const loginChooserLayoutSchema = v.pipe(
  v.strictObject({
    key: recipeLayoutKeySchema,
    language: v.optional(recipeLanguageSchema),
    createdAt: layoutCreatedAt,
    other: v.optional(chooserTargetSchema),
    continue: v.optional(chooserTargetSchema),
    afterAccount: v.optional(loginRouteBodySchema),
    afterOther: v.optional(loginRouteBodySchema),
    /** The passkey button beside the list, as a passkey-only route (ADR 0079). */
    passkey: v.optional(loginRouteBodySchema),
  }),
  v.check(
    (layout) =>
      !layout.other ||
      !layout.continue ||
      JSON.stringify(layout.other) !== JSON.stringify(layout.continue),
    "The chooser's other and continue buttons differ",
  ),
  v.check(
    (layout) => !layout.afterOther || layout.other !== undefined,
    "A chooser has an other-account branch only with its button",
  ),
);
/**
 * The layouts of a stored recipe's sign-in form: up to `MAX_RECIPE_LAYOUTS`, each a whole
 * login route starting on the recipe's start path (ADR 0060).
 */
const loginLayoutsSchema = v.pipe(
  v.array(loginLayoutSchema),
  v.minLength(1),
  v.maxLength(MAX_RECIPE_LAYOUTS),
);
/**
 * The list of accounts of a stored recipe (ADR 0028): its path, and up to
 * `MAX_RECIPE_LAYOUTS` layouts of the list, each with its own branches.
 */
const storedChooserSchema = v.strictObject({
  path,
  layouts: v.pipe(
    v.array(loginChooserLayoutSchema),
    v.minLength(1),
    v.maxLength(MAX_RECIPE_LAYOUTS),
  ),
});
/** Declarative SSO entries are kept apart from native executable routes. */
export const loginSsoRoutesSchema = createSsoRoutesSchema({
  path,
  target: loginTargetSchema,
  marker: loginMarkerTargetSchema,
  key: recipeLayoutKeySchema,
  language: recipeLanguageSchema,
});
/** A stored recipe document's members, before the checks that relate them. */
const recipeDocumentEntriesSchema = v.strictObject({
  version: v.literal(1),
  id: identifier,
  revision,
  origin: loginOriginSchema,
  layouts: v.optional(loginLayoutsSchema),
  chooser: v.optional(storedChooserSchema),
  sso: v.optional(loginSsoRoutesSchema),
});
/** Each route a stored recipe's chooser layouts hold: their branches and passkey routes. */
const chooserBranchBodies = (chooser: v.InferOutput<typeof storedChooserSchema> | undefined) =>
  (chooser?.layouts ?? []).flatMap((layout) =>
    [layout.afterAccount, layout.afterOther, layout.passkey].filter(
      (branch) => branch !== undefined,
    ),
  );
/**
 * A stored recipe (ADR 0060, ADR 0028): one generated recipe per origin and start path. The
 * same URL may show a sign-in form or a list of accounts, as by the state of the browser's
 * session, so a recipe holds the layouts of either or both: `layouts`, up to
 * `MAX_RECIPE_LAYOUTS` sign-in forms, each a whole login route, and `chooser`, up to as many
 * lists of accounts on the same path, each with its branches. A repair adds the kind the
 * page showed beside the other instead of replacing it (ADR 0041 section 6, owner
 * 2026-11-04). The ID, the bindings and the site defaults stay the recipe's. Each chooser
 * layout, as a login runs it (`chooserLayoutRecipe`), holds a branch only when
 * `chooserRoute` makes a recipe of it for every click that leads there, as
 * `loginChooserRecipeSchema` requires.
 */
export const recipeDocumentSchema = v.pipe(
  recipeDocumentEntriesSchema,
  v.check(
    (recipe) =>
      recipe.layouts !== undefined || recipe.chooser !== undefined || recipe.sso !== undefined,
    "A recipe holds a sign-in form or a list of accounts",
  ),
  v.check(
    (recipe) =>
      unique([
        ...(recipe.layouts ?? []).map((layout) => layout.key),
        ...(recipe.chooser?.layouts ?? []).map((layout) => layout.key),
        ...(recipe.sso?.layouts ?? []).map((layout) => layout.key),
      ]),
    "Duplicate layout keys",
  ),
  v.check(
    ({ layouts }) =>
      !layouts || layouts.every((layout) => layout.steps[0]!.path === layouts[0]!.steps[0]!.path),
    "Every layout starts on the recipe's start path",
  ),
  v.check(
    ({ layouts, chooser }) => !layouts || !chooser || layouts[0]!.steps[0]!.path === chooser.path,
    "The list of accounts shows on the recipe's start path",
  ),
  v.check(
    ({ layouts, chooser, sso }) =>
      !sso ||
      ((!layouts || layouts[0]!.steps[0]!.path === sso.path) &&
        (!chooser || chooser.path === sso.path)),
    "SSO entries share the recipe start path",
  ),
  v.check((recipe) => {
    if (!recipe.sso) return true;
    const native = [...(recipe.layouts ?? []), ...chooserBranchBodies(recipe.chooser)];
    const used = new Set(
      native.flatMap((route) => [
        ...variantsOf(route).flatMap((variant) =>
          variant.steps.flatMap((step) =>
            (step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target]).map(
              (target) => `${step.path}\n${targetKey(target)}`,
            ),
          ),
        ),
        ...(route.passkey ? [`${route.passkey.path}\n${targetKey(route.passkey.target)}`] : []),
        ...[
          route.accountSwitch,
          route.rejection,
          ...(route.completion ?? []).map((marker) => marker.target),
        ]
          .filter((target) => target !== undefined)
          .map((target) => `${recipe.sso!.path}\n${targetKey(target)}`),
        ...(route.handlers ?? []).flatMap((handler) =>
          handlerTargets(handler).map((target) => `${handler.path}\n${targetKey(target)}`),
        ),
      ]),
    );
    for (const layout of recipe.chooser?.layouts ?? []) {
      for (const target of [layout.other, layout.continue]) {
        if (target) used.add(`${recipe.chooser!.path}\n${targetKey(target)}`);
      }
    }
    return recipe.sso.layouts.every((layout) =>
      layout.entries.every((entry) => !used.has(`${recipe.sso!.path}\n${targetKey(entry.target)}`)),
    );
  }, "SSO targets are separate from native executable routes"),
  // All layouts share one start page, so they share its kind (ADR 0060): a recipe is run,
  // or kept as a confirm or unclear page, as a whole.
  v.check(
    ({ layouts }) =>
      !layouts || layouts.every((layout) => layout.pageKind === layouts[0]!.pageKind),
    "Every layout has the recipe's page kind",
  ),
  // Bindings are kept per recipe and hold at most 20 slots, so every route's slots together
  // fit one (ADR 0060).
  v.check(
    ({ layouts, chooser }) =>
      routeSlotCount([...(layouts ?? []), ...chooserBranchBodies(chooser)]) <= 20,
    "Too many recipe slots",
  ),
  v.check(
    ({ origin, layouts, chooser }) =>
      [...(layouts ?? []), ...chooserBranchBodies(chooser)].every((route) =>
        markersOffOrigin(origin, route),
      ),
    "Completion marker names the recipe's own origin",
  ),
  v.check(
    ({ chooser }) =>
      !chooser ||
      chooser.layouts.every(
        (layout) =>
          !layout.passkey || passkeyBesideList({ ...layout, path: chooser.path }, layout.passkey),
      ),
    "A chooser's passkey route is a passkey-only route on its path",
  ),
  v.check(
    (recipe) =>
      !recipe.chooser ||
      chooserLayouts({ ...recipe, chooser: recipe.chooser }).every((layout) =>
        chooserClicks(layout).every((click) => chooserRoute(layout, click) !== undefined),
      ),
    "A chooser branch cannot run after the click that leads to it",
  ),
  v.check((recipe) => fitsDocumentBytes(recipe), "Recipe document too large"),
);
/** A stored recipe with layouts of a sign-in form (ADR 0060), and maybe a list beside them. */
export const loginRecipeDocumentSchema = v.pipe(
  recipeDocumentSchema,
  v.check((recipe) => recipe.layouts !== undefined, "A recipe holds a sign-in form"),
);
/** A stored recipe with a list of accounts (ADR 0028), and maybe sign-in forms beside it. */
export const loginChooserDocumentSchema = v.pipe(
  recipeDocumentSchema,
  v.check((recipe) => recipe.chooser !== undefined, "A recipe holds a list of accounts"),
);
/**
 * Any recipe the service stores and devices sync: a recipe document of an origin and start
 * path (`recipeDocumentSchema`) with layouts of its sign-in form, whose layouts every login
 * runs as `loginRecipeSchema`, a list of accounts (ADR 0028) with its layouts, or both; an
 * entry recipe (ADR 0031); or a logout recipe (ADR 0063). Strict objects keep them apart,
 * so `entry` or `logout` is never beside `layouts` or `chooser`.
 */
export const storedLoginRecipeSchema = v.union([
  recipeDocumentSchema,
  loginEntryRecipeSchema,
  loginLogoutRecipeSchema,
]);
export type LoginEntryRecipe = v.InferOutput<typeof loginEntryRecipeSchema>;
// Inferred from the members alone: the schema's own checks build `chooserRoute`, which
// takes this type. Its checks change no member's type.
export type LoginChooserRecipe = v.InferOutput<typeof chooserRecipeEntriesSchema>;
export type LoginLogoutRecipe = v.InferOutput<typeof loginLogoutRecipeSchema>;
export type LogoutPurpose = v.InferOutput<typeof logoutPurposeSchema>;
export type LogoutTarget = LoginLogoutRecipe["logout"]["targets"][number];
export type StoredLoginRecipe = v.InferOutput<typeof storedLoginRecipeSchema>;
export type LoginChooserLayout = v.InferOutput<typeof loginChooserLayoutSchema>;
// Inferred from the members alone, as `LoginChooserRecipe` is: the schema's own checks
// project its chooser layouts with `chooserLayoutRecipe`, which takes this type.
/** A stored recipe document (`recipeDocumentSchema`): sign-in form layouts, a list, or both. */
export type RecipeDocument = v.InferOutput<typeof recipeDocumentEntriesSchema>;
/** A recipe document with layouts of a sign-in form (ADR 0060). */
export type LoginRecipeDocument = RecipeDocument & { layouts: LoginLayout[] };
/** A recipe document with a list of accounts (ADR 0028). */
export type LoginChooserDocument = RecipeDocument & {
  chooser: v.InferOutput<typeof storedChooserSchema>;
};
/**
 * One layout of a stored chooser as the chooser a login runs (ADR 0060): its buttons, and
 * its branches as route recipes under the document's ID, revision and origin and its key.
 */
export function chooserLayoutRecipe(
  recipe: LoginChooserDocument,
  layout: LoginChooserLayout,
): LoginChooserRecipe {
  const branch = (route: LoginRouteBody | undefined): LoginRecipe | undefined =>
    route && {
      version: 1,
      id: recipe.id,
      revision: recipe.revision,
      origin: recipe.origin,
      layout: layout.key,
      ...route,
    };
  const afterAccount = branch(layout.afterAccount);
  const afterOther = branch(layout.afterOther);
  const passkey = branch(layout.passkey);
  return {
    version: 1,
    id: recipe.id,
    revision: recipe.revision,
    origin: recipe.origin,
    layout: layout.key,
    chooser: {
      path: recipe.chooser.path,
      ...(layout.other ? { other: layout.other } : {}),
      ...(layout.continue ? { continue: layout.continue } : {}),
      ...(afterAccount ? { afterAccount } : {}),
      ...(afterOther ? { afterOther } : {}),
      ...(passkey ? { passkey } : {}),
    },
  };
}
/** Every layout of a stored chooser as a chooser a login runs, in stored order. */
export function chooserLayouts(recipe: LoginChooserDocument): LoginChooserRecipe[] {
  return recipe.chooser.layouts.map((layout) => chooserLayoutRecipe(recipe, layout));
}
export const branchMember = {
  account: "afterAccount",
  other: "afterOther",
  passkey: "passkey",
} as const;
/** A chooser's route recipe for one branch, if a login generated it already. */
export function chooserBranch(
  recipe: LoginChooserRecipe,
  branch: ChooserBranch,
): LoginRecipe | undefined {
  return recipe.chooser[branchMember[branch]];
}
/** The branch a click on the list leads to, or the branch already shown. */
export const chooserClickBranch = (click: ChooserClick): ChooserBranch =>
  click === "passkey"
    ? "passkey"
    : click === "other" || click === "other-shown"
      ? "other"
      : "account";
/**
 * Whether `route` is a passkey-only sign-in route (ADR 0053) whose button is on the list's
 * `path` and is neither of its buttons, as a chooser's `passkey` must be (ADR 0079).
 */
function passkeyBesideList(
  list: { path: string; other?: LoginTarget | undefined; continue?: LoginTarget | undefined },
  route: LoginRouteBody,
): boolean {
  const button = route.passkey;
  return (
    route.passkeyOnly === true &&
    route.pageKind === "sign-in" &&
    button?.path === list.path &&
    route.steps.every((step) => step.path === list.path) &&
    [list.other, list.continue].every(
      (control) => !control || !sameLoginTarget(control, button.target),
    )
  );
}
/**
 * The locator a chooser login's click on an account entry carries. It names no element:
 * the content script finds the entry of the account the worker chose, by the rule of ADR
 * 0028, and the entry itself is never stored.
 */
export const CHOOSER_ENTRY_TARGET = { by: "text", value: "[account]" } as const;
/**
 * The login recipe a chooser's login runs (ADR 0028): the click on the list, as an
 * `advance` step on the chooser's path, then the steps of the branch it leads to, once
 * generated. It has the chooser's ID, revision and origin, the branch's completion,
 * handlers and account switch, and one submission more than the branch for the click. It
 * always has the `username` slot, which picks the account's entry. For `other-shown` it is
 * the `other` branch alone, without a click, and only once that branch starts on the
 * chooser's path. `undefined` when the chooser has no button for the click, or the result
 * is no valid recipe.
 */
export function chooserRoute(
  recipe: LoginChooserRecipe,
  click: ChooserClick,
): LoginRecipe | undefined {
  // The passkey button beside the list is its own route, stored whole (ADR 0079).
  if (click === "passkey") return recipe.chooser.passkey;
  if (click === "other-shown") {
    const shown = recipe.chooser.afterOther;
    if (!shown || shown.steps[0]!.path !== recipe.chooser.path) return undefined;
    const { alternatives: _alternatives, passkey: _passkey, ...rest } = shown;
    const parsed = v.safeParse(loginRecipeSchema, {
      ...rest,
      id: recipe.id,
      revision: recipe.revision,
      origin: recipe.origin,
      ...(recipe.layout === undefined ? {} : { layout: recipe.layout }),
      // A list of accounts is always a sign-in page (ADR 0035).
      pageKind: "sign-in",
    });
    return parsed.success ? parsed.output : undefined;
  }
  const target =
    click === "entry"
      ? CHOOSER_ENTRY_TARGET
      : click === "continue"
        ? recipe.chooser.continue
        : recipe.chooser.other;
  if (!target) return undefined;
  const branch = chooserBranch(recipe, chooserClickBranch(click));
  // A branch never starts a login, so it has no alternatives or passkey route.
  const { alternatives: _alternatives, passkey: _passkey, ...rest } = branch ?? {};
  const parsed = v.safeParse(loginRecipeSchema, {
    ...rest,
    version: 1,
    id: recipe.id,
    revision: recipe.revision,
    origin: recipe.origin,
    ...(recipe.layout === undefined ? {} : { layout: recipe.layout }),
    pageKind: "sign-in",
    slots: [...new Set(["username", ...(branch?.slots ?? [])])],
    steps: [
      { kind: "click", path: recipe.chooser.path, target, purpose: "advance" },
      ...(branch?.steps ?? []),
    ],
    maxSubmissions: Math.min(8, (branch?.maxSubmissions ?? 0) + 1),
  });
  return parsed.success ? parsed.output : undefined;
}
/**
 * The clicks a login can take on a chooser's list, each with its `chooserRoute`: an
 * account's entry, the `continue` and `other` buttons the chooser has, and `other-shown`
 * once its `other` branch starts on the list's path.
 */
function chooserClicks(recipe: LoginChooserRecipe): ChooserClick[] {
  const { chooser } = recipe;
  return [
    "entry",
    ...(chooser.continue ? (["continue"] as const) : []),
    ...(chooser.other ? (["other"] as const) : []),
    ...(chooser.afterOther?.steps[0]!.path === chooser.path ? (["other-shown"] as const) : []),
    ...(chooser.passkey ? (["passkey"] as const) : []),
  ];
}
