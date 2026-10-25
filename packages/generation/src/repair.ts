import {
  loginStepEffect,
  MAX_RECIPE_LAYOUTS,
  newLayoutKey,
  routeBodyOf,
  sameLoginTarget,
  toLoginLayout,
  type LoginChooserDocument,
  type LoginChooserLayout,
  type LoginLayout,
  type LoginMarkerTarget,
  type LoginRecipe,
  type LoginRecipeDocument,
  type LoginRouteBody,
  type LoginStep,
  type LoginTarget,
  type RecipeLanguage,
} from "@pateat/contracts";

// What a repair writes into a recipe's layouts (ADR 0041): a layout for a page the
// recipe's layouts no longer match is added beside them, never written over one.

/** A variant's steps up to and including its first advance or submit: its start page. */
const firstPage = (steps: readonly LoginStep[]) => {
  const end = steps.findIndex((step) => {
    const effect = loginStepEffect(step);
    return effect === "advance" || effect === "submit";
  });
  return steps.slice(0, end < 0 ? undefined : end + 1);
};

/**
 * What a route does on its start page, locators and their values included: each variant's
 * steps there, its account switch and, unless `passkey` is false, its passkey button.
 */
function startPage(route: LoginRouteBody, passkey = true): string {
  return JSON.stringify([
    firstPage(route.steps),
    (route.alternatives ?? []).map((variant) => firstPage(variant.steps)),
    route.accountSwitch ?? null,
    passkey ? (route.passkey ?? null) : null,
  ]);
}

/** A start-page step without its locators: what it does, not which element it does it on. */
const stepShape = (step: LoginStep) =>
  step.kind === "fill"
    ? { ...step, fields: step.fields.map((field) => field.slot) }
    : { ...step, target: null };

/**
 * What a route does on its start page without its passkey button, its account switch or any
 * locator: each variant's steps there by kind, path, slots and purpose.
 */
const startShape = (route: LoginRouteBody) =>
  JSON.stringify([
    firstPage(route.steps).map(stepShape),
    (route.alternatives ?? []).map((variant) => firstPage(variant.steps).map(stepShape)),
  ]);

/** Every element a route's start page acts on, in each variant. */
const startTargets = (route: LoginRouteBody): LoginMarkerTarget[] =>
  [route.steps, ...(route.alternatives ?? []).map((variant) => variant.steps)].flatMap((steps) =>
    firstPage(steps).flatMap((step) =>
      step.kind === "fill" ? step.fields.map((field) => field.target) : [step.target],
    ),
  );

/**
 * What a repair's answer changes in the recipe: `same` when a layout already does what it
 * does, so nothing is written; otherwise the next revision with the layout it `merged` the
 * answer into, `added`, or put in place of the least recently used one (`replaced`).
 */
export type RepairWrite<Document = LoginRecipeDocument> =
  | { kind: "same"; layout: string }
  | {
      kind: "merged" | "added" | "replaced";
      recipe: Document;
      layout: string;
      /** For `replaced`: the layout it took the place of. */
      removed?: string;
    };

/**
 * Writes a repair's answer into the recipe (ADR 0041). For a start page (`later` unset), an
 * answer whose start page a layout already has writes nothing, and one that only adds a
 * passkey button to a layout's start page is merged into that layout, which keeps what it
 * learned: the same steps there, locators included, or the same steps by another locator
 * while the page still shows every element the layout's start page names (`shown`). For a later step's page, the answer is the stale layout cut before that step and
 * continued, and only a layout with the same steps makes it `same`. Anything else is a new
 * layout with the page's language; with `MAX_RECIPE_LAYOUTS` already, it takes the place of
 * the one least recently used: the later of its creation and its last use (`lastUsed`).
 */
export function repairWrite(
  recipe: LoginRecipeDocument,
  answer: LoginRecipe,
  options: {
    createdAt: number;
    language?: RecipeLanguage | undefined;
    lastUsed?: (key: string) => number | undefined;
    later?: boolean;
    /** The elements the repaired page showed, which a layout merged into must all name. */
    shown?: readonly LoginMarkerTarget[];
  },
): RepairWrite {
  const route = routeBodyOf(answer);
  const next = (layouts: LoginLayout[]) => ({
    ...recipe,
    revision: recipe.revision + 1,
    layouts,
  });
  if (options.later) {
    const steps = JSON.stringify(route.steps);
    const same = recipe.layouts.find((layout) => JSON.stringify(layout.steps) === steps);
    if (same) return { kind: "same", layout: same.key };
  } else {
    const page = startPage(route);
    const same = recipe.layouts.find((layout) => startPage(layout) === page);
    if (same) return { kind: "same", layout: same.key };
    // The model may name a start page's elements by other locators than the layout's, so
    // a layout doing the same on the page, whose every element the page still shows, takes
    // the button too, as its own locators found them.
    const withoutButton = startPage(route, false);
    const shape = startShape(route);
    const onPage = (layout: LoginLayout) =>
      startTargets(layout).every((target) =>
        options.shown?.some((shown) => sameLoginTarget(shown, target)),
      );
    const merged =
      route.passkey &&
      recipe.layouts.find(
        (layout) =>
          !layout.passkey &&
          (startPage(layout, false) === withoutButton ||
            (startShape(layout) === shape && onPage(layout))),
      );
    if (merged)
      return {
        kind: "merged",
        layout: merged.key,
        recipe: next(
          recipe.layouts.map((layout) =>
            layout === merged ? { ...layout, passkey: route.passkey! } : layout,
          ),
        ),
      };
  }
  const key = newLayoutKey(
    options.createdAt,
    recipe.layouts.map((layout) => layout.key),
  );
  const added = toLoginLayout(answer, {
    key,
    ...(options.language ? { language: options.language } : {}),
    createdAt: options.createdAt,
  });
  if (recipe.layouts.length < MAX_RECIPE_LAYOUTS)
    return { kind: "added", layout: key, recipe: next([...recipe.layouts, added]) };
  const removed = leastUsed(recipe.layouts, options.lastUsed);
  return {
    kind: "replaced",
    layout: key,
    removed: removed.key,
    recipe: next([...recipe.layouts.filter((layout) => layout !== removed), added]),
  };
}

/** The layout used least recently: the later of its creation and its last use. */
function leastUsed<Layout extends { key: string; createdAt: number }>(
  layouts: readonly Layout[],
  lastUsed: ((key: string) => number | undefined) | undefined,
): Layout {
  const used = (layout: Layout) => Math.max(layout.createdAt, lastUsed?.(layout.key) ?? 0);
  return layouts.reduce((least, layout) => (used(layout) < used(least) ? layout : least));
}

/**
 * The passkey route beside a list on `path` (ADR 0079), pressing `target`: the passkey-only
 * layout of `carried` (ADR 0053) for the same button, with the handlers and markers it
 * learned, as `from`; otherwise a new one, as a passkey-only start page is generated.
 */
export function listPasskeyRoute(
  path: string,
  target: LoginTarget,
  carried?: LoginRecipeDocument,
): { route: LoginRouteBody; from?: string } {
  const kept = carried?.layouts.find(
    (layout) =>
      layout.passkeyOnly &&
      layout.passkey?.path === path &&
      sameLoginTarget(layout.passkey.target, target),
  );
  if (kept) {
    const { key, language: _language, createdAt: _createdAt, ...route } = kept;
    return { route: { ...route, pageKind: "sign-in" }, from: key };
  }
  return {
    route: {
      pageKind: "sign-in",
      slots: [],
      passkeyOnly: true,
      passkey: { path, target },
      steps: [{ kind: "click", path, target, purpose: "submit" }],
      maxSubmissions: 1,
    },
  };
}

/**
 * What a repair's list of accounts writes into a chooser recipe (ADR 0041 section 6): `same`
 * when a layout already has its buttons, so nothing is written; otherwise the next revision
 * with it as a new layout, without branches, which the next login generates (ADR 0028), in
 * place of the least recently used one when `MAX_RECIPE_LAYOUTS` are held. A passkey button
 * the answer names beside a list a layout already has is `merged` into that layout as its
 * `passkey`, added or in place of one on another button, and its branches stay (ADR 0079);
 * an answer without one leaves a layout's `passkey` as it is.
 */
export function chooserRepairWrite(
  recipe: LoginChooserDocument,
  answer: LoginChooserLayout,
  lastUsed?: (key: string) => number | undefined,
): RepairWrite<LoginChooserDocument> {
  const buttons = (layout: LoginChooserLayout) =>
    JSON.stringify([layout.other ?? null, layout.continue ?? null]);
  const next = (layouts: LoginChooserLayout[]) => ({
    ...recipe,
    revision: recipe.revision + 1,
    chooser: { ...recipe.chooser, layouts },
  });
  const { layouts } = recipe.chooser;
  const same = layouts.find((layout) => buttons(layout) === buttons(answer));
  if (same) {
    const button = answer.passkey?.passkey;
    const held = same.passkey?.passkey;
    if (!button || (held && sameLoginTarget(held.target, button.target)))
      return { kind: "same", layout: same.key };
    return {
      kind: "merged",
      layout: same.key,
      recipe: next(
        layouts.map((layout) =>
          layout === same ? { ...layout, passkey: answer.passkey! } : layout,
        ),
      ),
    };
  }
  if (layouts.length < MAX_RECIPE_LAYOUTS)
    return { kind: "added", layout: answer.key, recipe: next([...layouts, answer]) };
  const removed = leastUsed(layouts, lastUsed);
  return {
    kind: "replaced",
    layout: answer.key,
    removed: removed.key,
    recipe: next([...layouts.filter((layout) => layout !== removed), answer]),
  };
}

/**
 * A layout cut before the step that did not show, as the base its page continues (ADR 0041
 * section 4): its steps before that one, without its signed-in markers, so the page after
 * its last `advance` is generated as a continuation (ADR 0018). `undefined` when the step
 * does not follow an `advance`, or the layout has other variants, which a continuation
 * never extends.
 */
export function repairBase(layout: LoginRecipe, step: number): LoginRecipe | undefined {
  const before = layout.steps[step - 1];
  const failed = layout.steps[step];
  if (
    !before ||
    !failed ||
    layout.alternatives ||
    layout.passkeyOnly ||
    loginStepEffect(before) !== "advance"
  )
    return undefined;
  const { completion: _completion, ...rest } = layout;
  return { ...rest, steps: layout.steps.slice(0, step) };
}
