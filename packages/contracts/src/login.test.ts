import { describe } from "vitest";
import {
  type LoginAccountBinding,
  type LoginRecipe,
  type LoginTarget,
  toLoginLayout,
  type LoginRecipeDocument,
} from "./login";
import { createDefaultSettings, type SettingsSnapshot } from "./settings";
import {
  registerDeclarativeBoundaries,
  registerSavedPlanAuthorization,
  registerShadowLocators,
} from "../test/login/boundaries";
import {
  registerPasskeyHandlers,
  registerPasswordHandler,
  registerTotpHandler,
  registerDetailHandler,
  registerHandlerOperations,
} from "../test/login/handler-validation";
import { registerHandlerContinuations } from "../test/login/handler-continuations";
import {
  registerPasswordVariants,
  registerPasskeyRoute,
  registerTotpRecipeChecks,
} from "../test/login/routes";
import {
  registerEntryRecipes,
  registerPasswordStop,
  registerLaterStartSteps,
  registerMissingRoutes,
  registerLogoutRecipes,
} from "../test/login/lifecycle";
import {
  registerChooserRecipes,
  registerChooserPasskey,
  registerRecipeLayouts,
} from "../test/login/chooser-layouts";

function recipe(): LoginRecipe {
  return {
    version: 1,
    id: "bank-login",
    revision: 1,
    origin: "https://bank.example",
    pageKind: "sign-in",
    slots: ["branch", "account", "password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/identity",
        fields: [
          { slot: "branch", target: { by: "id", value: "branch" } },
          { slot: "account", target: { by: "id", value: "account" } },
        ],
      },
      { kind: "click", path: "/identity", target: { by: "id", value: "next" }, purpose: "advance" },
      {
        kind: "fill",
        effect: "prepare",
        path: "/password",
        fields: [{ slot: "password", target: { by: "id", value: "password" } }],
      },
      { kind: "click", path: "/password", target: { by: "id", value: "login" }, purpose: "submit" },
    ],
    completion: [{ target: { by: "id", value: "authenticated" } }],
    rejection: { by: "id", value: "rejected" },
    maxSubmissions: 2,
  };
}

/** The recipe stored as a document with one layout (ADR 0060). */
function document(): LoginRecipeDocument {
  const { version, id, revision, origin } = recipe();
  return {
    version,
    id,
    revision,
    origin,
    layouts: [toLoginLayout(recipe(), { key: "1000", language: "en", createdAt: 1000 })],
  };
}

function binding(): LoginAccountBinding {
  return {
    origin: "https://bank.example",
    connectionId: "demo-personal",
    itemId: "primary",
    slots: [
      { slot: "branch", fieldId: "branch" },
      { slot: "account", fieldId: "username" },
      { slot: "password", fieldId: "password" },
    ],
  };
}

function snapshot(): SettingsSnapshot {
  const settings = createDefaultSettings();
  settings.siteDefaults = [
    {
      origin: "https://bank.example",
      provider: "dummy",
      server: "cloud-us",
      userId: "demo-personal-account",
      itemId: "primary",
    },
  ];
  return { version: 1, revision: 4, settings };
}

registerDeclarativeBoundaries({ recipe, binding });

registerSavedPlanAuthorization({ recipe, binding, snapshot });

describe("second-factor page handlers (ADR 0027)", () => {
  const securityKey = { by: "text", value: "Use security key" } as const;
  const passkeyHandler = (path = "/webauthn", target: LoginTarget = securityKey) => ({
    kind: "passkey" as const,
    path,
    target,
  });
  const withHandlers = (handlers: unknown[], base: LoginRecipe = recipe()) => ({
    ...base,
    handlers,
  });

  registerPasskeyHandlers({ securityKey, passkeyHandler, withHandlers });

  registerPasswordHandler({ recipe, passkeyHandler, withHandlers });

  registerTotpHandler({ securityKey, passkeyHandler, withHandlers });

  registerDetailHandler({ recipe, passkeyHandler, withHandlers });

  registerHandlerOperations({ passkeyHandler });

  registerHandlerContinuations({ recipe, passkeyHandler });
});

registerPasswordVariants({ binding, snapshot });

registerPasskeyRoute({ recipe, binding, snapshot });

registerTotpRecipeChecks({ recipe });

registerEntryRecipes({ recipe, document });

registerChooserRecipes({ recipe, document });

registerChooserPasskey({ recipe });

registerRecipeLayouts({ recipe, document });

registerPasswordStop();

registerLaterStartSteps();

registerMissingRoutes({ recipe });

registerLogoutRecipes({ recipe });

registerShadowLocators();
