import type { RecipeTestContext } from "../../src/recipes.test";

export type RecipeSelectionContext = Pick<
  RecipeTestContext,
  "origin" | "target" | "recipe" | "stored"
>;

export type SyncedBindingContext = Pick<
  RecipeTestContext,
  "origin" | "recipe" | "binding" | "snapshotId" | "fields" | "resolve"
>;

export type AutomaticChoiceContext = Pick<RecipeTestContext, "origin" | "recipe" | "binding">;

export type BindingFieldContext = Pick<
  RecipeTestContext,
  "origin" | "binding" | "snapshotId" | "fields" | "resolve"
>;

export type BindingGapContext = Pick<RecipeTestContext, "binding" | "fields" | "resolve">;
