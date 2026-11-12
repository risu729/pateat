import { expect, it } from "vitest";
import * as v from "valibot";
import {
  parseLoginRecipe,
  routeBodyOf,
  storedLoginRecipeSchema,
  toLoginLayout,
  type LoginRecipeDocument,
  type StoredLoginRecipe,
} from "../../src/login";
import {
  languageDecides,
  layoutFirstSteps,
  layoutShown,
  layoutStartTargets,
  loginLayoutCandidates,
  loginRecipesForOrigin,
  rankLayouts,
  selectLoginRecipe,
} from "../../src/recipes";
import type { RecipeSelectionContext } from "./context";

export function registerRecipeSelection({
  origin,
  target,
  recipe,
  stored,
}: RecipeSelectionContext) {
  const recipes = [
    stored(recipe("bank-signin", "/login")),
    stored(recipe("bank-admin", "/admin")),
    stored(recipe("other-signin", "/login", 1, "https://other.example")),
  ];

  it("starts only on a recipe's first step", () => {
    expect(selectLoginRecipe(recipes, origin, "/login")).toMatchObject({
      ok: true,
      recipe: { id: "bank-signin", layout: "1000" },
      layouts: [{ recipe: { id: "bank-signin", layout: "1000" }, createdAt: 1000 }],
      stepIndex: 0,
    });
    expect(selectLoginRecipe(recipes, origin, "/password")).toEqual({
      ok: false,
      reason: "recipe-not-found",
    });
    expect(selectLoginRecipe(recipes, "https://third.example", "/login")).toEqual({
      ok: false,
      reason: "recipe-not-found",
    });
  });

  it("refuses when two recipes start on the same page", () => {
    expect(
      selectLoginRecipe([...recipes, stored(recipe("bank-business", "/login"))], origin, "/login"),
    ).toEqual({ ok: false, reason: "recipe-ambiguous" });
    expect(
      selectLoginRecipe([...recipes, stored(recipe("bank-signin", "/login", 2))], origin, "/login"),
    ).toEqual({ ok: false, reason: "recipe-ambiguous" });
  });

  it("offers every layout of one recipe, the newest first by default (ADR 0060)", () => {
    const layered = stored(recipe("bank-signin", "/login"), 3000, 1000, 2000);
    const selected = selectLoginRecipe([layered], origin, "/login");
    expect(selected).toMatchObject({ ok: true, recipe: { layout: "3000" } });
    expect(selected.ok && selected.layouts.map((candidate) => candidate.recipe.layout)).toEqual([
      "3000",
      "1000",
      "2000",
    ]);
    // Layouts of one recipe never make its start ambiguous.
    expect(loginRecipesForOrigin([layered], origin)).toHaveLength(1);
  });

  it("counts the elements of every route's steps on the start path, each once", () => {
    const route = recipe("bank-signin", "/login");
    expect(layoutStartTargets(route)).toEqual([target("user")]);
    const single = parseLoginRecipe({
      ...route,
      steps: [
        { kind: "fill", path: "/login", fields: [{ slot: "username", target: target("user") }] },
        { kind: "wait", path: "/login", target: target("spinner"), present: false, timeoutMs: 100 },
        { kind: "fill", path: "/login", fields: [{ slot: "password", target: target("pass") }] },
        { kind: "click", path: "/login", target: target("login"), purpose: "submit" },
      ],
      passkey: { path: "/login", target: target("passkey") },
      alternatives: [
        {
          slots: ["email", "password"],
          steps: [
            {
              kind: "fill",
              path: "/login",
              fields: [
                { slot: "email", target: target("email") },
                { slot: "password", target: target("pass") },
              ],
            },
            { kind: "click", path: "/login", target: target("go"), purpose: "submit" },
          ],
        },
      ],
    });
    expect(layoutStartTargets(single)).toEqual(
      ["passkey", "user", "pass", "login", "email", "go"].map(target),
    );
  });

  it("ranks layouts by a first step shown whole, missing and shown elements, language, age", () => {
    const route = recipe("bank-signin", "/login");
    const candidates = loginLayoutCandidates({
      ...stored(route, 1000, 2000, 3000),
      layouts: [
        { ...toLoginLayout(route, { key: "1000", language: "ja", createdAt: 1000 }) },
        { ...toLoginLayout(route, { key: "2000", language: "en", createdAt: 2000 }) },
        { ...toLoginLayout(route, { key: "3000", createdAt: 3000 }) },
      ],
    });
    expect(candidates.map((candidate) => candidate.language)).toEqual(["ja", "en", undefined]);
    const shows = (starts: boolean, shown: number, missing = 0) => ({ starts, shown, missing });
    const order = (shown: ReturnType<typeof shows>[], language?: "ja" | "en" | "mixed") =>
      rankLayouts(candidates, shown, language).map((candidate) => candidate.recipe.layout);
    // A layout one of whose first steps shows whole goes first, whatever the counts.
    expect(order([shows(false, 4, 1), shows(true, 2, 1), shows(false, 1)])).toEqual(["2000"]);
    // Then the fewest missing start elements, however many more another shows.
    expect(order([shows(true, 4, 1), shows(true, 3), shows(true, 3)])).toEqual(["3000", "2000"]);
    // Then the most shown; the rest drop out.
    expect(order([shows(true, 2), shows(true, 1), shows(true, 1)])).toEqual(["1000"]);
    // On a tie, the page's language first, then the newest.
    const tie = [shows(true, 1), shows(true, 1), shows(true, 1)];
    expect(order(tie, "ja")).toEqual(["1000", "3000", "2000"]);
    expect(order(tie, "en")).toEqual(["2000", "3000", "1000"]);
    expect(order(tie, "mixed")).toEqual(["3000", "2000", "1000"]);
    expect(order([shows(false, 0), shows(false, 0), shows(false, 0)])).toEqual([
      "3000",
      "2000",
      "1000",
    ]);
    // The language is read only when the best ones differ in it.
    expect(languageDecides(rankLayouts(candidates, tie))).toBe(true);
    expect(languageDecides(rankLayouts(candidates, [shows(true, 2), ...tie.slice(1)]))).toBe(false);
  });

  it("measures a layout against what the page shows", () => {
    const route = parseLoginRecipe({
      ...recipe("bank-signin", "/login"),
      steps: [
        { kind: "fill", path: "/login", fields: [{ slot: "username", target: target("user") }] },
        { kind: "click", path: "/login", target: target("login"), purpose: "submit" },
      ],
      passkey: { path: "/login", target: target("passkey") },
    });
    expect(layoutFirstSteps(route)).toEqual([[target("passkey")], [target("user")]]);
    const page =
      (shown: string[], asked = ["passkey", "user", "login"]) =>
      (asking: { value: string }) =>
        asked.includes(asking.value) ? shown.includes(asking.value) : undefined;
    const measure = (shown: string[], asked?: string[]) =>
      layoutShown(layoutFirstSteps(route), layoutStartTargets(route), page(shown, asked));
    expect(measure(["user", "login"])).toEqual({ starts: true, shown: 2, missing: 1 });
    expect(measure(["login"])).toEqual({ starts: false, shown: 1, missing: 2 });
    // An element the page was not asked about counts as neither.
    expect(measure(["user"], ["user"])).toEqual({ starts: true, shown: 1, missing: 0 });
    // A first step that waits for an element to go shows no start.
    expect(layoutShown([[]], [], () => true)).toEqual({ starts: false, shown: 0, missing: 0 });
  });

  it("never lists or starts a recipe generated as confirm or unclear (ADR 0035)", () => {
    const confirm = stored({ ...recipe("bank-transfer", "/transfer"), pageKind: "confirm" });
    const unclear = stored({ ...recipe("bank-secret", "/secret"), pageKind: "unclear" });
    const all = [...recipes, confirm, unclear];
    expect(loginRecipesForOrigin(all, origin).map(({ id }) => id)).toEqual([
      "bank-signin",
      "bank-admin",
    ]);
    expect(selectLoginRecipe(all, origin, "/transfer")).toEqual({
      ok: false,
      reason: "recipe-not-found",
    });
  });

  it("keeps one page kind for every layout of a recipe (ADR 0035, ADR 0060)", () => {
    const route = recipe("bank-signin", "/login");
    const mixed: LoginRecipeDocument = {
      ...stored(route, 1000),
      layouts: [
        toLoginLayout(route, { key: "1000", createdAt: 1000 }),
        toLoginLayout({ ...route, pageKind: "confirm" }, { key: "2000", createdAt: 2000 }),
      ],
    };
    // A document mixing kinds is never stored or synced, so a recipe runs, or not, whole.
    expect(v.is(storedLoginRecipeSchema, mixed)).toBe(false);
    const confirm: LoginRecipeDocument = {
      ...mixed,
      layouts: mixed.layouts.map((layout) => ({ ...layout, pageKind: "confirm" as const })),
    };
    expect(v.is(storedLoginRecipeSchema, confirm)).toBe(true);
    expect(loginLayoutCandidates(confirm)).toEqual([]);
    expect(selectLoginRecipe([confirm], origin, "/login")).toEqual({
      ok: false,
      reason: "recipe-not-found",
    });
  });

  it("never lists or starts an entry recipe (ADR 0031)", () => {
    const entry: StoredLoginRecipe = {
      version: 1,
      id: "bank-entry",
      revision: 1,
      origin,
      entry: { path: "/login", target: { by: "text", value: "Login" } },
    };
    expect(loginRecipesForOrigin([entry, ...recipes], origin).map(({ id }) => id)).toEqual([
      "bank-signin",
      "bank-admin",
    ]);
    // It shares the start path with a login recipe without making the start ambiguous.
    expect(selectLoginRecipe([entry, ...recipes], origin, "/login")).toMatchObject({
      ok: true,
      recipe: { id: "bank-signin" },
    });
    expect(selectLoginRecipe([entry], origin, "/login")).toEqual({
      ok: false,
      reason: "recipe-not-found",
    });
  });

  it("never lists or starts a chooser recipe or its branch (ADR 0028)", () => {
    const signin = recipe("bank-signin", "/login");
    const chooser: StoredLoginRecipe = {
      version: 1,
      id: "bank-chooser",
      revision: 1,
      origin,
      chooser: {
        path: "/login",
        layouts: [{ key: "1000", createdAt: 1000, afterAccount: routeBodyOf(signin) }],
      },
    };
    expect(loginRecipesForOrigin([chooser, ...recipes], origin).map(({ id }) => id)).toEqual([
      "bank-signin",
      "bank-admin",
    ]);
    expect(selectLoginRecipe([chooser], origin, "/login")).toEqual({
      ok: false,
      reason: "recipe-not-found",
    });
  });
}
