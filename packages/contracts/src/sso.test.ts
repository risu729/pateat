import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  generationRequestSchema,
  isSsoDocument,
  isLoginRecipeDocument,
  isChooserDocument,
  MAX_RECIPE_LAYOUTS,
  MAX_SSO_LABELS,
  mergeSsoEntries,
  ssoBesideNative,
  ssoCovers,
  ssoGenerationRequestSchema,
  storedBranchRoute,
  storedLayoutRecipe,
  storedLayouts,
  storedLoginRecipeSchema,
  storedRecipeSlots,
  storedRecipeStartPath,
  withSsoEntries,
  withoutLayout,
  type RecipeDocument,
} from "./index";

const target = (value: string) => ({ by: "id" as const, value });
const layout = (key = "2000", label = "Example") => ({
  key,
  createdAt: Number(key),
  entries: [{ label, target: target("sso-" + key) }],
});
const native = {
  key: "1000",
  createdAt: 1000,
  pageKind: "sign-in" as const,
  slots: ["password"],
  steps: [
    {
      kind: "fill" as const,
      path: "/login",
      fields: [{ slot: "password", target: target("password") }],
      effect: "prepare" as const,
    },
    {
      kind: "click" as const,
      path: "/login",
      target: target("submit"),
      purpose: "submit" as const,
    },
  ],
  maxSubmissions: 1,
};
const document = (): RecipeDocument => ({
  version: 1,
  id: "gen-sso",
  revision: 1,
  origin: "https://shop.example.test",
  sso: { path: "/login", layouts: [layout()] },
});
const observation = {
  version: 1,
  origin: "https://shop.example.test",
  path: "/login",
  language: "en",
  complete: true,
  candidates: [{ id: "entry", role: "button", target: target("entry") }],
};

describe("declarative SSO documents", () => {
  it("stores SSO alone and beside forms and account choosers without making it executable", () => {
    const only = v.parse(storedLoginRecipeSchema, document());
    expect(isSsoDocument(only)).toBe(true);
    expect(isLoginRecipeDocument(only)).toBe(false);
    expect(isChooserDocument(only)).toBe(false);
    expect(storedRecipeSlots(only)).toEqual([]);
    expect(storedRecipeStartPath(only)).toBe("/login");
    expect(storedLayoutRecipe(only)).toBeUndefined();
    expect(storedLayoutRecipe(only, "2000")).toBeUndefined();
    expect(storedBranchRoute(only, "2000")).toBeUndefined();
    const mixed = v.parse(storedLoginRecipeSchema, {
      ...document(),
      layouts: [native],
      chooser: {
        path: "/login",
        layouts: [{ key: "3000", createdAt: 3000, continue: target("next") }],
      },
    });
    expect(storedLayouts(mixed).map((item) => item.key)).toEqual(["1000", "3000", "2000"]);
    expect(storedRecipeSlots(mixed)).toEqual(["password"]);
    expect(storedLayoutRecipe(mixed, "2000")).toBeUndefined();
    expect(storedLayoutRecipe(mixed, "1000")).toMatchObject({ steps: native.steps });
    expect(withoutLayout(mixed, "1000")).toMatchObject({
      sso: document().sso,
      chooser: mixed.chooser,
    });
    expect(withoutLayout(mixed, "2000")).toMatchObject({
      layouts: [native],
      chooser: mixed.chooser,
    });
    expect(withoutLayout(only, "2000")).toBeUndefined();
  });

  it("rejects malformed entries, duplicate labels and targets, keys, path conflicts and native overlap", () => {
    const original = layout();
    const invalidLayouts = [
      { ...original, entries: [] },
      { ...original, entries: [{ label: " Example", target: target("entry") }] },
      { ...original, entries: [{ label: "Ex\nample", target: target("entry") }] },
      {
        ...original,
        entries: [
          { label: "Example", target: target("one") },
          { label: "EXAMPLE", target: target("two") },
        ],
      },
      {
        ...original,
        entries: [
          { label: "One", target: target("same") },
          { label: "Two", target: target("same") },
        ],
      },
      {
        ...original,
        entries: [{ label: "Example", target: target("one"), origin: "https://idp.example.test" }],
      },
      // The same element with its members in another order (canonical comparison).
      {
        ...original,
        entries: [
          { label: "One", target: { by: "id", value: "same" } },
          { label: "Two", target: { value: "same", by: "id" } },
        ],
      },
      { ...original, createdAt: -1 },
    ];
    for (const item of invalidLayouts)
      expect(
        v.is(storedLoginRecipeSchema, { ...document(), sso: { path: "/login", layouts: [item] } }),
      ).toBe(false);
    for (const layouts of [
      [],
      [layout(), layout()],
      Array.from({ length: MAX_RECIPE_LAYOUTS + 1 }, (_, index) => layout(String(2000 + index))),
    ])
      expect(
        v.is(storedLoginRecipeSchema, { ...document(), sso: { path: "/login", layouts } }),
      ).toBe(false);
    expect(
      v.is(storedLoginRecipeSchema, { ...document(), layouts: [{ ...native, key: "2000" }] }),
    ).toBe(false);
    expect(
      v.is(storedLoginRecipeSchema, {
        ...document(),
        layouts: [native],
        sso: { path: "/elsewhere", layouts: [layout()] },
      }),
    ).toBe(false);
    expect(
      v.is(storedLoginRecipeSchema, {
        ...document(),
        layouts: [native],
        sso: {
          path: "/login",
          layouts: [{ ...original, entries: [{ label: "Example", target: target("password") }] }],
        },
      }),
    ).toBe(false);
    expect(
      v.is(storedLoginRecipeSchema, {
        ...document(),
        layouts: [native],
        sso: {
          path: "/login",
          layouts: [
            {
              ...original,
              entries: [{ label: "Example", target: { value: "password", by: "id" } }],
            },
          ],
        },
      }),
    ).toBe(false);
  });

  it("merges new labels into the newest layout and keeps old entries on a repair", () => {
    const meta = (key: string) => ({ key, createdAt: Number(key) });
    const entry = (label: string, value = label) => ({ label, target: target(value) });
    // Entries of the same label, ignoring case, or of the same element, are replaced.
    expect(
      mergeSsoEntries(
        [entry("A"), entry("B"), entry("C")],
        [entry("a", "a2"), { label: "D", target: { value: "B", by: "id" } }],
      ),
    ).toEqual([entry("C"), entry("a", "a2"), { label: "D", target: { value: "B", by: "id" } }]);
    const many = Array.from({ length: MAX_SSO_LABELS + 1 }, (_, index) => entry(`L${index}`));
    expect(mergeSsoEntries(many.slice(0, -1), many.slice(-1))).toEqual(many.slice(1));

    const added = withSsoEntries(document(), "/login", meta("5000"), [entry("Other")], {
      repair: false,
    });
    expect(added.layout).toBe("2000");
    expect(added.recipe.sso?.layouts).toEqual([
      { ...layout(), entries: [...layout().entries, entry("Other")] },
    ]);
    expect(ssoCovers(added.recipe.sso, ["example", "OTHER"])).toBe(true);
    expect(ssoCovers(added.recipe.sso, ["Example", "Missing"])).toBe(false);
    expect(ssoCovers(undefined, ["Example"])).toBe(false);
    // Nothing changes: the same recipe.
    const same = withSsoEntries(added.recipe, "/login", meta("6000"), [entry("Other")], {
      repair: false,
    });
    expect(same.recipe).toBe(added.recipe);
    expect(
      withSsoEntries(added.recipe, "/elsewhere", meta("6000"), [entry("X")], { repair: false })
        .recipe,
    ).toBe(added.recipe);

    // A repair keeps the old layouts, evicting the least recently used past the bound.
    const previous = {
      ...document(),
      layouts: [native],
      sso: {
        path: "/login",
        layouts: Array.from({ length: MAX_RECIPE_LAYOUTS }, (_, index) =>
          layout(String(2000 + index * 1000)),
        ),
      },
    };
    const repaired = withSsoEntries(previous, "/login", meta("9000"), [entry("Example", "new")], {
      repair: true,
      lastUsed: (key) => (key === "2000" ? 9500 : undefined),
    });
    expect(repaired.layout).toBe("9000");
    expect(repaired.recipe.layouts).toEqual([native]);
    expect(repaired.recipe.sso?.layouts.map((item) => item.key)).toEqual([
      "2000",
      ...Array.from({ length: MAX_RECIPE_LAYOUTS - 2 }, (_, index) => String(4000 + index * 1000)),
      "9000",
    ]);
    expect(repaired.recipe.sso?.layouts.at(-1)?.entries).toEqual([entry("Example", "new")]);
    expect(v.is(storedLoginRecipeSchema, repaired.recipe)).toBe(true);
  });

  it("drops SSO entries a native route uses, and the family with its last entry", () => {
    const shared = {
      ...document(),
      layouts: [native],
      sso: {
        path: "/login",
        layouts: [
          {
            ...layout(),
            entries: [
              { label: "Example", target: { value: "submit", by: "id" } },
              { label: "Other", target: target("other") },
            ],
          },
          { ...layout("3000"), entries: [{ label: "Example", target: target("password") }] },
        ],
      },
    };
    expect(v.is(storedLoginRecipeSchema, shared)).toBe(false);
    const given = ssoBesideNative(shared);
    expect(given.sso).toEqual({
      path: "/login",
      layouts: [{ ...layout(), entries: [{ label: "Other", target: target("other") }] }],
    });
    expect(v.is(storedLoginRecipeSchema, given)).toBe(true);
    const alone = ssoBesideNative({
      ...shared,
      sso: { path: "/login", layouts: [shared.sso.layouts[1]!] },
    });
    expect("sso" in alone).toBe(false);
    expect(alone.layouts).toEqual([native]);
    const separate = { ...document(), layouts: [native] };
    expect(ssoBesideNative(separate)).toBe(separate);
  });
});

describe("label-only SSO generation requests", () => {
  it("accepts SSO-only pages and repairs through the shared request discriminator", () => {
    const request = { version: 1, kind: "sso", observation, labels: ["Example"] };
    expect(v.is(ssoGenerationRequestSchema, request)).toBe(true);
    expect(v.is(generationRequestSchema, request)).toBe(true);
    expect(
      v.is(ssoGenerationRequestSchema, {
        ...request,
        repair: { recipeId: "gen-sso", revision: 1 },
      }),
    ).toBe(true);
    // Labels that differ only by letter case name one entry: the first spelling stays.
    expect(
      v.parse(ssoGenerationRequestSchema, { ...request, labels: ["Example", "EXAMPLE", "Other"] })
        .labels,
    ).toEqual(["Example", "Other"]);
    for (const labels of [
      [],
      [" Example"],
      ["Example\u0000"],
      // More labels than one bounded answer can name (`MAX_SSO_REQUEST_LABELS`).
      Array.from({ length: 9 }, (_, index) => String(index)),
      // Labels local discovery never reads (ADR 0085 amendment of 2026-11-12).
      ["[Example]"],
      ["Ex]ample"],
      ["Ex\u200bample"],
      ["Ex\u202eample"],
      ["Ex\u2028ample"],
      ["Ex\ud800ample"],
      ["E".repeat(129)],
    ])
      expect(v.is(ssoGenerationRequestSchema, { ...request, labels })).toBe(false);
    for (const labels of [["E".repeat(128)], ["Example Co."], ["グーグル"], ["Example 😀"]])
      expect(v.is(ssoGenerationRequestSchema, { ...request, labels })).toBe(true);
    for (const key of [
      "slots",
      "mapping",
      "idpOrigin",
      "username",
      "itemId",
      "route",
      "base",
      "signedIn",
    ])
      expect(v.is(ssoGenerationRequestSchema, { ...request, [key]: "private" })).toBe(false);
    expect(
      v.is(ssoGenerationRequestSchema, {
        ...request,
        observation: { ...observation, value: "private" },
      }),
    ).toBe(false);
    expect(
      v.is(ssoGenerationRequestSchema, {
        ...request,
        repair: { recipeId: "gen-sso", revision: 0 },
      }),
    ).toBe(false);
  });
});

describe("SSO targets beside native chooser controls", () => {
  it.each(["other", "continue"] as const)("refuses reuse of the chooser %s control", (control) => {
    const recipe = {
      ...document(),
      chooser: {
        path: "/login",
        layouts: [{ key: "3000", createdAt: 3000, [control]: target("sso-2000") }],
      },
    };
    expect(v.is(storedLoginRecipeSchema, { ...recipe, sso: undefined })).toBe(true);
    expect(v.is(storedLoginRecipeSchema, recipe)).toBe(false);
  });
});
