import * as v from "valibot";
import { localRecipeResponseSchema, type LocalRecipeResponse } from "../service/local-recipes";

/** The settings page's view of the recipes kept without a service (ADR 0039). */
export interface RecipeClient {
  get(): Promise<LocalRecipeResponse>;
  /** Adds a parsed recipe file's recipes; the background validates it. */
  importFile(file: unknown): Promise<LocalRecipeResponse>;
  remove(recipeId: string): Promise<LocalRecipeResponse>;
  /** Forgets every recipe kept on this device. */
  clear(): Promise<LocalRecipeResponse>;
  /** The recipes logins use now, as a recipe file. */
  exportFile(): Promise<LocalRecipeResponse>;
}

export function createRecipeClient(send: (message: unknown) => Promise<unknown>): RecipeClient {
  const call = async (message: object): Promise<LocalRecipeResponse> => {
    const parsed = v.safeParse(localRecipeResponseSchema, await send({ version: 1, ...message }));
    return parsed.success ? parsed.output : { version: 1, ok: false, error: "storage-unavailable" };
  };
  return {
    get: () => call({ type: "recipes.get" }),
    importFile: (file) => call({ type: "recipes.import", file }),
    remove: (recipeId) => call({ type: "recipes.remove", recipeId }),
    clear: () => call({ type: "recipes.clear" }),
    exportFile: () => call({ type: "recipes.export" }),
  };
}
