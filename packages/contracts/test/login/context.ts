import type { LoginAccountBinding } from "../../src/login/account";
import type { LoginRecipe } from "../../src/login/route-schema";
import type { LoginRecipeDocument } from "../../src/login/document-schema";
import type { LoginTarget } from "../../src/login/targets";
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
