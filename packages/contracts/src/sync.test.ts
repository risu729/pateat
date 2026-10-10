import * as v from "valibot";
import { describe, expect, it } from "vitest";
import type { LoginRecipe } from "./login";
import { createDefaultSettings } from "./settings";
import {
  syncRecipeChangeSchema,
  syncRecipeWriteSchema,
  syncSettingsStateSchema,
  syncSettingsWriteSchema,
} from "./sync";

function recipe(revision: number): LoginRecipe {
  return {
    version: 1,
    id: "bank-login",
    revision,
    origin: "https://bank.example",
    slots: ["password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/login",
        fields: [{ slot: "password", target: { by: "id", value: "password" } }],
      },
      { kind: "click", path: "/login", target: { by: "id", value: "submit" }, purpose: "submit" },
    ],
    completion: { path: "/home", target: { by: "id", value: "welcome" } },
    maxSubmissions: 1,
  };
}

const accepts = (schema: v.GenericSchema, value: unknown) => v.safeParse(schema, value).success;

describe("settings sync contract", () => {
  it("represents an empty service state only at revision 0", () => {
    expect(accepts(syncSettingsStateSchema, { version: 1, revision: 0, settings: null })).toBe(
      true,
    );
    expect(accepts(syncSettingsStateSchema, { version: 1, revision: 1, settings: null })).toBe(
      false,
    );
    expect(
      accepts(syncSettingsStateSchema, {
        version: 1,
        revision: 0,
        settings: createDefaultSettings(),
      }),
    ).toBe(false);
  });

  it("syncs policy only, never device-local field policies or values", () => {
    const write = { version: 1, expectedRevision: 0, settings: createDefaultSettings() };
    expect(accepts(syncSettingsWriteSchema, write)).toBe(true);
    expect(accepts(syncSettingsWriteSchema, { ...write, fieldPolicies: [] })).toBe(false);
    expect(
      accepts(syncSettingsWriteSchema, {
        ...write,
        settings: { ...write.settings, password: "synthetic-forbidden-value" },
      }),
    ).toBe(false);
  });
});

describe("recipe sync contract", () => {
  it("binds the stored recipe to its sync identity and revision", () => {
    const change = { recipeId: "bank-login", revision: 2, state: "active", recipe: recipe(2) };
    expect(accepts(syncRecipeChangeSchema, change)).toBe(true);
    expect(accepts(syncRecipeChangeSchema, { ...change, revision: 3 })).toBe(false);
    expect(accepts(syncRecipeChangeSchema, { ...change, recipeId: "other-login" })).toBe(false);
    expect(
      accepts(syncRecipeChangeSchema, { recipeId: "bank-login", revision: 3, state: "revoked" }),
    ).toBe(true);
    expect(accepts(syncRecipeChangeSchema, { ...change, state: "revoked" })).toBe(false);
  });

  it("requires each write to advance exactly one revision", () => {
    const write = { version: 1, expectedRevision: 1, state: "active", recipe: recipe(2) };
    expect(accepts(syncRecipeWriteSchema, write)).toBe(true);
    expect(accepts(syncRecipeWriteSchema, { ...write, recipe: recipe(1) })).toBe(false);
    expect(accepts(syncRecipeWriteSchema, { ...write, recipe: recipe(3) })).toBe(false);
  });

  it("only tombstones a recipe that already has a revision", () => {
    expect(
      accepts(syncRecipeWriteSchema, { version: 1, expectedRevision: 1, state: "revoked" }),
    ).toBe(true);
    expect(
      accepts(syncRecipeWriteSchema, { version: 1, expectedRevision: 0, state: "revoked" }),
    ).toBe(false);
  });
});
