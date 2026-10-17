import {
  loginRecipesForOrigin,
  recipeStartSteps,
  selectLoginRecipe,
  type LoginChooserRecipe,
  type LoginEntryRecipe,
  type LoginRecipe,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import type { LoginRecipes } from "../login/runtime";
import { loginReadiness } from "../login/wire";

/**
 * The executor's lookups over one list of stored recipes: the synced cache of a paired
 * device, or the recipes kept on a device without a service (ADR 0040). `read` answers
 * the list in use, or undefined when none may be served. `starting` is true for the
 * lookups that start or resume a login, which may start a background sync.
 */
export function recipeLookups(
  read: (starting: boolean) => Promise<readonly StoredLoginRecipe[] | undefined>,
): LoginRecipes {
  return {
    async recipe(origin: string, path: string, recipeId?: string) {
      const recipes = await read(true);
      if (!recipes) return undefined;
      // A resumed attempt asks for its own recipe; the executor checks its revision.
      if (recipeId !== undefined)
        return loginRecipesForOrigin(recipes, origin).find(
          (recipe): recipe is LoginRecipe => recipe.id === recipeId,
        );
      const selection = selectLoginRecipe(recipes, origin, path);
      return selection.ok ? selection.recipe : undefined;
    },
    async chooser(origin: string, path: string, recipeId?: string) {
      const recipes = await read(true);
      if (!recipes) return undefined;
      const choosers = recipes.filter(
        (recipe): recipe is LoginChooserRecipe => "chooser" in recipe && recipe.origin === origin,
      );
      if (recipeId !== undefined) return choosers.find((recipe) => recipe.id === recipeId);
      // The service keeps one generated recipe per origin and start path; a path where
      // several start, or where a login recipe starts as well, starts none (ADR 0013).
      const here = choosers.filter((recipe) => recipe.chooser.path === path);
      return here.length === 1 &&
        !loginRecipesForOrigin(recipes, origin).some((recipe) => recipe.steps[0]!.path === path)
        ? here[0]
        : undefined;
    },
    async starts(origin: string) {
      const recipes = await read(false);
      if (!recipes) return [];
      // Every variant starts on the recipe's start path (ADR 0027). A chooser recipe (ADR
      // 0028) starts where its list shows, once one of its buttons or a listed account
      // does, or its `other` branch's first step on that path, as when the person pressed
      // the button for another account; an entry recipe (ADR 0031) is left out: the runtime
      // counts its path as a start for generation through `entries` instead.
      return [
        ...loginRecipesForOrigin(recipes, origin).map((recipe) => ({
          path: recipe.steps[0]!.path,
          steps: recipeStartSteps(recipe),
        })),
        ...recipes.flatMap((recipe) =>
          "chooser" in recipe && recipe.origin === origin
            ? [
                {
                  path: recipe.chooser.path,
                  steps:
                    recipe.chooser.afterOther?.steps
                      .slice(0, 1)
                      // Only a step that waits for an element: one that needs none would
                      // show on the list as well.
                      .filter(
                        (step) =>
                          step.path === recipe.chooser.path &&
                          loginReadiness(step).targets.length > 0,
                      ) ?? [],
                  list: [recipe.chooser.other, recipe.chooser.continue].filter(
                    (target) => target !== undefined,
                  ),
                },
              ]
            : [],
        ),
      ];
    },
    async entries(origin: string) {
      const recipes = await read(false);
      if (!recipes) return [];
      return recipes.filter(
        (recipe): recipe is LoginEntryRecipe => "entry" in recipe && recipe.origin === origin,
      );
    },
  };
}
