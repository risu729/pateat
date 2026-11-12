import type { LoginRecipeDocument } from "@pateat/contracts";
export type { RecipeSyncFixtures } from "../../../src/service/recipes.test";
import type { RecipeSyncFixtures } from "../../../src/service/recipes.test";

export type CachedLookupContext = RecipeSyncFixtures & {
  signin: LoginRecipeDocument;
  stored: {
    version: number;
    origin: string;
    deviceId: string;
    cursor: number;
    recipes: LoginRecipeDocument[];
  };
};
