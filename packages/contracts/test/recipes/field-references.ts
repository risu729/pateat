import { expect, it } from "vitest";
import {
  defaultLoginBinding,
  fillLoginBinding,
  loginDisplayNames,
  resolveDetailSourceField,
  templateLoginBinding,
  totpFieldMismatch,
  totpFieldReference,
  type LocalItemField,
} from "../../src/recipes";
import type { RecipeTestContext } from "../../src/recipes.test";

export function registerDetailSources() {
  const itemFields: LocalItemField[] = [
    { id: "identity.phone", name: null },
    { id: "custom.snapshot.0", name: "生年月日" },
    { id: "custom.snapshot.1", name: "Birthday" },
    { id: "custom.snapshot.3", name: "Birthday" },
  ];

  it("keeps a built-in field the item has", () => {
    expect(resolveDetailSourceField("identity.phone", itemFields)).toBe("identity.phone");
    expect(resolveDetailSourceField("card.code", itemFields)).toBeUndefined();
    expect(resolveDetailSourceField("card.number", [{ id: "card.number", name: null }])).toBe(
      "card.number",
    );
  });

  it("resolves a custom field by its name, as a binding reference does", () => {
    expect(resolveDetailSourceField({ custom: "生年月日" }, itemFields)).toBe("custom.snapshot.0");
    expect(
      resolveDetailSourceField({ custom: "Birthday", position: 2, count: 2 }, itemFields),
    ).toBe("custom.snapshot.3");
  });

  it("resolves no custom field that is missing, ambiguous or counted differently", () => {
    expect(resolveDetailSourceField({ custom: "Phone" }, itemFields)).toBeUndefined();
    expect(resolveDetailSourceField({ custom: "Birthday" }, itemFields)).toBeUndefined();
    expect(
      resolveDetailSourceField({ custom: "Birthday", position: 1, count: 3 }, itemFields),
    ).toBeUndefined();
  });
}

export function registerTotpFields({
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
  // The built-in TOTP field holds no key, and the custom field "Seed" holds one.
  const seeded: LocalItemField[] = [
    { id: "login.username", name: null },
    { id: "login.password", name: null },
    { id: "login.totp-code", name: null, empty: true },
    { id: custom(0), name: "Branch number" },
    { id: custom(1), name: "Seed", totpSeed: true },
  ];

  it("reads the built-in field when it holds a key, else the one flagged custom field", () => {
    expect(totpFieldReference(fields)).toBe("totp");
    expect(totpFieldReference(seeded)).toEqual({ custom: "Seed" });
    // A built-in field holding a key wins over a flagged custom field.
    const both = seeded.map((field) =>
      field.id === "login.totp-code" ? { id: field.id, name: null } : field,
    );
    expect(totpFieldReference(both)).toBe("totp");
    // Several flagged fields, or an unnamed one, leave the built-in field.
    expect(
      totpFieldReference([...seeded, { id: custom(2), name: "Other seed", totpSeed: true }]),
    ).toBe("totp");
    expect(
      totpFieldReference(
        seeded.map((field) => (field.id === custom(1) ? { ...field, name: null } : field)),
      ),
    ).toBe("totp");
    // A flag on a built-in field never counts.
    expect(
      totpFieldReference([{ id: "login.totp-code", name: null, empty: true, totpSeed: true }]),
    ).toBe("totp");
    // Same-name fields are named by position.
    expect(totpFieldReference([...seeded, { id: custom(2), name: "Seed" }])).toEqual({
      custom: "Seed",
      position: 1,
      count: 2,
    });
  });

  it("tells which fields a slot may not read under the TOTP key rule", () => {
    const [, , builtin, branch, seed] = seeded;
    // Only the totp slot reads a flagged field, and it reads no unflagged custom field.
    expect(totpFieldMismatch("branch", seed)).toBe(true);
    expect(totpFieldMismatch("password", seed)).toBe(true);
    expect(totpFieldMismatch("totp", seed)).toBe(false);
    expect(totpFieldMismatch("totp", branch)).toBe(true);
    expect(totpFieldMismatch("branch", branch)).toBe(false);
    // Built-in fields are left to the other checks.
    expect(totpFieldMismatch("totp", builtin)).toBe(false);
    expect(totpFieldMismatch("totp", { id: "login.password", name: null })).toBe(false);
    expect(totpFieldMismatch("totp", undefined)).toBe(false);
  });

  it("binds the automatic, template and gap-filled totp slot to the flagged field", () => {
    expect(defaultLoginBinding(["username", "totp"], bank, account, seeded)?.slots).toEqual([
      { slot: "username", field: "username" },
      { slot: "totp", field: { custom: "Seed" } },
    ]);
    // Without the item's fields, the built-in field as before.
    expect(defaultLoginBinding(["totp"], bank, account)?.slots).toEqual([
      { slot: "totp", field: "totp" },
    ]);
    const template = [{ slot: "branch", field: { custom: "Branch number" } }];
    const built = templateLoginBinding(["branch", "totp"], bank, account, [template], seeded);
    expect(built.ok && built.binding.slots).toEqual([
      { slot: "branch", field: { custom: "Branch number" } },
      { slot: "totp", field: { custom: "Seed" } },
    ]);
    const saved = binding({ slots: [{ slot: "username", field: "username" }] });
    const filled = fillLoginBinding(saved, ["username", "totp"], [], seeded);
    expect(filled.ok && filled.binding.slots).toEqual([
      { slot: "username", field: "username" },
      { slot: "totp", field: { custom: "Seed" } },
    ]);
    expect(filled.ok && resolve(filled.binding, seeded)).toEqual({
      ok: true,
      slots: [
        { slot: "username", fieldId: "login.username" },
        { slot: "totp", fieldId: custom(1) },
      ],
    });
    // A template that would fill the flagged field as text is skipped for the next one.
    const seedTemplate = [{ slot: "branch", field: { custom: "Seed" } }];
    const skipped = templateLoginBinding(
      ["branch", "totp"],
      bank,
      account,
      [seedTemplate, template],
      seeded,
    );
    expect(skipped.ok && skipped.binding.slots).toEqual([
      { slot: "branch", field: { custom: "Branch number" } },
      { slot: "totp", field: { custom: "Seed" } },
    ]);
    expect(templateLoginBinding(["branch"], bank, account, [seedTemplate], seeded)).toEqual({
      ok: false,
      reason: "binding-not-found",
    });
    expect(fillLoginBinding(saved, ["username", "branch"], [seedTemplate], seeded)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
    // A saved binding that already names the flagged field under another slot is not
    // filled with it again.
    const named = binding({ slots: [{ slot: "code", field: { custom: "Seed" } }] });
    expect(fillLoginBinding(named, ["code", "totp"], [], seeded)).toEqual({
      ok: false,
      reason: "binding-slots-mismatch",
    });
  });
}

export function registerDisplayNames() {
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
}
