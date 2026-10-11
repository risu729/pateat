import { customFieldSlotDescriptions, type VaultItemMetadata } from "@pateat/contracts";
import { describe, expect, it } from "vitest";
import { customFieldOffers, MAX_CUSTOM_OFFERS } from "./generation-slots";

// Synthetic catalog metadata only: no field values exist here (ADR 0027).

type Field = VaultItemMetadata["fields"][number];
const snapshot = "11111111-1111-4111-8111-111111111111";
const custom = (index: number, name: string | null, kind: Field["kind"], extra = {}): Field => ({
  id: `custom.${snapshot}.${index}`,
  label: name ?? `Custom field ${index + 1}`,
  name,
  kind,
  ...extra,
});
const username: Field = { id: "login.username", label: "Username", name: null, kind: "text" };
const password: Field = { id: "login.password", label: "Password", name: null, kind: "hidden" };
const item = (id: string, fields: Field[], allowed = fields.map((field) => field.id)) => ({
  connectionId: "connection-1",
  item: { id, fields: [username, password, ...fields] },
  allowedFieldIds: [username.id, password.id, ...allowed],
});

describe("custom-field offers (ADR 0027)", () => {
  it("offers Text, Hidden and Linked fields by name under opaque IDs", () => {
    const offers = customFieldOffers([
      item("item-1", [
        custom(0, "Branch number", "text"),
        custom(1, "PIN", "hidden"),
        custom(2, "Login ID", "linked", { linkedFieldId: "login.username" }),
        custom(3, "Secret copy", "linked", { linkedFieldId: "login.password" }),
      ]),
    ]);
    expect(offers.map((offer) => offer.slot)).toEqual([
      {
        id: "custom-1",
        kind: "identifier",
        description: customFieldSlotDescriptions.identifier,
        fieldName: "Branch number",
      },
      {
        id: "custom-2",
        kind: "hidden",
        description: customFieldSlotDescriptions.hidden,
        fieldName: "PIN",
      },
      {
        id: "custom-3",
        kind: "identifier",
        description: customFieldSlotDescriptions.identifier,
        fieldName: "Login ID",
      },
      {
        id: "custom-4",
        kind: "secret",
        description: customFieldSlotDescriptions.secret,
        fieldName: "Secret copy",
      },
    ]);
    // Only visible identifier values may be read for a shape.
    expect(offers.map((offer) => offer.shapeable)).toEqual([true, false, true, false]);
    expect(offers.map((offer) => offer.members[0]!.source)).toEqual([
      "text",
      undefined,
      "username",
      undefined,
    ]);
    // Nothing names the item or the account in a slot.
    expect(JSON.stringify(offers.map((offer) => offer.slot))).not.toContain("item-1");
  });

  it("skips Boolean, unsupported, unnamed, blank and over-long names and excluded fields", () => {
    const offers = customFieldOffers([
      item(
        "item-1",
        [
          custom(0, "Remember", "boolean"),
          custom(1, "Odd", "unsupported"),
          custom(2, null, "text"),
          custom(3, "   ", "text"),
          custom(4, "x".repeat(121), "text"),
          custom(5, "Excluded", "text"),
          custom(6, "Kept", "text"),
          custom(7, "Bad​name", "text"),
        ],
        [0, 1, 2, 3, 4, 6, 7].map((index) => `custom.${snapshot}.${index}`),
      ),
    ]);
    expect(offers.map((offer) => offer.slot.fieldName)).toEqual(["Kept"]);
    expect(offers[0]!.slot.id).toBe("custom-1");
  });

  it("offers a Linked field only when the field it reads is allowed, and the password only when set", () => {
    const linkedUser = custom(0, "Login ID", "linked", { linkedFieldId: "login.username" });
    const linkedPassword = custom(1, "Secret copy", "linked", { linkedFieldId: "login.password" });
    const withoutUsername = item("item-1", [linkedUser, linkedPassword]);
    withoutUsername.allowedFieldIds = withoutUsername.allowedFieldIds.filter(
      (id) => id !== "login.username",
    );
    expect(customFieldOffers([withoutUsername]).map((offer) => offer.slot.fieldName)).toEqual([
      "Secret copy",
    ]);
    const empty = item("item-1", [linkedUser, linkedPassword]);
    empty.item.fields = empty.item.fields.map((field) =>
      field.id === "login.password" ? { ...field, empty: true as const } : field,
    );
    expect(customFieldOffers([empty]).map((offer) => offer.slot.fieldName)).toEqual(["Login ID"]);
    const unlinked = custom(2, "Nothing", "linked");
    expect(customFieldOffers([item("item-1", [unlinked])])).toEqual([]);
  });

  it("unites the items' fields by name, position and count", () => {
    const offers = customFieldOffers([
      item("item-1", [custom(0, "Branch number", "text"), custom(1, "PIN", "hidden")]),
      {
        ...item("item-2", [
          custom(0, "Region", "text"),
          custom(1, "Branch number", "text"),
          custom(2, "PIN", "hidden"),
          custom(3, "PIN", "hidden"),
        ]),
        connectionId: "connection-2",
      },
    ]);
    expect(offers.map(({ slot, reference }) => [slot.id, reference])).toEqual([
      ["custom-1", { custom: "Branch number" }],
      ["custom-2", { custom: "PIN" }],
      ["custom-3", { custom: "Region" }],
      ["custom-4", { custom: "PIN", position: 1, count: 2 }],
      ["custom-5", { custom: "PIN", position: 2, count: 2 }],
    ]);
    expect(offers[0]!.members).toEqual([
      {
        connectionId: "connection-1",
        itemId: "item-1",
        fieldId: `custom.${snapshot}.0`,
        source: "text",
      },
      {
        connectionId: "connection-2",
        itemId: "item-2",
        fieldId: `custom.${snapshot}.1`,
        source: "text",
      },
    ]);
    expect(offers[3]!.slot.fieldPosition).toEqual({ position: 1, count: 2 });
    expect(offers[1]!.slot).not.toHaveProperty("fieldPosition");
  });

  it("gives a name whose kinds differ the strictest kind and no shape", () => {
    const offers = customFieldOffers([
      item("item-1", [custom(0, "Code", "text"), custom(1, "Login", "text")]),
      item("item-2", [custom(0, "Code", "hidden"), custom(1, "Login", "text")]),
      item("item-3", [
        custom(0, "Code", "linked", { linkedFieldId: "login.password" }),
        custom(1, "Login", "linked", { linkedFieldId: "login.username" }),
      ]),
    ]);
    expect(offers.map(({ slot, shapeable }) => [slot.fieldName, slot.kind, shapeable])).toEqual([
      ["Code", "secret", false],
      ["Login", "identifier", true],
    ]);
    const hiddenOverText = customFieldOffers([
      item("item-1", [custom(0, "Code", "text")]),
      item("item-2", [custom(0, "Code", "hidden")]),
    ]);
    expect(hiddenOverText.map(({ slot, shapeable }) => [slot.kind, shapeable])).toEqual([
      ["hidden", false],
    ]);
  });

  it("keeps Text fields first past the cap and numbers the rest in field order", () => {
    const fields = [
      custom(0, "Secret copy", "linked", { linkedFieldId: "login.password" }),
      custom(1, "PIN", "hidden"),
      custom(2, "Login ID", "linked", { linkedFieldId: "login.username" }),
      ...Array.from({ length: 3 }, (_, index) => custom(index + 3, `Text ${index + 1}`, "text")),
    ];
    const names = (cap: number) =>
      customFieldOffers([item("item-1", fields)], cap).map(({ slot }) => [slot.id, slot.fieldName]);
    expect(names(3)).toEqual([
      ["custom-1", "Text 1"],
      ["custom-2", "Text 2"],
      ["custom-3", "Text 3"],
    ]);
    expect(names(4)).toEqual([
      ["custom-1", "Login ID"],
      ["custom-2", "Text 1"],
      ["custom-3", "Text 2"],
      ["custom-4", "Text 3"],
    ]);
    expect(names(5).map(([, name]) => name)).toEqual([
      "PIN",
      "Login ID",
      "Text 1",
      "Text 2",
      "Text 3",
    ]);
    expect(names(6)).toHaveLength(6);
    expect(names(6)[0]).toEqual(["custom-1", "Secret copy"]);
  });

  it("offers at most 16 fields by default", () => {
    const fields = Array.from({ length: 20 }, (_, index) =>
      custom(index, `Field ${index}`, "text"),
    );
    const offers = customFieldOffers([item("item-1", fields)]);
    expect(MAX_CUSTOM_OFFERS).toBe(16);
    expect(offers).toHaveLength(16);
    expect(offers.at(-1)!.slot).toMatchObject({ id: "custom-16", fieldName: "Field 15" });
  });
});
