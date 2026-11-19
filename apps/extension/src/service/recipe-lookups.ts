import {
  chooserLayouts,
  isSsoDocument,
  findChooserLayout,
  findLayoutRecipe,
  isChooserDocument,
  isLoginRecipeDocument,
  laterStartSteps,
  loginLayoutCandidates,
  loginRecipesForOrigin,
  newestLayout,
  recipeLayouts,
  recipeStartSteps,
  runsLogin,
  selectLoginRecipe,
  type LayoutCandidate,
  type LoginChooserDocument,
  type LoginChooserRecipe,
  type LoginEntryRecipe,
  type LoginLogoutRecipe,
  type LoginStep,
  type LoginTarget,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import type { LoginRecipeStart, LoginRecipes } from "../login/runtime/deps";
import { laterReadiness, loginReadiness } from "../login/wire";

/** The recipes a lookup reads. */
type Held = { recipes: readonly StoredLoginRecipe[] };

/** What the lookups read of the recipe cache that holds them (`createRecipeSync`). */
export type RecipeLookupSource = {
  /**
   * The recipes logins use: the paired device's cache, refreshed in the background when
   * `refresh` is set, or without a pairing those this device holds (`local`, ADR 0040).
   */
  current(refresh: boolean): Promise<(Held & { local?: true }) | undefined>;
  /** The paired device's cache alone, which logout recipes come from (ADR 0063). */
  paired(): Promise<Held | undefined>;
  /** Waits, for a few seconds at most, for the sync running or being started now. */
  settled(): Promise<void>;
  /** The cache's write counters: bumped on each write, and the writes in flight. */
  epoch(): { mutation: number; writing: number };
  /** The pairing's fence, if any: its check fails once the pairing changed. */
  serviceFence(): (() => boolean) | undefined;
  /** The device's own recipes' fence, if any (ADR 0040). */
  deviceFence(): (() => boolean) | undefined;
};

/**
 * The lookups logins run on the recipe cache (`LoginRecipes`). Each projects one layout of
 * a stored recipe to the recipe a login runs (ADR 0060). Without a layout named, it is the
 * newest one; a new login chooses among `layouts` (or `choosers`) itself.
 */
export function createRecipeLookups(source: RecipeLookupSource): LoginRecipes {
  /** Whether nothing was written since `started` and no write is in flight. */
  const unaltered = (started: number) => {
    const { mutation, writing } = source.epoch();
    return mutation === started && writing === 0;
  };
  const choosersOf = (cache: Held, origin: string) =>
    cache.recipes.filter(
      (recipe): recipe is LoginChooserDocument =>
        isChooserDocument(recipe) && recipe.origin === origin,
    );
  const documentOf = (cache: Held, origin: string, recipeId: string) =>
    loginRecipesForOrigin(cache.recipes, origin).find((recipe) => recipe.id === recipeId);
  const projectedDocumentOf = (cache: Held, origin: string, recipeId: string) => {
    const stored = cache.recipes.find(
      (recipe) => recipe.origin === origin && recipe.id === recipeId,
    );
    return stored && isLoginRecipeDocument(stored) ? stored : undefined;
  };
  /**
   * The chooser documents whose list shows on the path. The service keeps one generated
   * recipe per origin and start path; a path where several start, or where another
   * recipe's sign-in form starts as well, starts none (ADR 0013). The recipe's own sign-in
   * layouts beside its list do not count: the page shows one or the other (ADR 0028).
   */
  function choosersOn(cache: Held, origin: string, path: string) {
    const here = choosersOf(cache, origin).filter((recipe) => recipe.chooser.path === path);
    return here.length === 1 &&
      !loginRecipesForOrigin(cache.recipes, origin).some(
        (recipe) => recipe.id !== here[0]!.id && recipe.layouts[0]!.steps[0]!.path === path,
      )
      ? here[0]
      : undefined;
  }
  const chooserCandidates = (recipe: LoginChooserDocument) =>
    chooserLayouts(recipe).map((projected, index): LayoutCandidate<LoginChooserRecipe> => ({
      recipe: projected,
      ...(recipe.chooser.layouts[index]!.language
        ? { language: recipe.chooser.layouts[index]!.language }
        : {}),
      createdAt: recipe.chooser.layouts[index]!.createdAt,
    }));
  /** A resumed attempt's own recipe and layout, or else the newest layout. */
  function resumedRecipe(cache: Held, origin: string, recipeId: string, layout?: string) {
    const stored = documentOf(cache, origin, recipeId);
    if (!stored) return undefined;
    if (layout === undefined) return newestLayout(loginLayoutCandidates(stored))?.recipe;
    // A layout generated as `confirm` or `unclear` never resumes a login (ADR 0035).
    const found = findLayoutRecipe(stored, layout);
    return found && runsLogin(found) ? found : undefined;
  }
  /** Steps and targets each once, in order. */
  const once = <T>(items: readonly T[]) => {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = JSON.stringify(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  return {
    async fence(recipe) {
      // Take all epochs before the first awaited lookup. In-flight writes are refused,
      // including one whose old durable copy could still be read during replacement.
      const { mutation: started, writing } = source.epoch();
      const stable = writing === 0;
      const paired = source.serviceFence();
      const device = source.deviceFence();
      if (!stable || !paired) return undefined;
      const cache = await source.current(false);
      if (!cache) return undefined;
      // A fence protects a projection's identity, including confirmation autofill.
      // Login resumption still uses the login-only helper below.
      const stored = projectedDocumentOf(cache, recipe.origin, recipe.id);
      const held =
        stored && recipe.layout !== undefined
          ? findLayoutRecipe(stored, recipe.layout)
          : resumedRecipe(cache, recipe.origin, recipe.id, recipe.layout);
      if (!held || JSON.stringify(held) !== JSON.stringify(recipe) || (cache.local && !device))
        return undefined;
      const unchanged = () => unaltered(started) && paired() && (!cache.local || device!());
      return unchanged() ? unchanged : undefined;
    },
    async recipe(origin: string, path: string, recipeId?: string, layout?: string) {
      const cache = await source.current(true);
      if (!cache) return undefined;
      // A resumed attempt asks for its own recipe and layout; the executor checks its
      // revision.
      if (recipeId !== undefined) return resumedRecipe(cache, origin, recipeId, layout);
      const selection = selectLoginRecipe(cache.recipes, origin, path);
      return selection.ok ? selection.recipe : undefined;
    },
    async withdrawn(origin: string, recipeId: string, layout?: string) {
      // A sync the lookup started may be revoking the recipe right now.
      await source.settled();
      const cache = await source.current(false);
      if (!cache) return false;
      // A chooser login (ADR 0028) resumes on its chooser by ID; a recipe may hold sign-in
      // layouts beside its list, under keys unique over both.
      const chooser = choosersOf(cache, origin).find((recipe) => recipe.id === recipeId);
      if (chooser && (layout === undefined || findChooserLayout(chooser, layout))) return false;
      const stored = projectedDocumentOf(cache, origin, recipeId);
      // Confirmation projections remain present even though they cannot resume a login.
      if (stored && layout !== undefined && findLayoutRecipe(stored, layout)) return false;
      return !resumedRecipe(cache, origin, recipeId, layout);
    },
    async layouts(origin: string, path: string) {
      const cache = await source.current(false);
      if (!cache) return [];
      const selection = selectLoginRecipe(cache.recipes, origin, path);
      return selection.ok ? selection.layouts : [];
    },
    async layoutsOf(origin: string, recipeId: string) {
      const cache = await source.current(false);
      if (!cache) return [];
      const stored = documentOf(cache, origin, recipeId);
      // A chooser login's markers are its branches' (ADR 0028); a recipe may hold both.
      const chooser = choosersOf(cache, origin).find((recipe) => recipe.id === recipeId);
      return [
        ...(stored ? recipeLayouts(stored) : []),
        ...(chooser ? chooserLayouts(chooser) : []).flatMap((projected) =>
          [projected.chooser.afterAccount, projected.chooser.afterOther].filter(
            (branch) => branch !== undefined,
          ),
        ),
      ];
    },
    async chooser(origin: string, path: string, recipeId?: string, layout?: string) {
      const cache = await source.current(true);
      if (!cache) return undefined;
      const stored =
        recipeId !== undefined
          ? choosersOf(cache, origin).find((recipe) => recipe.id === recipeId)
          : choosersOn(cache, origin, path);
      if (!stored) return undefined;
      if (layout !== undefined) return findChooserLayout(stored, layout);
      return newestLayout(chooserCandidates(stored))?.recipe;
    },
    async choosers(origin: string, path: string) {
      const cache = await source.current(false);
      if (!cache) return [];
      const stored = choosersOn(cache, origin, path);
      return stored ? chooserCandidates(stored) : [];
    },
    async ssoFence(recipe) {
      const { mutation: started, writing } = source.epoch();
      const paired = source.serviceFence();
      const device = source.deviceFence();
      if (writing !== 0 || !paired) return undefined;
      const cache = await source.current(false);
      if (!cache || (cache.local && !device)) return undefined;
      const held = cache.recipes.find(
        (entry) => entry.id === recipe.id && entry.origin === recipe.origin && isSsoDocument(entry),
      );
      const unchanged = () => unaltered(started) && paired() && (!cache.local || device!());
      return held && JSON.stringify(held) === JSON.stringify(recipe) && unchanged()
        ? unchanged
        : undefined;
    },
    async sso(origin: string, path: string, recipeId?: string) {
      const cache = await source.current(false);
      return (cache?.recipes ?? [])
        .filter(isSsoDocument)
        .filter(
          (recipe) =>
            recipe.origin === origin &&
            (recipeId ? recipe.id === recipeId : recipe.sso.path === path),
        );
    },
    async starts(origin: string) {
      const cache = await source.current(false);
      if (!cache) return [];
      // Every variant starts on the recipe's start path (ADR 0027), in every layout (ADR
      // 0060): a recipe is one start with every layout's first steps. A chooser recipe (ADR
      // 0028) starts where its list shows, once one of its buttons or a listed account
      // does, or its `other` branch's first step on that path, as when the person pressed
      // the button for another account; an entry recipe (ADR 0031) is left out: the runtime
      // counts its path as a start for generation through `entries` instead.
      // A recipe that holds a sign-in form and a list (ADR 0028) is one start: the page
      // shows either on the same path.
      const forms = loginRecipesForOrigin(cache.recipes, origin);
      const lists = choosersOf(cache, origin);
      const ids = [...new Set([...forms, ...lists].map((stored) => stored.id))];
      return ids.map((id): LoginRecipeStart => {
        const form = forms.find((stored) => stored.id === id);
        const list = lists.find((stored) => stored.id === id);
        // A layout generated as `confirm` or `unclear` never starts (ADR 0035).
        const layouts = form
          ? loginLayoutCandidates(form).map((candidate) => candidate.recipe)
          : [];
        const choosers = list ? chooserLayouts(list) : [];
        // A later step a login may start at when no first step shows (ADR 0049).
        const later = once(
          layouts.flatMap((recipe) => laterStartSteps(recipe).map(laterReadiness)),
        );
        const buttons = once(
          choosers.flatMap((recipe): LoginTarget[] =>
            [recipe.chooser.other, recipe.chooser.continue].filter(
              (target) => target !== undefined,
            ),
          ),
        );
        return {
          path: form ? form.layouts[0]!.steps[0]!.path : list!.chooser.path,
          steps: once([
            ...layouts.flatMap(recipeStartSteps),
            ...choosers.flatMap(
              (recipe): LoginStep[] =>
                recipe.chooser.afterOther?.steps
                  .slice(0, 1)
                  // Only a step that waits for an element: one that needs none would
                  // show on the list as well.
                  .filter(
                    (step) =>
                      step.path === recipe.chooser.path && loginReadiness(step).targets.length > 0,
                  ) ?? [],
            ),
          ]),
          ...(list ? { list: buttons } : {}),
          ...(later.length ? { later } : {}),
        };
      });
    },
    async later(origin: string, path: string) {
      const cache = await source.current(false);
      if (!cache) return [];
      // A chooser's branches are never started in the middle: which one runs depends on the
      // click on its list, which the page alone does not tell (ADR 0049). Each layout with
      // such a step is a candidate; the runtime chooses among one recipe's (ADR 0060).
      return loginRecipesForOrigin(cache.recipes, origin)
        .flatMap((stored) => loginLayoutCandidates(stored).map((candidate) => candidate.recipe))
        .filter((recipe) => laterStartSteps(recipe).some(({ step }) => step.path === path));
    },
    async routes(origin: string) {
      const cache = await source.current(false);
      if (!cache) return [];
      // Every layout of each login recipe whatever its kind, and every chooser layout's
      // branches (ADR 0060).
      return cache.recipes.flatMap((recipe) =>
        recipe.origin !== origin
          ? []
          : [
              ...(isLoginRecipeDocument(recipe) ? recipeLayouts(recipe) : []),
              ...(isChooserDocument(recipe)
                ? chooserLayouts(recipe).flatMap((projected) =>
                    [projected.chooser.afterAccount, projected.chooser.afterOther].filter(
                      (branch) => branch !== undefined,
                    ),
                  )
                : []),
            ],
      );
    },
    async entries(origin: string) {
      const cache = await source.current(false);
      if (!cache) return [];
      return cache.recipes.filter(
        (recipe): recipe is LoginEntryRecipe => "entry" in recipe && recipe.origin === origin,
      );
    },
    async logouts(origin: string) {
      const cache = await source.paired();
      if (!cache) return [];
      return cache.recipes.filter(
        (recipe): recipe is LoginLogoutRecipe => "logout" in recipe && recipe.origin === origin,
      );
    },
  };
}
