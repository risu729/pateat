import { expect, it } from "vitest";
import { customFieldReference, templateLoginBinding } from "../../src/recipes";
import type { RecipeTestContext } from "../../src/recipes.test";

export function registerTemplateBindings({
  origin,
  binding,
  snapshotId,
  fields,
  resolve,
}: Pick<RecipeTestContext, "origin" | "binding" | "snapshotId" | "fields" | "resolve">) {
  const custom = (index: number) => `custom.${snapshotId}.${index}`;
  const bank = { id: "bank-signin", origin };
  const account = {
    provider: "bitwarden",
    server: "cloud-us",
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
}
