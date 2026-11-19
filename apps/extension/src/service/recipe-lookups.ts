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
  projectionOn,
  projectionStartPath,
  recipeLayouts,
  recipeStartSteps,
  runsLogin,
  selectLoginRecipe,
  startsOnPath,
  storedRecipeStartPaths,
  type LayoutCandidate,
  type LoginChooserDocument,
  type LoginChooserRecipe,
  type LoginEntryRecipe,
  type LoginLogoutRecipe,
  type LoginRecipe,
  type LoginRecipeDocument,
  type LoginStep,
  type LoginTarget,
  type SsoRecipeDocument,
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
    const here = choosersOf(cache, origin).filter((recipe) => startsOnPath(recipe, path));
    return here.length === 1 &&
      !loginRecipesForOrigin(cache.recipes, origin).some(
        (recipe) => recipe.id !== here[0]!.id && startsOnPath(recipe, path),
      )
      ? here[0]
      : undefined;
  }
  /** Each layout of a chooser as a candidate, its list on `path` (ADR 0060 amendment). */
  const chooserCandidates = (recipe: LoginChooserDocument, path: string) =>
    chooserLayouts(recipe).map((projected, index): LayoutCandidate<LoginChooserRecipe> => ({
      recipe: projectionOn(projected, path),
      ...(recipe.chooser.layouts[index]!.language
        ? { language: recipe.chooser.layouts[index]!.language }
        : {}),
      createdAt: recipe.chooser.layouts[index]!.createdAt,
    }));
  /** Whether `path` is one of a stored recipe's other start paths (`starts`). */
  const otherStart = (stored: StoredLoginRecipe, path: string) =>
    storedRecipeStartPaths(stored).slice(1).includes(path);
  /**
   * A login's projection of `stored` on `start`, the other start path of the recipe it
   * started on (`starts`, ADR 0060 amendment of 2026-11-18), or as it is without one; none
   * when the recipe no longer starts there, since the login's steps cannot be told then.
   */
  function startedOn<Recipe extends LoginRecipe | LoginChooserRecipe>(
    stored: StoredLoginRecipe,
    projected: Recipe | undefined,
    start: string | undefined,
  ): Recipe | undefined {
    if (!projected || start === undefined) return projected;
    return otherStart(stored, start) ? projectionOn(projected, start) : undefined;
  }
  /**
   * The other start path a projection's own start path is of the stored recipe, if it is
   * one: a projection on it is compared with the stored layouts moved there.
   */
  const aliasOf = (stored: StoredLoginRecipe, recipe: LoginRecipe | LoginChooserRecipe) => {
    const path = projectionStartPath(recipe);
    return otherStart(stored, path) ? path : undefined;
  };
  /**
   * A resumed attempt's own recipe and layout, or else the newest layout, on the other
   * start path it started on, if any.
   */
  function resumedRecipe(
    cache: Held,
    origin: string,
    recipeId: string,
    layout?: string,
    start?: string,
  ) {
    const stored = documentOf(cache, origin, recipeId);
    if (!stored) return undefined;
    if (layout === undefined)
      return startedOn(stored, newestLayout(loginLayoutCandidates(stored))?.recipe, start);
    // A layout generated as `confirm` or `unclear` never resumes a login (ADR 0035).
    const found = findLayoutRecipe(stored, layout);
    return found && runsLogin(found) ? startedOn(stored, found, start) : undefined;
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

  /**
   * Where a recipe starts on `path`, one of its start paths: with every layout's first
   * steps, its list's buttons and its later steps, its projections moved to that path.
   */
  function startOn(
    form: LoginRecipeDocument | undefined,
    list: LoginChooserDocument | undefined,
    path: string,
  ): LoginRecipeStart {
    // A layout generated as `confirm` or `unclear` never starts (ADR 0035).
    const layouts = form
      ? loginLayoutCandidates(form).map((candidate) => projectionOn(candidate.recipe, path))
      : [];
    const choosers = list ? chooserLayouts(list).map((chooser) => projectionOn(chooser, path)) : [];
    // A later step a login may start at when no first step shows (ADR 0049).
    const later = once(layouts.flatMap((recipe) => laterStartSteps(recipe).map(laterReadiness)));
    const buttons = once(
      choosers.flatMap((recipe): LoginTarget[] =>
        [recipe.chooser.other, recipe.chooser.continue].filter((target) => target !== undefined),
      ),
    );
    return {
      path,
      steps: once([
        ...layouts.flatMap(recipeStartSteps),
        ...choosers.flatMap(
          (recipe): LoginStep[] =>
            recipe.chooser.afterOther?.steps
              .slice(0, 1)
              // Only a step that waits for an element: one that needs none would show on
              // the list as well.
              .filter(
                (step) =>
                  step.path === recipe.chooser.path && loginReadiness(step).targets.length > 0,
              ) ?? [],
        ),
      ]),
      ...(list ? { list: buttons } : {}),
      ...(later.length ? { later } : {}),
    };
  }
  /**
   * An SSO document on `path` when that is one of its other start paths (ADR 0060
   * amendment of 2026-11-18): its entries show there, so its `sso.path` is that path. Its
   * other members, which the SSO flow does not read, stay as stored.
   */
  const ssoOn = (recipe: SsoRecipeDocument, path: string): SsoRecipeDocument =>
    recipe.sso.path !== path && otherStart(recipe, path)
      ? { ...recipe, sso: { ...recipe.sso, path } }
      : recipe;

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
      // A projection on another start path of its recipe is compared on that path.
      const stored = projectedDocumentOf(cache, recipe.origin, recipe.id);
      const start = stored && aliasOf(stored, recipe);
      const held =
        stored && recipe.layout !== undefined
          ? startedOn(stored, findLayoutRecipe(stored, recipe.layout), start)
          : resumedRecipe(cache, recipe.origin, recipe.id, recipe.layout, start);
      if (!held || JSON.stringify(held) !== JSON.stringify(recipe) || (cache.local && !device))
        return undefined;
      const unchanged = () => unaltered(started) && paired() && (!cache.local || device!());
      return unchanged() ? unchanged : undefined;
    },
    async recipe(origin: string, path: string, recipeId?: string, layout?: string, start?: string) {
      const cache = await source.current(true);
      if (!cache) return undefined;
      // A resumed attempt asks for its own recipe and layout, on the other start path it
      // started on if any; the executor checks its revision. A new login takes the recipe
      // that starts on the path, on any of its start paths (`selectLoginRecipe`).
      if (recipeId !== undefined) return resumedRecipe(cache, origin, recipeId, layout, start);
      const selection = selectLoginRecipe(cache.recipes, origin, path);
      return selection.ok ? selection.recipe : undefined;
    },
    async startAlias(origin: string, recipeId: string, path: string) {
      const cache = await source.current(false);
      const stored = cache?.recipes.find(
        (recipe) => recipe.origin === origin && recipe.id === recipeId,
      );
      return stored !== undefined && otherStart(stored, path);
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
    async layoutsOf(origin: string, recipeId: string, start?: string) {
      const cache = await source.current(false);
      if (!cache) return [];
      const stored = documentOf(cache, origin, recipeId);
      // A chooser login's markers are its branches' (ADR 0028); a recipe may hold both.
      const chooser = choosersOf(cache, origin).find((recipe) => recipe.id === recipeId);
      // On the other start path a login started on, if the recipe still starts there.
      const on = <Recipe extends LoginRecipe | LoginChooserRecipe>(
        document: StoredLoginRecipe,
        projected: Recipe,
      ) => startedOn(document, projected, start) ?? projected;
      return [
        ...(stored ? recipeLayouts(stored).map((projected) => on(stored, projected)) : []),
        ...(chooser ? chooserLayouts(chooser) : [])
          .map((projected) => on(chooser!, projected))
          .flatMap((projected) =>
            [projected.chooser.afterAccount, projected.chooser.afterOther].filter(
              (branch) => branch !== undefined,
            ),
          ),
      ];
    },
    async chooser(
      origin: string,
      path: string,
      recipeId?: string,
      layout?: string,
      start?: string,
    ) {
      const cache = await source.current(true);
      if (!cache) return undefined;
      if (recipeId !== undefined) {
        // A chooser login's own list, on the other start path it started on, if any.
        const own = choosersOf(cache, origin).find((recipe) => recipe.id === recipeId);
        if (!own) return undefined;
        const chosen =
          layout !== undefined
            ? findChooserLayout(own, layout)
            : newestLayout(chooserCandidates(own, own.chooser.path))?.recipe;
        return startedOn(own, chosen, start);
      }
      const stored = choosersOn(cache, origin, path);
      if (!stored) return undefined;
      if (layout !== undefined) {
        const found = findChooserLayout(stored, layout);
        return found && projectionOn(found, path);
      }
      return newestLayout(chooserCandidates(stored, path))?.recipe;
    },
    async choosers(origin: string, path: string) {
      const cache = await source.current(false);
      if (!cache) return [];
      const stored = choosersOn(cache, origin, path);
      return stored ? chooserCandidates(stored, path) : [];
    },
    async ssoFence(recipe) {
      const { mutation: started, writing } = source.epoch();
      const paired = source.serviceFence();
      const device = source.deviceFence();
      if (writing !== 0 || !paired) return undefined;
      const cache = await source.current(false);
      if (!cache || (cache.local && !device)) return undefined;
      const found = cache.recipes.find(
        (entry) => entry.id === recipe.id && entry.origin === recipe.origin && isSsoDocument(entry),
      );
      // An SSO document on another start path of its recipe is compared on that path.
      const held = found && isSsoDocument(found) ? ssoOn(found, recipe.sso.path) : undefined;
      const unchanged = () => unaltered(started) && paired() && (!cache.local || device!());
      return held && JSON.stringify(held) === JSON.stringify(recipe) && unchanged()
        ? unchanged
        : undefined;
    },
    async sso(origin: string, path: string, recipeId?: string) {
      const cache = await source.current(false);
      // A recipe's SSO entries show on each path it starts on (ADR 0060 amendment of
      // 2026-11-18), and on such a path its document's `sso.path` is that path.
      return (cache?.recipes ?? [])
        .filter(isSsoDocument)
        .filter(
          (recipe) =>
            recipe.origin === origin &&
            (recipeId ? recipe.id === recipeId : startsOnPath(recipe, path)),
        )
        .map((recipe) => ssoOn(recipe, path));
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
      // A recipe starts on its start path and on each of its other start paths (`starts`,
      // ADR 0060 amendment of 2026-11-18), each a start of its own with the projections on
      // that path; a path two recipes start on counts both, so it starts none (ADR 0013).
      const forms = loginRecipesForOrigin(cache.recipes, origin);
      const lists = choosersOf(cache, origin);
      const ids = [...new Set([...forms, ...lists].map((stored) => stored.id))];
      return ids.flatMap((id) => {
        const form = forms.find((stored) => stored.id === id);
        const list = lists.find((stored) => stored.id === id);
        return storedRecipeStartPaths((form ?? list)!).map((path) => startOn(form, list, path));
      });
    },
    async later(origin: string, path: string) {
      const cache = await source.current(false);
      if (!cache) return [];
      // A chooser's branches are never started in the middle: which one runs depends on the
      // click on its list, which the page alone does not tell (ADR 0049). Each layout with
      // such a step is a candidate; the runtime chooses among one recipe's (ADR 0060). On
      // another start path of its recipe, a layout's steps on its start path are there.
      return loginRecipesForOrigin(cache.recipes, origin)
        .flatMap((stored) =>
          loginLayoutCandidates(stored).map((candidate) =>
            startsOnPath(stored, path) ? projectionOn(candidate.recipe, path) : candidate.recipe,
          ),
        )
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
