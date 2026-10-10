import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { parseLoginRecipe, type LoginRecipe } from "./login";
import {
  findLoginBinding,
  findLoginRecipe,
  loginRecipesForOrigin,
  resolveBindingFields,
  selectLoginRecipe,
} from "./recipes";
import {
  createDefaultSettings,
  localSettingsSchema,
  savedLoginBindingSchema,
  type SavedLoginBinding,
} from "./settings";

const origin = "https://bank.example";
const target = (value: string) => ({ by: "id" as const, value });
function recipe(id: string, firstPath: string, revision = 1, at = origin): LoginRecipe {
  return parseLoginRecipe({
    version: 1,
    id,
    revision,
    origin: at,
    slots: ["username", "password"],
    steps: [
      { kind: "fill", path: firstPath, fields: [{ slot: "username", target: target("user") }] },
      { kind: "fill", path: "/password", fields: [{ slot: "password", target: target("pass") }] },
      { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
    ],
    completion: { path: "/home", target: target("welcome") },
    maxSubmissions: 1,
  });
}
const binding = (overrides: Partial<SavedLoginBinding> = {}): SavedLoginBinding => ({
  recipeId: "bank-signin",
  origin,
  provider: "bitwarden",
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
  { id: "login.username", label: "Username" },
  { id: "login.password", label: "Password" },
  { id: "login.totp-code", label: "Verification code" },
  { id: `custom.${snapshotId}.0`, label: "Branch number" },
  { id: `custom.${snapshotId}.1`, label: "PIN" },
  { id: `custom.${snapshotId}.2`, label: "PIN" },
];

describe("recipe selection", () => {
  const recipes = [
    recipe("bank-signin", "/login"),
    recipe("bank-admin", "/admin"),
    recipe("other-signin", "/login", 1, "https://other.example"),
  ];

  it("lists every recipe of one exact origin", () => {
    expect(loginRecipesForOrigin(recipes, origin).map((entry) => entry.id)).toEqual([
      "bank-signin",
      "bank-admin",
    ]);
  });

  it("starts only on a recipe's first step", () => {
    expect(selectLoginRecipe(recipes, origin, "/login")).toMatchObject({
      ok: true,
      recipe: { id: "bank-signin" },
      stepIndex: 0,
    });
    expect(selectLoginRecipe(recipes, origin, "/password")).toEqual({
      ok: false,
      reason: "recipe-not-found",
    });
    expect(selectLoginRecipe(recipes, "https://third.example", "/login")).toEqual({
      ok: false,
      reason: "recipe-not-found",
    });
  });

  it("refuses when two recipes start on the same page", () => {
    expect(
      selectLoginRecipe([...recipes, recipe("bank-business", "/login")], origin, "/login"),
    ).toEqual({ ok: false, reason: "recipe-ambiguous" });
  });

  it("resumes only the exact recipe revision on its origin", () => {
    const revised = [recipe("bank-signin", "/login", 2)];
    expect(findLoginRecipe(revised, origin, "bank-signin", 2)?.revision).toBe(2);
    expect(findLoginRecipe(revised, origin, "bank-signin", 1)).toBeUndefined();
    expect(findLoginRecipe(revised, "https://other.example", "bank-signin", 2)).toBeUndefined();
  });
});

describe("synced account bindings", () => {
  it("finds the binding for one recipe and item only", () => {
    const account = { provider: "bitwarden", userId: binding().userId, itemId: binding().itemId };
    const bindings = [binding(), binding({ itemId: "00000000-0000-4000-8000-000000000003" })];
    expect(findLoginBinding(bindings, { id: "bank-signin", origin }, account)).toBe(bindings[0]);
    expect(findLoginBinding(bindings, { id: "bank-admin", origin }, account)).toBeUndefined();
    expect(
      findLoginBinding(bindings, { id: "bank-signin", origin }, { ...account, userId: "other" }),
    ).toBeUndefined();
  });

  it("resolves built-in and named custom fields to this device's IDs", () => {
    expect(resolveBindingFields(binding(), fields)).toEqual({
      ok: true,
      slots: [
        { slot: "branch", fieldId: `custom.${snapshotId}.0` },
        { slot: "password", fieldId: "login.password" },
      ],
    });
  });

  it("pins a duplicate name by position only while the count is unchanged", () => {
    const pin = (position: number, count: number) =>
      binding({ slots: [{ slot: "pin", field: { custom: "PIN", position, count } }] });
    expect(resolveBindingFields(pin(2, 2), fields)).toEqual({
      ok: true,
      slots: [{ slot: "pin", fieldId: `custom.${snapshotId}.2` }],
    });
    expect(resolveBindingFields(pin(1, 3), fields)).toEqual({
      ok: false,
      slot: "pin",
      reason: "field-count-changed",
    });
    expect(
      resolveBindingFields(binding({ slots: [{ slot: "pin", field: { custom: "PIN" } }] }), fields),
    ).toEqual({ ok: false, slot: "pin", reason: "field-ambiguous" });
  });

  it("refuses a missing field instead of falling back", () => {
    expect(resolveBindingFields(binding(), [{ id: "login.password", label: "Password" }])).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-missing",
    });
    expect(
      resolveBindingFields(
        binding({ slots: [{ slot: "otp", field: "totp" }] }),
        fields.slice(0, 2),
      ),
    ).toEqual({ ok: false, slot: "otp", reason: "field-missing" });
    // A built-in label never matches a custom name.
    expect(
      resolveBindingFields(
        binding({ slots: [{ slot: "user", field: { custom: "Username" } }] }),
        fields,
      ),
    ).toEqual({ ok: false, slot: "user", reason: "field-missing" });
  });

  it.each([
    ["a position without a count", { custom: "PIN", position: 1 }],
    ["a position beyond the count", { custom: "PIN", position: 3, count: 2 }],
    ["a count of one", { custom: "PIN", position: 1, count: 1 }],
    ["an empty name", { custom: "" }],
    ["an unknown built-in", "notes"],
  ])("rejects %s", (_label, field) => {
    expect(v.is(savedLoginBindingSchema, binding({ slots: [{ slot: "x", field }] as never }))).toBe(
      false,
    );
  });

  it("keeps settings without bindings valid and rejects duplicate bindings", () => {
    const settings = createDefaultSettings({ connections: [] });
    expect(v.is(localSettingsSchema, settings)).toBe(true);
    expect(v.is(localSettingsSchema, { ...settings, bindings: [binding()] })).toBe(true);
    expect(v.is(localSettingsSchema, { ...settings, bindings: [binding(), binding()] })).toBe(
      false,
    );
  });
});
