import { describe } from "vitest";
import {
  parseLoginRecipe,
  toLoginLayout,
  type LoginRecipe,
  type LoginRecipeDocument,
} from "./login";
import { resolveBindingFields, type LocalItemField } from "./recipes";
import { type SavedLoginBinding } from "./settings";
import { registerRecipeSelection } from "../test/recipes/selection";
import { registerSyncedBindings } from "../test/recipes/synced-bindings";
import { registerAutomaticChoice } from "../test/recipes/automatic-choice";
import { registerTemplateBindings } from "../test/recipes/templates";
import { registerBindingGaps } from "../test/recipes/binding-gaps";
import {
  registerDetailSources,
  registerTotpFields,
  registerDisplayNames,
} from "../test/recipes/field-references";

const origin = "https://bank.example";
const target = (value: string) => ({ by: "id" as const, value });
function recipe(id: string, firstPath: string, revision = 1, at = origin): LoginRecipe {
  return parseLoginRecipe({
    version: 1,
    id,
    revision,
    origin: at,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      { kind: "fill", path: firstPath, fields: [{ slot: "username", target: target("user") }] },
      { kind: "fill", path: "/password", fields: [{ slot: "password", target: target("pass") }] },
      { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
    ],
    completion: [{ target: target("welcome") }],
    maxSubmissions: 1,
  });
}
/** The recipe stored as a document of its layouts, created at the times given (ADR 0060). */
function stored(route: LoginRecipe, ...created: number[]): LoginRecipeDocument {
  const { version, id, revision, origin: at } = route;
  return {
    version,
    id,
    revision,
    origin: at,
    layouts: (created.length ? created : [1000]).map((createdAt) =>
      toLoginLayout(route, { key: String(createdAt), createdAt }),
    ),
  };
}
const binding = (overrides: Partial<SavedLoginBinding> = {}): SavedLoginBinding => ({
  recipeId: "bank-signin",
  origin,
  provider: "bitwarden",
  server: "cloud-us",
  userId: "00000000-0000-4000-8000-000000000001",
  itemId: "00000000-0000-4000-8000-000000000002",
  itemName: "Example Bank",
  slots: [
    { slot: "branch", field: { custom: "Branch number" } },
    { slot: "password", field: "password" },
  ],
  ...overrides,
});
const snapshotId = "11111111-1111-4111-8111-111111111111";
const fields = [
  { id: "login.username", name: null },
  { id: "login.password", name: null },
  { id: "login.totp-code", name: null },
  { id: `custom.${snapshotId}.0`, name: "Branch number" },
  { id: `custom.${snapshotId}.1`, name: "PIN" },
  { id: `custom.${snapshotId}.2`, name: "PIN" },
  { id: `custom.${snapshotId}.3`, name: null },
];
/** Resolves every slot of a binding. */
const resolve = (entry: SavedLoginBinding, live: readonly LocalItemField[] = fields) =>
  resolveBindingFields(
    entry,
    entry.slots.map((slot) => slot.slot),
    live,
  );

export type RecipeTestContext = {
  origin: typeof origin;
  target: typeof target;
  recipe: typeof recipe;
  stored: typeof stored;
  binding: typeof binding;
  snapshotId: typeof snapshotId;
  fields: typeof fields;
  resolve: typeof resolve;
};

describe("recipe selection", () => {
  registerRecipeSelection({ origin, target, recipe, stored });
});

describe("synced account bindings", () => {
  registerSyncedBindings({ origin, recipe, binding, snapshotId, fields, resolve });
});

describe("automatic account choice", () => {
  registerAutomaticChoice({ origin, recipe, binding });
});

describe("bindings built from templates (ADR 0027)", () => {
  registerTemplateBindings({ origin, binding, snapshotId, fields, resolve });
});

describe("saved bindings with gaps (ADR 0027, amended 2026-10-19)", () => {
  registerBindingGaps({ binding, fields, resolve });
});

describe("a linked detail's source field (ADR 0061)", () => {
  registerDetailSources();
});

describe("the totp slot's field (ADR 0027, owner 2026-10-23)", () => {
  registerTotpFields({ origin, binding, snapshotId, fields, resolve });
});

describe("loginDisplayNames", () => {
  registerDisplayNames();
});
