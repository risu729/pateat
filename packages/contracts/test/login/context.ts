import type {
  LoginAccountBinding,
  LoginRecipe,
  LoginRecipeDocument,
  LoginTarget,
} from "../../src/login";
import type { SettingsSnapshot } from "../../src/settings";

export interface LoginTestContext {
  recipe: () => LoginRecipe;
  document: () => LoginRecipeDocument;
  binding: () => LoginAccountBinding;
  snapshot: () => SettingsSnapshot;
  securityKey: { readonly by: "text"; readonly value: "Use security key" };
  passkeyHandler: (
    path?: string,
    target?: LoginTarget,
  ) => { kind: "passkey"; path: string; target: LoginTarget };
  withHandlers: (
    handlers: unknown[],
    base?: LoginRecipe,
  ) => Omit<LoginRecipe, "handlers"> & { handlers: unknown[] };
}
