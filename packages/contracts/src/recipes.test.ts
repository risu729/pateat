import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  parseLoginRecipe,
  routeBodyOf,
  toLoginLayout,
  type LoginRecipe,
  type LoginRecipeDocument,
  type StoredLoginRecipe,
} from "./login";
import {
  bindingGaps,
  customFieldReference,
  defaultLoginBinding,
  fillLoginBinding,
  findLoginBinding,
  loginDisplayNames,
  loginLayoutCandidates,
  loginRecipesForOrigin,
  rankLayouts,
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

describe("recipe selection", () => {
  const recipes = [
    stored(recipe("bank-signin", "/login")),
    stored(recipe("bank-admin", "/admin")),
    stored(recipe("other-signin", "/login", 1, "https://other.example")),
  ];

  it("starts only on a recipe's first step", () => {
    expect(selectLoginRecipe(recipes, origin, "/login")).toMatchObject({
      ok: true,
      recipe: { id: "bank-signin", layout: "1000" },
      layouts: [{ recipe: { id: "bank-signin", layout: "1000" }, createdAt: 1000 }],
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
      selectLoginRecipe([...recipes, stored(recipe("bank-business", "/login"))], origin, "/login"),
    ).toEqual({ ok: false, reason: "recipe-ambiguous" });
    expect(
      selectLoginRecipe([...recipes, stored(recipe("bank-signin", "/login", 2))], origin, "/login"),
    ).toEqual({ ok: false, reason: "recipe-ambiguous" });
  });

  it("offers every layout of one recipe, the newest first by default (ADR 0060)", () => {
    const layered = stored(recipe("bank-signin", "/login"), 3000, 1000, 2000);
    const selected = selectLoginRecipe([layered], origin, "/login");
    expect(selected).toMatchObject({ ok: true, recipe: { layout: "3000" } });
    expect(selected.ok && selected.layouts.map((candidate) => candidate.recipe.layout)).toEqual([
      "3000",
      "1000",
      "2000",
    ]);
    // Layouts of one recipe never make its start ambiguous.
    expect(loginRecipesForOrigin([layered], origin)).toHaveLength(1);
  });

  it("ranks layouts by visible start elements, then the page's language, then age", () => {
    const route = recipe("bank-signin", "/login");
    const candidates = loginLayoutCandidates({
      ...stored(route, 1000, 2000, 3000),
      layouts: [
        { ...toLoginLayout(route, { key: "1000", language: "ja", createdAt: 1000 }) },
        { ...toLoginLayout(route, { key: "2000", language: "en", createdAt: 2000 }) },
        { ...toLoginLayout(route, { key: "3000", createdAt: 3000 }) },
      ],
    });
    expect(candidates.map((candidate) => candidate.language)).toEqual(["ja", "en", undefined]);
    const order = (shown: number[], language?: "ja" | "en" | "mixed") =>
      rankLayouts(candidates, shown, language).map((candidate) => candidate.recipe.layout);
    // The most visible start elements win; the rest drop out.
    expect(order([2, 1, 1])).toEqual(["1000"]);
    expect(order([1, 2, 2])).toEqual(["3000", "2000"]);
    // On a tie, the page's language first, then the newest.
    expect(order([1, 1, 1], "ja")).toEqual(["1000", "3000", "2000"]);
    expect(order([1, 1, 1], "en")).toEqual(["2000", "3000", "1000"]);
    expect(order([1, 1, 1], "mixed")).toEqual(["3000", "2000", "1000"]);
    expect(order([0, 0, 0])).toEqual(["3000", "2000", "1000"]);
  });

  it("never lists or starts an entry recipe (ADR 0031)", () => {
    const entry: StoredLoginRecipe = {
      version: 1,
      id: "bank-entry",
      revision: 1,
      origin,
      entry: { path: "/login", target: { by: "text", value: "Login" } },
    };
    expect(loginRecipesForOrigin([entry, ...recipes], origin).map(({ id }) => id)).toEqual([
      "bank-signin",
      "bank-admin",
    ]);
    // It shares the start path with a login recipe without making the start ambiguous.
    expect(selectLoginRecipe([entry, ...recipes], origin, "/login")).toMatchObject({
      ok: true,
      recipe: { id: "bank-signin" },
    });
    expect(selectLoginRecipe([entry], origin, "/login")).toEqual({
      ok: false,
      reason: "recipe-not-found",
    });
  });

  it("never lists or starts a chooser recipe or its branch (ADR 0028)", () => {
    const signin = recipe("bank-signin", "/login");
    const chooser: StoredLoginRecipe = {
      version: 1,
      id: "bank-chooser",
      revision: 1,
      origin,
      chooser: {
        path: "/login",
        layouts: [{ key: "1000", createdAt: 1000, afterAccount: routeBodyOf(signin) }],
      },
    };
    expect(loginRecipesForOrigin([chooser, ...recipes], origin).map(({ id }) => id)).toEqual([
      "bank-signin",
      "bank-admin",
    ]);
    expect(selectLoginRecipe([chooser], origin, "/login")).toEqual({
      ok: false,
      reason: "recipe-not-found",
    });
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

  it("refuses a binding that lacks a route slot and ignores its other slots", () => {
    const entry = binding();
    expect(resolveBindingFields(entry, ["branch", "password", "otp"], fields)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
    // Another variant's slot is neither resolved nor refused when it no longer resolves.
    const stale = binding({
      slots: [
        { slot: "branch", field: { custom: "Gone" } },
        { slot: "password", field: "password" },
      ],
    });
    expect(resolveBindingFields(stale, ["password"], fields)).toEqual({
      ok: true,
      slots: [{ slot: "password", fieldId: "login.password" }],
    });
    expect(resolveBindingFields(stale, ["branch", "password"], fields)).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-missing",
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

  it("saves a slot named from the page's text, as the recipe slot schema allows (ADR 0027)", () => {
    const field = { custom: "支店番号" };
    for (const [slot, valid] of [
      ["店番号", true],
      ["会員番号 (ログインID)", true],
      ["店番  号", false],
      ["Ｂｒａｎｃｈ", false],
    ] as const)
      expect(v.is(savedLoginBindingSchema, binding({ slots: [{ slot, field }] })), slot).toBe(
        valid,
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

  it("never accepts an empty binding where a synced or saved one is parsed (ADR 0027)", () => {
    // Only a running login on the passkey route has a binding without slots; it is never
    // stored or synced.
    const empty = binding({ slots: [] });
    expect(v.is(savedLoginBindingSchema, empty)).toBe(false);
    const settings = createDefaultSettings({ connections: [] });
    expect(v.is(localSettingsSchema, { ...settings, bindings: [empty] })).toBe(false);
    const account = {
      provider: "bitwarden",
      userId: empty.userId,
      itemId: empty.itemId,
      itemName: "",
    };
    const signin = recipe("bank-signin", "/login");
    expect(defaultLoginBinding([], signin, account)).toBeUndefined();
    expect(templateLoginBinding([], signin, account, [[]], fields)).toEqual({
      ok: false,
      reason: "binding-not-found",
    });
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
        ["username", "password", "totp"],
        recipe("bank-signin", "/login"),
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
      defaultLoginBinding(["username", "branch"], recipe("bank-signin", "/login"), account),
    ).toBeUndefined();
  });

  it("saves the choice and binding once and never replaces existing ones", () => {
    const settings = createDefaultSettings({ connections: [] });
    const chosen = defaultLoginBinding(
      recipe("bank-signin", "/login").slots,
      recipe("bank-signin", "/login"),
      account,
    )!;
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

  it("widens a saved binding by the slots a login filled, keeping its entries (ADR 0027)", () => {
    const signin = recipe("bank-signin", "/login");
    const settings = createDefaultSettings({ connections: [] });
    const narrow = defaultLoginBinding(["username"], signin, {
      ...account,
      itemName: "Bank (renamed)",
    })!;
    const saved = saveLoginChoice(settings, narrow);
    const wide = { ...narrow, itemName: "Example Bank", accountName: "Personal" };
    wide.slots = [...narrow.slots, { slot: "password", field: "password" }];
    const widened = saveLoginChoice(saved, wide);
    // The binding takes the new entries and keeps its own display names; the default stays.
    expect(widened.bindings).toEqual([{ ...narrow, slots: wide.slots }]);
    expect(widened.siteDefaults).toBe(saved.siteDefaults);
    expect(v.is(localSettingsSchema, widened)).toBe(true);
    expect(saveLoginChoice(widened, wide)).toBe(widened);
    // Other bindings keep their place.
    const other = { ...narrow, recipeId: "other-signin" };
    const both = { ...saved, bindings: [other, ...saved.bindings] };
    expect(saveLoginChoice(both, wide).bindings).toEqual([other, { ...narrow, slots: wide.slots }]);
    // Widened without a saved default, the default is saved too.
    const unset = saveLoginChoice({ ...saved, siteDefaults: [] }, wide);
    expect(unset.bindings).toEqual(widened.bindings);
    expect(unset.siteDefaults).toEqual([expect.objectContaining({ itemId: account.itemId })]);

    // Not a widening: the same entries, fewer, a changed entry, or a changed reference.
    expect(saveLoginChoice(widened, { ...wide, slots: narrow.slots })).toBe(widened);
    const changed = {
      ...wide,
      slots: [
        { slot: "username", field: { custom: "Login ID" } },
        { slot: "password", field: "password" },
        { slot: "totp", field: "totp" },
      ],
    } satisfies SavedLoginBinding;
    expect(saveLoginChoice(widened, changed)).toBe(widened);
    const pinned = binding({
      recipeId: "bank-signin",
      slots: [{ slot: "pin", field: { custom: "PIN", position: 1, count: 2 } }],
    });
    const pinSaved = { ...settings, bindings: [pinned] };
    const otherPosition = {
      ...pinned,
      slots: [
        { slot: "pin", field: { custom: "PIN", position: 2, count: 2 } },
        { slot: "password", field: "password" },
      ],
    } satisfies SavedLoginBinding;
    expect(saveLoginChoice(pinSaved, otherPosition).bindings).toEqual([pinned]);
    const samePosition = {
      ...pinned,
      slots: [...pinned.slots, { slot: "password", field: "password" }],
    } satisfies SavedLoginBinding;
    expect(saveLoginChoice(pinSaved, samePosition).bindings).toEqual([samePosition]);
    // The saved entries must come first and in their order.
    const reordered = {
      ...pinned,
      slots: [{ slot: "password", field: "password" }, ...pinned.slots],
    } satisfies SavedLoginBinding;
    expect(saveLoginChoice(pinSaved, reordered).bindings).toEqual([pinned]);
    // A binding of another item or recipe is never widened.
    expect(
      saveLoginChoice(saved, { ...wide, itemId: "00000000-0000-4000-8000-000000000003" }).bindings,
    ).toEqual(saved.bindings);
  });

  it("saves only the site default for a choice without slots (ADR 0027)", () => {
    const signin = recipe("bank-signin", "/login");
    const chosen = defaultLoginBinding(signin.slots, signin, {
      ...account,
      accountName: "Personal vault",
    })!;
    const { recipeId: _recipeId, slots: _slots, ...owner } = chosen;
    const settings = createDefaultSettings({ connections: [] });
    const saved = saveLoginChoice(settings, owner);
    expect(saved.siteDefaults).toEqual([
      {
        origin,
        provider: "bitwarden",
        userId: account.userId,
        itemId: account.itemId,
        itemName: chosen.itemName,
        accountName: "Personal vault",
      },
    ]);
    // A login that filled nothing proves no binding, so none is added.
    expect(saved.bindings).toEqual([]);
    expect(v.is(localSettingsSchema, saved)).toBe(true);
    expect(saveLoginChoice(saved, owner)).toBe(saved);
    // A saved choice of another account wins, unless the account was picked to replace it.
    const other = { ...owner, itemId: "00000000-0000-4000-8000-000000000003" };
    expect(saveLoginChoice(saved, other)).toBe(saved);
    expect(saveLoginChoice(saved, other, { replace: true }).siteDefaults).toEqual([
      expect.objectContaining({ origin, itemId: other.itemId }),
    ]);
    // A synced binding for the account stays as it is.
    const bound = { ...saved, bindings: [chosen] };
    expect(saveLoginChoice(bound, owner)).toBe(bound);
  });

  it("keys bindings by origin, so a moved recipe can be bound again", () => {
    const chosen = defaultLoginBinding(
      recipe("bank-signin", "/login").slots,
      recipe("bank-signin", "/login"),
      account,
    )!;
    const moved = { ...chosen, origin: "https://login.bank.example" };
    const settings = { ...createDefaultSettings({ connections: [] }), bindings: [chosen] };
    const saved = saveLoginChoice(settings, moved);
    expect(saved.bindings).toEqual([chosen, moved]);
    expect(v.is(localSettingsSchema, saved)).toBe(true);
  });

  it("saves nothing when a list is full instead of failing after login", () => {
    const chosen = defaultLoginBinding(
      recipe("bank-signin", "/login").slots,
      recipe("bank-signin", "/login"),
      account,
    )!;
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
    expect(
      defaultLoginBinding(signin.slots, signin, { ...account, itemName: "x".repeat(300) })
        ?.itemName,
    ).toBe("x".repeat(200));
    expect(defaultLoginBinding(signin.slots, signin, { ...account, itemName: "" })?.itemName).toBe(
      account.itemId,
    );
  });

  it("names the chosen connection's account and copies the name to a new default", () => {
    const signin = recipe("bank-signin", "/login");
    const chosen = defaultLoginBinding(signin.slots, signin, {
      ...account,
      accountName: "Personal vault",
    })!;
    expect(chosen.accountName).toBe("Personal vault");
    expect(v.is(savedLoginBindingSchema, chosen)).toBe(true);
    expect(
      defaultLoginBinding(signin.slots, signin, { ...account, accountName: "x".repeat(300) })
        ?.accountName,
    ).toBe("x".repeat(200));
    // An empty label is left out rather than stored.
    expect(
      defaultLoginBinding(signin.slots, signin, { ...account, accountName: "" }),
    ).not.toHaveProperty("accountName");
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
    const unnamed = defaultLoginBinding(signin.slots, signin, account)!;
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

describe("saved bindings with gaps (ADR 0027, amended 2026-10-19)", () => {
  const saved = binding({ slots: [{ slot: "username", field: "username" }] });
  const branch = [{ slot: "branch", field: { custom: "Branch number" } }];

  it("lists the slots a binding holds no entry for", () => {
    expect(bindingGaps(saved, ["username", "password", "branch"])).toEqual(["password", "branch"]);
    expect(bindingGaps(saved, ["username"])).toEqual([]);
  });

  it("uses a binding that covers the slots as it is", () => {
    expect(fillLoginBinding(saved, ["username"], [branch], fields)).toEqual({
      ok: true,
      binding: saved,
      widened: false,
    });
  });

  it("fills built-in gaps from the item's built-in fields and keeps the saved entries", () => {
    const manual = binding({
      slots: [{ slot: "username", field: { custom: "PIN", position: 2, count: 2 } }],
    });
    const filled = fillLoginBinding(manual, ["password", "username", "totp"], [], fields);
    expect(filled).toEqual({
      ok: true,
      widened: true,
      binding: {
        ...manual,
        slots: [
          ...manual.slots,
          { slot: "password", field: "password" },
          { slot: "totp", field: "totp" },
        ],
      },
    });
    // Filled entries resolve like any.
    expect(filled.ok && resolve(filled.binding)).toMatchObject({ ok: true });
    // A built-in field the item lacks is a missing field.
    const withoutPassword = fields.filter((field) => field.id !== "login.password");
    expect(fillLoginBinding(saved, ["username", "password"], [], withoutPassword)).toEqual({
      ok: false,
      slot: "password",
      reason: "field-missing",
    });
  });

  it("fills custom gaps from the first template that resolves, as without a saved binding", () => {
    const missing = [{ slot: "branch", field: { custom: "Region" } }];
    const ambiguous = [{ slot: "branch", field: { custom: "PIN" } }];
    const filled = fillLoginBinding(
      saved,
      ["username", "branch", "password"],
      [[], missing, ambiguous, branch],
      fields,
    );
    expect(filled).toEqual({
      ok: true,
      widened: true,
      binding: {
        ...saved,
        slots: [
          { slot: "username", field: "username" },
          { slot: "branch", field: { custom: "Branch number" } },
          { slot: "password", field: "password" },
        ],
      },
    });
    // The first refusal when no template resolves.
    expect(fillLoginBinding(saved, ["username", "branch"], [missing, ambiguous], fields)).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-missing",
    });
    expect(fillLoginBinding(saved, ["username", "branch"], [ambiguous], fields)).toEqual({
      ok: false,
      slot: "branch",
      reason: "field-ambiguous",
    });
    // No template names the slot: the gap stays, as before.
    expect(fillLoginBinding(saved, ["username", "branch", "password"], [], fields)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
  });

  it("never fills a gap with a built-in field the binding already reads under another slot", () => {
    const elsewhere = binding({
      slots: [
        { slot: "username", field: "username" },
        { slot: "Web password", field: "password" },
      ],
    });
    expect(fillLoginBinding(elsewhere, ["username", "password"], [], fields)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
    // Another built-in field still fills.
    expect(
      fillLoginBinding(elsewhere, ["username", "Web password", "totp"], [], fields),
    ).toMatchObject({ ok: true, widened: true });
  });

  it("refuses a binding that would grow past the schema's 20 slots", () => {
    const full = binding({
      slots: Array.from({ length: 20 }, (_, index) => ({
        slot: `slot ${index}`,
        field: { custom: "Branch number" },
      })),
    });
    expect(fillLoginBinding(full, ["password"], [], fields)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
  });
});

describe("loginDisplayNames", () => {
  it("names an item by its label, else its ID, and its account by the connection's label", () => {
    expect(loginDisplayNames("item-1", "Example Bank", "Personal")).toEqual({
      itemName: "Example Bank",
      accountName: "Personal",
    });
    expect(loginDisplayNames("item-1", "", undefined)).toEqual({ itemName: "item-1" });
    expect(loginDisplayNames("item-1", "x".repeat(250), "y".repeat(250))).toEqual({
      itemName: "x".repeat(200),
      accountName: "y".repeat(200),
    });
  });
});
