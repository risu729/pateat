import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  isChooserDocument,
  isLoginRecipeDocument,
  loginChooserDocumentSchema,
  loginRecipeDocumentSchema,
  recipeDocumentSchema,
  storedBranchRoute,
  storedLayoutRecipe,
  storedLayouts,
  storedLoginRecipeSchema,
  storedRecipeSlots,
  storedRecipeStartPath,
  storedRecipeStartPaths,
  startPathFor,
  MAX_RECIPE_START_PATHS,
  withoutLayout,
  type RecipeDocument,
} from "./index";

// The same URL shows a sign-in form or a list of accounts by the state of the browser's
// session, so one stored recipe holds layouts of either or both (ADR 0028, #1248).
describe("a recipe document with a sign-in form and a list of accounts", () => {
  const origin = "https://login.example";
  const form = {
    key: "1000",
    createdAt: 1000,
    pageKind: "sign-in" as const,
    slots: ["username", "password"],
    steps: [
      {
        kind: "fill" as const,
        path: "/signin",
        effect: "prepare" as const,
        fields: [
          { slot: "username", target: { by: "id" as const, value: "email" } },
          { slot: "password", target: { by: "id" as const, value: "password" } },
        ],
      },
      {
        kind: "click" as const,
        path: "/signin",
        target: { by: "id" as const, value: "login" },
        purpose: "submit" as const,
      },
    ],
    maxSubmissions: 1,
  };
  const list = { key: "2000", createdAt: 2000, continue: { by: "text" as const, value: "Verify" } };
  const both = (): RecipeDocument => ({
    version: 1,
    id: "gen-both",
    revision: 3,
    origin,
    layouts: [form],
    chooser: { path: "/signin", layouts: [list] },
  });

  it("stores both kinds on the recipe's one start path", () => {
    const parsed = v.parse(storedLoginRecipeSchema, both());
    expect(parsed).toEqual(both());
    expect(isLoginRecipeDocument(parsed)).toBe(true);
    expect(isChooserDocument(parsed)).toBe(true);
    expect(v.is(loginRecipeDocumentSchema, both())).toBe(true);
    expect(v.is(loginChooserDocumentSchema, both())).toBe(true);
    expect(storedRecipeStartPath(parsed)).toBe("/signin");
    expect(storedLayouts(parsed).map((layout) => layout.key)).toEqual(["1000", "2000"]);
    expect(storedRecipeSlots(parsed)).toEqual(["username", "password"]);
    // Either kind alone is a recipe too, and each schema asks for its own kind.
    const { chooser: _chooser, ...formOnly } = both();
    const { layouts: _layouts, ...listOnly } = both();
    expect(v.is(loginRecipeDocumentSchema, formOnly)).toBe(true);
    expect(v.is(loginChooserDocumentSchema, formOnly)).toBe(false);
    expect(v.is(loginRecipeDocumentSchema, listOnly)).toBe(false);
    expect(v.is(loginChooserDocumentSchema, listOnly)).toBe(true);
  });

  it("refuses a recipe of neither kind, a list on another path and a key both kinds hold", () => {
    const { layouts: _layouts, chooser: _chooser, ...neither } = both();
    expect(
      v.safeParse(recipeDocumentSchema, neither).issues?.map((issue) => issue.message),
    ).toContain("A recipe holds a sign-in form or a list of accounts");
    expect(
      v
        .safeParse(recipeDocumentSchema, {
          ...both(),
          chooser: { path: "/accounts", layouts: [list] },
        })
        .issues?.map((issue) => issue.message),
    ).toContain("The list of accounts shows on the recipe's start path");
    expect(
      v
        .safeParse(recipeDocumentSchema, {
          ...both(),
          chooser: { path: "/signin", layouts: [{ ...list, key: "1000" }] },
        })
        .issues?.map((issue) => issue.message),
    ).toContain("Duplicate layout keys");
  });

  it("runs each layout by its key, and the newest of a kind without one", () => {
    const parsed = v.parse(storedLoginRecipeSchema, both());
    expect(storedLayoutRecipe(parsed, "1000")).toMatchObject({ layout: "1000", steps: form.steps });
    expect(storedLayoutRecipe(parsed, "2000")).toMatchObject({
      layout: "2000",
      chooser: { path: "/signin", continue: list.continue },
    });
    expect(storedLayoutRecipe(parsed)).toMatchObject({ layout: "2000" });
    expect(storedLayoutRecipe(parsed, undefined, "form")).toMatchObject({ layout: "1000" });
    expect(storedLayoutRecipe(parsed, undefined, "list")).toMatchObject({ layout: "2000" });
    expect(storedLayoutRecipe(parsed, "2000", "form")).toBeUndefined();
    expect(storedBranchRoute(parsed, "1000")?.route).toMatchObject({ layout: "1000" });
    expect(storedBranchRoute(parsed, "2000:account")).toMatchObject({
      route: undefined,
      chooser: { layout: "2000" },
    });
    expect(storedBranchRoute(parsed, "2000")).toBeUndefined();
    expect(storedBranchRoute(parsed, "1000:account")).toBeUndefined();
  });

  it("keeps the other kind when a kind's last layout is removed", () => {
    const parsed = v.parse(storedLoginRecipeSchema, both());
    const { chooser: _chooser, ...formOnly } = both();
    const { layouts: _layouts, ...listOnly } = both();
    expect(withoutLayout(parsed, "2000")).toEqual({ ...formOnly, revision: 4 });
    expect(withoutLayout(parsed, "1000")).toEqual({ ...listOnly, revision: 4 });
    expect(withoutLayout(parsed, "3000")).toBeUndefined();
    expect(withoutLayout(v.parse(storedLoginRecipeSchema, listOnly), "2000")).toBeUndefined();
  });
});

// A site may show its sign-in form on whatever page it guards: a recipe document starts on
// up to seven more paths where its form showed (ADR 0060 amendment of 2026-11-18).
describe("a recipe document's other start paths", () => {
  const document = (starts?: unknown): unknown => ({
    version: 1,
    id: "gen-starts",
    revision: 2,
    origin: "https://login.example",
    layouts: [
      {
        key: "1000",
        createdAt: 1000,
        pageKind: "sign-in",
        slots: ["password"],
        steps: [
          {
            kind: "fill",
            path: "/signin",
            effect: "prepare",
            fields: [{ slot: "password", target: { by: "id", value: "password" } }],
          },
          { kind: "click", path: "/signin", target: { by: "id", value: "go" }, purpose: "submit" },
        ],
        maxSubmissions: 1,
      },
    ],
    ...(starts === undefined ? {} : { starts }),
  });
  const issues = (value: unknown) =>
    v.safeParse(recipeDocumentSchema, value).issues?.map((issue) => issue.message) ?? [];

  it("reads a document without them as starting on its start path alone", () => {
    const parsed = v.parse(storedLoginRecipeSchema, document());
    expect(storedRecipeStartPaths(parsed)).toEqual(["/signin"]);
    expect(startPathFor(parsed, "/home")).toBe("/home");
  });

  it("reads a page on one of them as one on the start path", () => {
    const parsed = v.parse(storedLoginRecipeSchema, document(["/home", "/account"]));
    expect(storedRecipeStartPaths(parsed)).toEqual(["/signin", "/home", "/account"]);
    expect(startPathFor(parsed, "/account")).toBe("/signin");
    expect(startPathFor(parsed, "/signin")).toBe("/signin");
    expect(startPathFor(parsed, "/other")).toBe("/other");
  });

  it("holds at most seven, each once, none of them the start path", () => {
    const seven = Array.from({ length: MAX_RECIPE_START_PATHS - 1 }, (_, index) => `/p${index}`);
    expect(issues(document(seven))).toEqual([]);
    expect(issues(document([...seven, "/p7"]))).not.toEqual([]);
    expect(issues(document([]))).not.toEqual([]);
    expect(issues(document(["/home", "/home"]))).toContain("Duplicate start paths");
    expect(issues(document(["/signin"]))).toContain("Other start paths differ from the start path");
    expect(issues(document(["home"]))).not.toEqual([]);
  });
});
