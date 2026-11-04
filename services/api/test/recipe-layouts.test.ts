import { describe, expect, it } from "vitest";
import type { RecipeDocument } from "@pateat/contracts";
import { withoutUnusedLayouts } from "../src/recipe-store";

// A recipe may hold a sign-in form and a list of accounts on its start path (ADR 0028,
// #1248); an unused layout goes after 90 days whatever its kind (ADR 0058 B).
describe("unused layouts of a recipe with a sign-in form and a list", () => {
  const form = {
    key: "1000",
    createdAt: 1000,
    pageKind: "sign-in" as const,
    slots: ["password"],
    steps: [
      {
        kind: "fill" as const,
        path: "/signin",
        effect: "prepare" as const,
        fields: [{ slot: "password", target: { by: "id" as const, value: "password" } }],
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
  const both: RecipeDocument = {
    version: 1,
    id: "gen-both",
    revision: 3,
    origin: "https://login.example",
    layouts: [form],
    chooser: { path: "/signin", layouts: [list] },
  };

  it("removes the unused kind and keeps the used one alone", () => {
    const { chooser: _chooser, ...formOnly } = both;
    const { layouts: _layouts, ...listOnly } = both;
    expect(withoutUnusedLayouts(both, new Map([["1000", 9000]]), 5000)).toEqual({
      ...formOnly,
      revision: 4,
    });
    expect(withoutUnusedLayouts(both, new Map([["2000", 9000]]), 5000)).toEqual({
      ...listOnly,
      revision: 4,
    });
  });

  it("leaves a recipe whose layouts are all used, or all unused, to the recipe's own check", () => {
    expect(withoutUnusedLayouts(both, new Map(), 500)).toBeUndefined();
    expect(withoutUnusedLayouts(both, new Map(), 5000)).toBeUndefined();
  });
});
