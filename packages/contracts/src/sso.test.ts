import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  generationRequestSchema,
  isSsoDocument,
  isLoginRecipeDocument,
  isChooserDocument,
  ssoGenerationRequestSchema,
  ssoEntryFor,
  ssoStarts,
  storedBranchRoute,
  storedLayoutRecipe,
  storedLayouts,
  storedLoginRecipeSchema,
  storedRecipeSlots,
  storedRecipeStartPath,
  withSsoLayout,
  withoutLayout,
  type RecipeDocument,
  type SsoLayout,
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
    expect(ssoStarts(only)).toEqual([
      {
        path: "/login",
        layout: "2000",
        label: "Example",
        target: target("sso-2000"),
      },
    ]);
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
      { ...original, createdAt: -1 },
    ];
    for (const item of invalidLayouts)
      expect(
        v.is(storedLoginRecipeSchema, { ...document(), sso: { path: "/login", layouts: [item] } }),
      ).toBe(false);
    for (const layouts of [
      [],
      [layout(), layout()],
      ["2000", "3000", "4000", "5000"].map((key) => layout(key)),
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
  });

  it("selects only a unique requested label and keeps a bounded, least-used layout family", () => {
    expect(ssoEntryFor(layout(), " eXaMpLe ")).toEqual(layout().entries[0]);
    expect(ssoEntryFor(layout(), "Other")).toBeUndefined();
    expect(
      ssoEntryFor({ ...layout(), entries: [...layout().entries, ...layout().entries] }, "Example"),
    ).toBeUndefined();
    const previous = {
      ...document(),
      layouts: [native],
      sso: { path: "/login", layouts: ["2000", "3000", "4000"].map((key) => layout(key)) },
    };
    const next = withSsoLayout(previous, "/login", layout("5000"), (key) =>
      key === "2000" ? 9000 : undefined,
    );
    expect(next.layouts).toEqual([native]);
    expect(next.sso?.layouts.map((item) => item.key)).toEqual(["2000", "4000", "5000"]);
    expect(withSsoLayout(next, "/elsewhere", layout("6000"))).toBe(next);
    expect(withSsoLayout(next, "/login", { ...layout("2000"), key: "6000", createdAt: 6000 })).toBe(
      next,
    );
    const bound: SsoLayout = layout();
    expect(bound.entries).toHaveLength(1);
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
    for (const labels of [
      [],
      ["Example", "example"],
      [" Example"],
      ["Example\u0000"],
      Array.from({ length: 33 }, (_, index) => String(index)),
    ])
      expect(v.is(ssoGenerationRequestSchema, { ...request, labels })).toBe(false);
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
