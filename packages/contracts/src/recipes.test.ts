import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { parseLoginRecipe, type LoginRecipe } from "./login";
import {
  defaultLoginBinding,
  findLoginBinding,
  findLoginRecipe,
  loginRecipesForOrigin,
  resolveBindingFields,
  saveLoginChoice,
  selectLoginRecipe,
  type LocalItemField,
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
  { id: "login.username", name: null },
  { id: "login.password", name: null },
  { id: "login.totp-code", name: null },
  { id: `custom.${snapshotId}.0`, name: "Branch number" },
  { id: `custom.${snapshotId}.1`, name: "PIN" },
  { id: `custom.${snapshotId}.2`, name: "PIN" },
  { id: `custom.${snapshotId}.3`, name: null },
];
/** Resolves a binding against a recipe with exactly the binding's slots. */
const resolve = (entry: SavedLoginBinding, live: readonly LocalItemField[] = fields) =>
  resolveBindingFields(entry, { slots: entry.slots.map((slot) => slot.slot) }, live);

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
    expect(
      selectLoginRecipe([...recipes, recipe("bank-signin", "/login", 2)], origin, "/login"),
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
    expect(resolve(binding())).toEqual({
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
    expect(resolve(pin(2, 2))).toEqual({
      ok: true,
      slots: [{ slot: "pin", fieldId: `custom.${snapshotId}.2` }],
    });
    expect(resolve(pin(1, 3))).toEqual({
      ok: false,
      slot: "pin",
      reason: "field-count-changed",
    });
    expect(resolve(binding({ slots: [{ slot: "pin", field: { custom: "PIN" } }] }))).toEqual({
      ok: false,
      slot: "pin",
      reason: "field-ambiguous",
    });
  });

  it("refuses a missing field instead of falling back", () => {
    expect(resolve(binding(), [{ id: "login.password", name: null }])).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-missing",
    });
    expect(
      resolve(binding({ slots: [{ slot: "otp", field: "totp" }] }), fields.slice(0, 2)),
    ).toEqual({ ok: false, slot: "otp", reason: "field-missing" });
    // Built-in fields and unnamed custom fields never match a custom name, including
    // the display fallback an unnamed field gets in the catalog.
    for (const name of ["Username", "Custom field 4", `custom.${snapshotId}.3`]) {
      expect(resolve(binding({ slots: [{ slot: "x", field: { custom: name } }] }))).toEqual({
        ok: false,
        slot: "x",
        reason: "field-missing",
      });
    }
  });

  it("counts same-name fields over the whole item in vault order", () => {
    const shuffled = [fields[5]!, fields[0]!, fields[4]!];
    const pin = (position: number) =>
      binding({ slots: [{ slot: "pin", field: { custom: "PIN", position, count: 2 } }] });
    expect(resolve(pin(1), shuffled)).toMatchObject({
      ok: true,
      slots: [{ fieldId: `custom.${snapshotId}.1` }],
    });
    // A removed duplicate is a count change, not a silent fallback to the other one.
    expect(resolve(pin(1), [fields[4]!])).toEqual({
      ok: false,
      slot: "pin",
      reason: "field-count-changed",
    });
  });

  it("refuses a binding whose slots differ from the recipe's", () => {
    const entry = binding();
    expect(resolveBindingFields(entry, { slots: ["branch", "password", "otp"] }, fields)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
    expect(resolveBindingFields(entry, { slots: ["password"] }, fields)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
  });

  it.each([
    ["a position without a count", { custom: "PIN", position: 1 }],
    ["a position beyond the count", { custom: "PIN", position: 3, count: 2 }],
    ["a count of one", { custom: "PIN", position: 1, count: 1 }],
    ["a count without a position", { custom: "PIN", count: 2 }],
    ["a position of zero", { custom: "PIN", position: 0, count: 2 }],
    ["a fractional position", { custom: "PIN", position: 1.5, count: 2 }],
    ["an extra key", { custom: "PIN", index: 1 }],
    ["an empty name", { custom: "" }],
    ["an unknown built-in", "notes"],
  ])("rejects %s", (_label, field) => {
    expect(v.is(savedLoginBindingSchema, binding({ slots: [{ slot: "x", field }] as never }))).toBe(
      false,
    );
  });

  it("rejects duplicate slots in one binding", () => {
    const field = "password" as const;
    expect(
      v.is(
        savedLoginBindingSchema,
        binding({
          slots: [
            { slot: "a", field },
            { slot: "a", field },
          ],
        }),
      ),
    ).toBe(false);
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

describe("automatic account choice", () => {
  const account = {
    provider: "bitwarden",
    userId: binding().userId,
    itemId: binding().itemId,
    itemName: "Example Bank",
  };

  it("binds built-in slot names to the item's built-in fields only", () => {
    expect(
      defaultLoginBinding(
        { ...recipe("bank-signin", "/login"), slots: ["username", "password", "totp"] },
        account,
      ),
    ).toEqual({
      recipeId: "bank-signin",
      origin,
      ...account,
      slots: [
        { slot: "username", field: "username" },
        { slot: "password", field: "password" },
        { slot: "totp", field: "totp" },
      ],
    });
    expect(
      defaultLoginBinding(
        { ...recipe("bank-signin", "/login"), slots: ["username", "branch"] },
        account,
      ),
    ).toBeUndefined();
  });

  it("saves the choice and binding once and never replaces existing ones", () => {
    const settings = createDefaultSettings({ connections: [] });
    const chosen = defaultLoginBinding(recipe("bank-signin", "/login"), account)!;
    const saved = saveLoginChoice(settings, chosen, "live");
    expect(saved.siteDefaults).toEqual([{ origin, connectionId: "live", itemId: account.itemId }]);
    expect(saved.bindings).toEqual([chosen]);
    expect(v.is(localSettingsSchema, saved)).toBe(true);
    expect(saveLoginChoice(saved, chosen, "live")).toBe(saved);

    const other = { ...chosen, itemId: "00000000-0000-4000-8000-000000000003" };
    const kept = saveLoginChoice(saved, other, "live");
    expect(kept.siteDefaults).toEqual(saved.siteDefaults);
    expect(kept.bindings).toEqual([chosen, other]);

    const manual = {
      ...chosen,
      slots: [{ slot: "username", field: { custom: "Login ID" } }, chosen.slots[1]!],
    };
    expect(saveLoginChoice({ ...saved, bindings: [manual] }, chosen, "live").bindings).toEqual([
      manual,
    ]);
  });
});
