import { expect, it } from "vitest";
import * as v from "valibot";
import { defaultLoginBinding, saveLoginChoice } from "../../src/recipes";
import {
  createDefaultSettings,
  localSettingsSchema,
  savedLoginBindingSchema,
  type SavedLoginBinding,
} from "../../src/settings";
import type { AutomaticChoiceContext } from "./context";

export function registerAutomaticChoice({ origin, recipe, binding }: AutomaticChoiceContext) {
  const account = {
    provider: "bitwarden",
    server: "cloud-us",
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
        server: "cloud-us",
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
    expect(saveLoginChoice(saved, { ...chosen, server: "https://vault.example" })).toBe(saved);

    // An account picked to become the default replaces another saved default for the
    // origin only; other sites' defaults and existing bindings stay.
    const elsewhere = {
      ...saved,
      siteDefaults: [
        ...saved.siteDefaults,
        {
          origin: "https://other.example",
          provider: "bitwarden",
          server: "cloud-us",
          userId: "u",
          itemId: "i",
        },
      ],
    };
    const replaced = saveLoginChoice(elsewhere, other, { replace: true });
    expect(replaced.siteDefaults).toEqual([
      {
        origin: "https://other.example",
        provider: "bitwarden",
        server: "cloud-us",
        userId: "u",
        itemId: "i",
      },
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
            server: "cloud-us",
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
        server: "cloud-us",
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
        server: "cloud-us",
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
        server: "cloud-us",
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
}
