import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { parseLoginRecipe, type LoginRecipe } from "./login";
import {
  customFieldReference,
  defaultLoginBinding,
  findLoginBinding,
  findLoginRecipe,
  loginRecipesForOrigin,
  resolveBindingFields,
  saveLoginChoice,
  selectLoginRecipe,
  templateLoginBinding,
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

  it("keeps an optional display-only account name", () => {
    expect(v.is(savedLoginBindingSchema, binding({ accountName: "Personal vault" }))).toBe(true);
    // Bindings made by AI generation on the service have none.
    expect(v.is(savedLoginBindingSchema, binding())).toBe(true);
    for (const accountName of ["", "x".repeat(201)])
      expect(v.is(savedLoginBindingSchema, binding({ accountName }))).toBe(false);
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
    const saved = saveLoginChoice(settings, chosen);
    // A new default names the provider account, never the local connection, and keeps
    // the item name for display.
    expect(saved.siteDefaults).toEqual([
      {
        origin,
        provider: "bitwarden",
        userId: account.userId,
        itemId: account.itemId,
        itemName: chosen.itemName,
      },
    ]);
    expect(saved.bindings).toEqual([chosen]);
    expect(v.is(localSettingsSchema, saved)).toBe(true);
    expect(saveLoginChoice(saved, chosen)).toBe(saved);

    // A saved choice of another item or account wins; nothing is added for this one.
    const other = { ...chosen, itemId: "00000000-0000-4000-8000-000000000003" };
    expect(saveLoginChoice(saved, other)).toBe(saved);
    expect(saveLoginChoice(saved, { ...chosen, userId: "other-account" })).toBe(saved);

    // An account picked to become the default replaces another saved default for the
    // origin only; other sites' defaults and existing bindings stay.
    const elsewhere = {
      ...saved,
      siteDefaults: [
        ...saved.siteDefaults,
        { origin: "https://other.example", provider: "bitwarden", userId: "u", itemId: "i" },
      ],
    };
    const replaced = saveLoginChoice(elsewhere, other, { replace: true });
    expect(replaced.siteDefaults).toEqual([
      { origin: "https://other.example", provider: "bitwarden", userId: "u", itemId: "i" },
      expect.objectContaining({ origin, itemId: other.itemId, itemName: other.itemName }),
    ]);
    expect(replaced.bindings).toEqual([chosen, other]);
    expect(v.is(localSettingsSchema, replaced)).toBe(true);
    expect(saveLoginChoice(saved, chosen, { replace: true })).toBe(saved);

    // A saved choice without a binding gains one.
    const unbound = { ...saved, bindings: [] };
    expect(saveLoginChoice(unbound, chosen).bindings).toEqual([chosen]);

    // A default without an item name, or with another name, is never rewritten.
    for (const itemName of [undefined, "Renamed item"]) {
      const older = {
        ...saved,
        siteDefaults: [
          {
            origin,
            provider: "bitwarden",
            userId: account.userId,
            itemId: account.itemId,
            ...(itemName ? { itemName } : {}),
          },
        ],
        bindings: [],
      };
      const updated = saveLoginChoice(older, chosen);
      expect(updated.siteDefaults).toBe(older.siteDefaults);
      expect(updated.bindings).toEqual([chosen]);
    }

    const manual = {
      ...chosen,
      slots: [{ slot: "username", field: { custom: "Login ID" } }, chosen.slots[1]!],
    };
    expect(saveLoginChoice({ ...saved, bindings: [manual] }, chosen).bindings).toEqual([manual]);
  });

  it("keys bindings by origin, so a moved recipe can be bound again", () => {
    const chosen = defaultLoginBinding(recipe("bank-signin", "/login"), account)!;
    const moved = { ...chosen, origin: "https://login.bank.example" };
    const settings = { ...createDefaultSettings({ connections: [] }), bindings: [chosen] };
    const saved = saveLoginChoice(settings, moved);
    expect(saved.bindings).toEqual([chosen, moved]);
    expect(v.is(localSettingsSchema, saved)).toBe(true);
  });

  it("saves nothing when a list is full instead of failing after login", () => {
    const chosen = defaultLoginBinding(recipe("bank-signin", "/login"), account)!;
    const settings = createDefaultSettings({ connections: [] });
    const full = {
      ...settings,
      siteDefaults: Array.from({ length: 1000 }, (_, index) => ({
        origin: `https://site${index}.example`,
        provider: "bitwarden",
        userId: account.userId,
        itemId: "item",
      })),
    };
    expect(saveLoginChoice(full, chosen)).toBe(full);
  });

  it("truncates or replaces the display-only item name", () => {
    const signin = recipe("bank-signin", "/login");
    expect(defaultLoginBinding(signin, { ...account, itemName: "x".repeat(300) })?.itemName).toBe(
      "x".repeat(200),
    );
    expect(defaultLoginBinding(signin, { ...account, itemName: "" })?.itemName).toBe(
      account.itemId,
    );
  });

  it("names the chosen connection's account and copies the name to a new default", () => {
    const signin = recipe("bank-signin", "/login");
    const chosen = defaultLoginBinding(signin, { ...account, accountName: "Personal vault" })!;
    expect(chosen.accountName).toBe("Personal vault");
    expect(v.is(savedLoginBindingSchema, chosen)).toBe(true);
    expect(
      defaultLoginBinding(signin, { ...account, accountName: "x".repeat(300) })?.accountName,
    ).toBe("x".repeat(200));
    // An empty label is left out rather than stored.
    expect(defaultLoginBinding(signin, { ...account, accountName: "" })).not.toHaveProperty(
      "accountName",
    );
    const saved = saveLoginChoice(createDefaultSettings({ connections: [] }), chosen);
    expect(saved.siteDefaults).toEqual([
      {
        origin,
        provider: "bitwarden",
        userId: account.userId,
        itemId: account.itemId,
        itemName: "Example Bank",
        accountName: "Personal vault",
      },
    ]);
    expect(v.is(localSettingsSchema, saved)).toBe(true);
    // A binding without one, such as an AI-generated binding, saves a default without one.
    const unnamed = defaultLoginBinding(signin, account)!;
    expect(
      saveLoginChoice(createDefaultSettings({ connections: [] }), unnamed).siteDefaults[0],
    ).not.toHaveProperty("accountName");
  });
});

describe("bindings built from templates (ADR 0027)", () => {
  const custom = (index: number) => `custom.${snapshotId}.${index}`;
  const bank = { id: "bank-signin", origin };
  const account = {
    provider: "bitwarden",
    userId: binding().userId,
    itemId: binding().itemId,
    itemName: "Example Bank",
  };
  const slots = ["username", "branch", "password"];

  it("names a custom field by name, with position and count only among duplicates", () => {
    expect(customFieldReference(fields, custom(0))).toEqual({ custom: "Branch number" });
    expect(customFieldReference(fields, custom(1))).toEqual({
      custom: "PIN",
      position: 1,
      count: 2,
    });
    expect(customFieldReference(fields, custom(2))).toEqual({
      custom: "PIN",
      position: 2,
      count: 2,
    });
    // Positions follow the vault index, not the catalog order.
    expect(customFieldReference([...fields].reverse(), custom(1))).toMatchObject({ position: 1 });
    // Built-in, unnamed and unknown fields have no reference.
    for (const id of ["login.username", custom(3), custom(9)])
      expect(customFieldReference(fields, id)).toBeUndefined();
    expect(customFieldReference([{ id: "login.username", name: "PIN" }], "login.username")).toBe(
      undefined,
    );
  });

  it("round-trips through resolution", () => {
    for (const index of [0, 1, 2]) {
      const reference = customFieldReference(fields, custom(index))!;
      expect(resolve(binding({ slots: [{ slot: "x", field: reference }] }))).toMatchObject({
        ok: true,
        slots: [{ fieldId: custom(index) }],
      });
    }
  });

  it("binds built-in slots to the item's own fields and other slots by the template's names", () => {
    // The template's built-in references are ignored: this item's built-in fields fill.
    const template = [
      { slot: "username", field: { custom: "Login" } },
      { slot: "branch", field: { custom: "Branch number" } },
      { slot: "password", field: { custom: "Other" } },
    ];
    expect(templateLoginBinding(slots, bank, account, [template], fields)).toEqual({
      ok: true,
      binding: {
        recipeId: "bank-signin",
        origin,
        ...account,
        slots: [
          { slot: "username", field: "username" },
          { slot: "branch", field: { custom: "Branch number" } },
          { slot: "password", field: "password" },
        ],
      },
    });
  });

  it("uses the first template whose references all resolve", () => {
    const missing = [{ slot: "branch", field: { custom: "Region" } }];
    const ambiguous = [{ slot: "branch", field: { custom: "PIN" } }];
    const second = [{ slot: "branch", field: { custom: "PIN", position: 2, count: 2 } }];
    const first = [{ slot: "branch", field: { custom: "Branch number" } }];
    const built = templateLoginBinding(
      slots,
      bank,
      account,
      [missing, ambiguous, second, first],
      fields,
    );
    expect(built).toMatchObject({ ok: true });
    expect(built.ok && built.binding.slots[1]).toEqual({
      slot: "branch",
      field: { custom: "PIN", position: 2, count: 2 },
    });
  });

  it("answers the first refusal, or binding-not-found when no template covers every slot", () => {
    const missing = [{ slot: "branch", field: { custom: "Region" } }];
    const changed = [{ slot: "branch", field: { custom: "PIN", position: 1, count: 3 } }];
    const ambiguous = [{ slot: "branch", field: { custom: "PIN" } }];
    const partial = [{ slot: "other", field: { custom: "Branch number" } }];
    expect(templateLoginBinding(slots, bank, account, [missing, changed], fields)).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-missing",
    });
    expect(templateLoginBinding(slots, bank, account, [partial, changed], fields)).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-count-changed",
    });
    expect(templateLoginBinding(slots, bank, account, [ambiguous], fields)).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-ambiguous",
    });
    expect(templateLoginBinding(slots, bank, account, [partial], fields)).toEqual({
      ok: false,
      reason: "binding-not-found",
    });
    expect(templateLoginBinding(slots, bank, account, [], fields)).toEqual({
      ok: false,
      reason: "binding-not-found",
    });
    // A built-in slot the item lacks is a missing field, not a template gap.
    const branch = [{ slot: "branch", field: { custom: "Branch number" } }];
    const withoutTotp = fields.filter((field) => field.id !== "login.totp-code");
    expect(templateLoginBinding(["totp", "branch"], bank, account, [branch], withoutTotp)).toEqual({
      ok: false,
      slot: "totp",
      reason: "field-missing",
    });
  });

  it("keeps the display names bounded and the account name optional", () => {
    const template = [{ slot: "branch", field: { custom: "Branch number" } }];
    const built = templateLoginBinding(
      ["branch"],
      bank,
      { ...account, itemName: "x".repeat(300), accountName: "y".repeat(300) },
      [template],
      fields,
    );
    expect(built.ok && built.binding.itemName).toHaveLength(200);
    expect(built.ok && built.binding.accountName).toHaveLength(200);
    const unnamed = templateLoginBinding(
      ["branch"],
      bank,
      { ...account, itemName: "" },
      [template],
      fields,
    );
    expect(unnamed.ok && unnamed.binding.itemName).toBe(account.itemId);
    expect(unnamed.ok && "accountName" in unnamed.binding).toBe(false);
  });
});
