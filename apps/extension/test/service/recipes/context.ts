import type { LoginRecipeDocument } from "@pateat/contracts";
import type { RecipeSyncFixtures } from "../../../src/service/recipes.test";

export type RecipeSyncContext = RecipeSyncFixtures;

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
