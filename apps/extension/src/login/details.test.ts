import { describe, expect, it } from "vitest";
import type {
  DetailLink,
  LocalSettings,
  VaultCatalog,
  VaultConnectionMetadata,
  VaultItemMetadata,
} from "@pateat/contracts";
import {
  detailCandidates,
  detailValue,
  givesDetail,
  linkedField,
  readBirthDate,
  savedDetailLink,
} from "./details";

// Synthetic vault data only: no real names, dates or numbers.
const connectionId = "personal";
const snapshot = "60000000-0000-4000-8000-000000000001";
const custom = (index: number, name: string, kind: "text" | "hidden" | "boolean" = "text") => ({
  id: `custom.${snapshot}.${index}`,
  label: name,
  name,
  kind,
});
const builtin = (id: string, label: string, kind: "text" | "hidden" = "text") => ({
  id,
  label,
  name: null,
  kind,
});
const item = (
  id: string,
  label: string,
  fields: VaultItemMetadata["fields"],
  extra: Partial<VaultItemMetadata> = {},
): VaultItemMetadata => ({ id, label, allowedOrigins: [], groupIds: [], fields, ...extra });

const login = item("login", "Synthetic login", [
  builtin("login.username", "Username"),
  builtin("login.password", "Password", "hidden"),
]);
const identity = item("identity", "Synthetic identity", [
  builtin("identity.phone", "Phone"),
  custom(0, "Date of birth"),
  custom(1, "Membership"),
]);
const card = item("card", "Synthetic card", [
  builtin("card.number", "Number", "hidden"),
  builtin("card.code", "Security code", "hidden"),
]);

function vault(
  items: VaultItemMetadata[],
  extra: Partial<VaultConnectionMetadata> = {},
): { catalog: VaultCatalog; connection: VaultConnectionMetadata } {
  const connection: VaultConnectionMetadata = {
    id: connectionId,
    label: "Synthetic vault",
    provider: "bitwarden",
    userId: "synthetic-user",
    groups: [],
    items,
    ...extra,
  };
  return { catalog: { connections: [connection] }, connection };
}
function policy(
  connection: Partial<LocalSettings["connections"][number]> = {},
  extra: Partial<LocalSettings> = {},
): LocalSettings {
  return {
    connections: [
      {
        connectionId,
        enabled: true,
        selection: { mode: "all", groupIds: [], itemIds: [] },
        excludedItemIds: [],
        excludedFields: [],
        ...connection,
      },
    ],
    excludedSites: [],
    siteDefaults: [],
    bindings: [],
    ...extra,
  };
}
const owner = {
  origin: "https://shop.example",
  provider: "bitwarden",
  userId: "synthetic-user",
  itemId: "login",
};
const link = (
  detail: DetailLink["detail"],
  source: DetailLink["source"],
  overrides: Partial<DetailLink> = {},
): DetailLink => ({ ...owner, detail, source, ...overrides });

describe("which vault fields give a personal detail (ADR 0061)", () => {
  it("reads a phone number from the identity's phone or a Text or Hidden custom field", () => {
    expect(givesDetail("phone-last-4", builtin("identity.phone", "Phone"))).toBe(true);
    expect(givesDetail("phone-last-4", custom(0, "Phone"))).toBe(true);
    expect(givesDetail("phone-last-4", custom(0, "Phone", "hidden"))).toBe(true);
    expect(givesDetail("phone-last-4", custom(0, "Phone", "boolean"))).toBe(false);
    expect(givesDetail("phone-last-4", builtin("card.number", "Number"))).toBe(false);
    expect(givesDetail("phone-last-4", builtin("login.password", "Password", "hidden"))).toBe(
      false,
    );
  });

  it("reads a birth date only from a Text or Hidden custom field", () => {
    expect(givesDetail("birth-date", custom(0, "Birthday"))).toBe(true);
    // A birth date kept in a Hidden field may still go into a text input.
    expect(givesDetail("birth-date", custom(0, "Birthday", "hidden"))).toBe(true);
    expect(givesDetail("birth-date", custom(0, "Birthday", "boolean"))).toBe(false);
    expect(givesDetail("birth-date", builtin("identity.phone", "Phone"))).toBe(false);
    expect(givesDetail("birth-date", builtin("login.username", "Username"))).toBe(false);
  });

  it("reads a custom field only when its name says it holds the detail", () => {
    for (const name of ["Mobile phone", "TEL", "電話番号"])
      expect(givesDetail("phone-last-4", custom(0, name))).toBe(true);
    for (const name of ["Date of Birth", "DOB", "生年月日", "お誕生日"])
      expect(givesDetail("birth-date", custom(0, name))).toBe(true);
    // A PIN or another custom field never goes into a page's input as a detail.
    for (const name of ["PIN", "Membership", "Notes"]) {
      expect(givesDetail("phone-last-4", custom(0, name, "hidden"))).toBe(false);
      expect(givesDetail("birth-date", custom(0, name))).toBe(false);
    }
    expect(givesDetail("phone-last-4", custom(0, "Birthday"))).toBe(false);
    expect(givesDetail("birth-date", custom(0, "Phone"))).toBe(false);
    expect(givesDetail("birth-date", { ...custom(0, ""), name: null })).toBe(false);
  });

  it("reads a card's digits only from the card's own fields", () => {
    expect(givesDetail("card-last-4", builtin("card.number", "Number"))).toBe(true);
    expect(givesDetail("card-last-4", builtin("card.code", "Code"))).toBe(false);
    expect(givesDetail("card-last-4", custom(0, "Card number"))).toBe(false);
    expect(givesDetail("card-code", builtin("card.code", "Code"))).toBe(true);
    expect(givesDetail("card-code", builtin("card.number", "Number"))).toBe(false);
    expect(givesDetail("card-code", custom(0, "CVC", "hidden"))).toBe(false);
  });
});

describe("reading a stored birth date (ADR 0061)", () => {
  it.each([
    "1990-04-01",
    "1990/4/1",
    "1990.04.01",
    "1990年4月1日",
    "19900401",
    " 1990-04-01 ",
    // Full-width text reads as its NFKC form.
    "１９９０年４月１日",
    "１９９０－０４－０１",
  ])("reads %j as year, month and day", (value) => {
    expect(readBirthDate(value)).toEqual({ year: 1990, month: 4, day: 1 });
  });

  it.each([
    "",
    "April 1, 1990",
    "01/04/1990",
    "90-04-01",
    "1990-04",
    "199004",
    "1990-04-01T00:00",
    "1990-4/1x",
    // Dates that do not exist.
    "1990-02-30",
    "1990-13-01",
    "1990-00-10",
    "19900230",
    "1990年2月30日",
  ])("reads %j as no date", (value) => {
    expect(readBirthDate(value)).toBeUndefined();
  });

  it("reads a leap day only in a leap year", () => {
    expect(readBirthDate("2000-02-29")).toEqual({ year: 2000, month: 2, day: 29 });
    expect(readBirthDate("1900-02-29")).toBeUndefined();
  });
});

describe("the value a page's input asks for (ADR 0061)", () => {
  it.each([
    ["yyyymmdd", "19900401"],
    ["yyyymm", "199004"],
    ["yyyy-mm-dd", "1990-04-01"],
    ["yyyy/mm/dd", "1990/04/01"],
    ["mmdd", "0401"],
  ] as const)("writes a birth date as %s", (format, expected) => {
    expect(detailValue("birth-date", format, "1990/4/1")).toBe(expected);
    expect(detailValue("birth-date", format, "1990年4月1日")).toBe(expected);
  });

  it("makes no birth date from text that is no date, or without a format", () => {
    expect(detailValue("birth-date", "yyyymm", "spring of 1990")).toBeUndefined();
    expect(detailValue("birth-date", "yyyymm", "1990-02-30")).toBeUndefined();
    expect(detailValue("birth-date", undefined, "1990-04-01")).toBeUndefined();
  });

  it("takes the last four digits of a phone or card number", () => {
    expect(detailValue("phone-last-4", undefined, "+81 90-0000-1234")).toBe("1234");
    expect(detailValue("phone-last-4", undefined, "０９０（００００）５６７８")).toBe("5678");
    expect(detailValue("phone-last-4", undefined, "1234")).toBe("1234");
    expect(detailValue("card-last-4", undefined, "4000 0000 0000 0002")).toBe("0002");
    // A format is for a birth date only.
    expect(detailValue("card-last-4", "yyyymm", "4000000000000002")).toBe("0002");
  });

  it("makes no last four digits from fewer than four digits", () => {
    expect(detailValue("phone-last-4", undefined, "123")).toBeUndefined();
    expect(detailValue("phone-last-4", undefined, "ext. 12-3")).toBeUndefined();
    expect(detailValue("card-last-4", undefined, "")).toBeUndefined();
  });

  it("keeps a card code of 3 or 4 digits as it is", () => {
    expect(detailValue("card-code", undefined, "012")).toBe("012");
    expect(detailValue("card-code", undefined, "0123")).toBe("0123");
    expect(detailValue("card-code", undefined, " ０１２ ")).toBe("012");
  });

  it.each(["", "12", "01234", "abc"])("makes no card code from %j", (value) => {
    expect(detailValue("card-code", undefined, value)).toBeUndefined();
  });
});

describe("the owner's saved link for a login item (ADR 0061)", () => {
  const birth = link("birth-date", { itemId: "identity", field: { custom: "Date of birth" } });
  const phone = link("phone-last-4", { itemId: "identity", field: "identity.phone" });

  it("finds the link of the item's site and detail", () => {
    const settings = { detailLinks: [phone, birth] };
    expect(savedDetailLink(settings, owner, "birth-date")).toBe(birth);
    expect(savedDetailLink(settings, owner, "phone-last-4")).toBe(phone);
    expect(savedDetailLink(settings, owner, "card-code")).toBeUndefined();
  });

  it.each([
    ["another site", { origin: "https://other.example" }],
    ["another provider", { provider: "other" }],
    ["another vault account", { userId: "other-user" }],
    ["another login item", { itemId: "other-login" }],
  ])("finds no link saved for %s", (_label, overrides) => {
    expect(
      savedDetailLink({ detailLinks: [birth] }, { ...owner, ...overrides }, "birth-date"),
    ).toBe(undefined);
  });

  it("finds none in settings without links", () => {
    expect(savedDetailLink({}, owner, "birth-date")).toBeUndefined();
  });
});

describe("the live field a link reads (ADR 0061)", () => {
  const { catalog, connection } = vault([login, identity, card]);

  it("resolves a built-in field and a custom field by name", () => {
    expect(
      linkedField(policy(), catalog, connection, {
        detail: "phone-last-4",
        itemId: "login",
        source: { itemId: "identity", field: "identity.phone" },
      }),
    ).toEqual({ itemId: "identity", fieldId: "identity.phone", name: null });
    expect(
      linkedField(policy(), catalog, connection, {
        detail: "birth-date",
        itemId: "login",
        source: { itemId: "identity", field: { custom: "Date of birth" } },
      }),
    ).toEqual({
      itemId: "identity",
      fieldId: `custom.${snapshot}.0`,
      name: "Date of birth",
    });
    expect(
      linkedField(policy(), catalog, connection, {
        detail: "card-code",
        itemId: "login",
        source: { itemId: "card", field: "card.code" },
      }),
    ).toEqual({ itemId: "card", fieldId: "card.code", name: null });
  });

  it("reads an item with no URIs, as a linked item has none", () => {
    expect(identity.allowedOrigins).toEqual([]);
    expect(
      linkedField(policy(), catalog, connection, {
        detail: "card-last-4",
        itemId: "login",
        source: { itemId: "card", field: "card.number" },
      }),
    ).toEqual({ itemId: "card", fieldId: "card.number", name: null });
  });

  it("picks one of several custom fields of a name by its position", () => {
    const twice = item("twice", "Synthetic twice", [custom(0, "Birthday"), custom(1, "Birthday")]);
    const live = vault([twice]);
    const at = (field: Exclude<DetailLink["source"]["field"], string>) =>
      linkedField(policy(), live.catalog, live.connection, {
        detail: "birth-date",
        itemId: "login",
        source: { itemId: "twice", field },
      });
    expect(at({ custom: "Birthday", position: 2, count: 2 })).toEqual({
      itemId: "twice",
      fieldId: `custom.${snapshot}.1`,
      name: "Birthday",
    });
    // Without a position the name is ambiguous, and with another count it needs review.
    expect(at({ custom: "Birthday" })).toBeUndefined();
    expect(at({ custom: "Birthday", position: 1, count: 3 })).toBeUndefined();
  });

  it.each([
    ["an item no longer in the vault", { itemId: "gone", field: "identity.phone" as const }],
    ["a field the item lacks", { itemId: "card", field: "identity.phone" as const }],
    ["a custom field the item lacks", { itemId: "identity", field: { custom: "Phone" } }],
  ])("reads nothing from %s", (_label, source) => {
    expect(
      linkedField(policy(), catalog, connection, {
        detail: "phone-last-4",
        itemId: "login",
        source,
      }),
    ).toBeUndefined();
  });

  it("reads nothing from a field that cannot give the detail", () => {
    // Its name does not say it holds a birth date.
    expect(
      linkedField(policy(), catalog, connection, {
        detail: "birth-date",
        itemId: "login",
        source: { itemId: "identity", field: { custom: "Membership" } },
      }),
    ).toBeUndefined();
    expect(
      linkedField(policy(), catalog, connection, {
        detail: "card-code",
        itemId: "login",
        source: { itemId: "card", field: "card.number" },
      }),
    ).toBeUndefined();
    const flagged = vault([item("flags", "Synthetic flags", [custom(0, "Birthday", "boolean")])]);
    expect(
      linkedField(policy(), flagged.catalog, flagged.connection, {
        detail: "birth-date",
        itemId: "login",
        source: { itemId: "flags", field: { custom: "Birthday" } },
      }),
    ).toBeUndefined();
  });

  it.each([
    ["in the trash or archived", vault([item("card", "Card", card.fields, { inactive: true })])],
    ["quarantined", vault([card], { quarantinedItemIds: ["card"] })],
  ])("reads nothing from an item %s", (_label, live) => {
    expect(
      linkedField(policy(), live.catalog, live.connection, {
        detail: "card-code",
        itemId: "login",
        source: { itemId: "card", field: "card.code" },
      }),
    ).toBeUndefined();
  });

  it.each([
    ["excluded", policy({ excludedItemIds: ["card"] })],
    ["not selected", policy({ selection: { mode: "selected", groupIds: [], itemIds: ["login"] } })],
    ["in a disabled connection", policy({ enabled: false })],
    [
      "whose field is excluded",
      policy({ excludedFields: [{ itemId: "card", fieldId: "card.code" }] }),
    ],
  ])("reads nothing from an item %s", (_label, settings) => {
    expect(
      linkedField(settings, catalog, connection, {
        detail: "card-code",
        itemId: "login",
        source: { itemId: "card", field: "card.code" },
      }),
    ).toBeUndefined();
  });

  it("reads another field of an item one of whose fields is excluded", () => {
    expect(
      linkedField(
        policy({ excludedFields: [{ itemId: "card", fieldId: "card.code" }] }),
        catalog,
        connection,
        {
          detail: "card-last-4",
          itemId: "login",
          source: { itemId: "card", field: "card.number" },
        },
      ),
    ).toEqual({ itemId: "card", fieldId: "card.number", name: null });
  });
});

describe("the fields the popup proposes for a detail (ADR 0061)", () => {
  const page = { host: "www.shop.example", loginItemId: "login" };
  const ids = (found: { itemId: string; fieldId: string }[]) =>
    found.map((entry) => `${entry.itemId} ${entry.fieldId}`);

  it("lists custom fields whose name reads as a birth date, in any case", () => {
    const people = item("people", "Synthetic people", [
      custom(0, "Date of BIRTH"),
      custom(1, "DOB", "hidden"),
      custom(2, "生年月日"),
      custom(3, "お誕生日"),
      custom(4, "Anniversary"),
      custom(5, "birthday flag", "boolean"),
    ]);
    const { catalog, connection } = vault([login, people]);
    const found = detailCandidates(policy(), catalog, connection, "birth-date", page);
    expect(ids(found)).toEqual([0, 1, 2, 3].map((index) => `people custom.${snapshot}.${index}`));
    expect(found[0]).toEqual({
      connectionId,
      itemId: "people",
      fieldId: `custom.${snapshot}.0`,
      itemLabel: "Synthetic people",
      fieldLabel: "Date of BIRTH",
    });
  });

  it("lists identity phones and custom fields named as a phone for a phone number", () => {
    const other = item("other", "Synthetic other", [
      custom(0, "Mobile phone"),
      custom(1, "Tel"),
      custom(2, "電話番号"),
      custom(3, "Notes"),
    ]);
    const { catalog, connection } = vault([login, identity, other]);
    expect(ids(detailCandidates(policy(), catalog, connection, "phone-last-4", page))).toEqual([
      "identity identity.phone",
      `other custom.${snapshot}.0`,
      `other custom.${snapshot}.1`,
      `other custom.${snapshot}.2`,
    ]);
  });

  it("lists card numbers for their last digits and card codes for a code", () => {
    const { catalog, connection } = vault([login, identity, card]);
    expect(ids(detailCandidates(policy(), catalog, connection, "card-last-4", page))).toEqual([
      "card card.number",
    ]);
    expect(ids(detailCandidates(policy(), catalog, connection, "card-code", page))).toEqual([
      "card card.code",
    ]);
  });

  it("leaves out items and fields the device may not use", () => {
    const trashed = item("trashed", "Trashed card", card.fields, { inactive: true });
    const held = item("held", "Held card", card.fields);
    const skipped = item("skipped", "Skipped card", card.fields);
    const partly = item("partly", "Partly card", card.fields);
    const { catalog, connection } = vault([card, trashed, held, skipped, partly], {
      quarantinedItemIds: ["held"],
    });
    const settings = policy({
      excludedItemIds: ["skipped"],
      excludedFields: [{ itemId: "partly", fieldId: "card.code" }],
    });
    expect(ids(detailCandidates(settings, catalog, connection, "card-code", page))).toEqual([
      "card card.code",
    ]);
    expect(ids(detailCandidates(settings, catalog, connection, "card-last-4", page))).toEqual([
      "card card.number",
      "partly card.number",
    ]);
  });

  it("puts first an item whose name shares a word of three or more letters with the host", () => {
    const plain = item("plain", "Synthetic card", card.fields);
    const named = item("named", "SHOP カード", card.fields);
    const short = item("short", "Ex card", card.fields);
    const { catalog, connection } = vault([plain, short, named]);
    expect(ids(detailCandidates(policy(), catalog, connection, "card-code", page))).toEqual([
      "named card.code",
      "plain card.code",
      "short card.code",
    ]);
  });

  it("puts first an item whose whole name is in the page's title", () => {
    const plain = item("plain", "Synthetic card", card.fields);
    const titled = item("titled", "ゴールドカード", card.fields);
    const { catalog, connection } = vault([plain, titled]);
    const found = (title: string | undefined) =>
      ids(
        detailCandidates(policy(), catalog, connection, "card-code", {
          host: "www.example.jp",
          title,
          loginItemId: "login",
        }),
      );
    expect(found("ログイン | ゴールドカード会員")).toEqual(["titled card.code", "plain card.code"]);
    // Part of the name is not enough.
    expect(found("ゴールド会員")).toEqual(["plain card.code", "titled card.code"]);
    expect(found(undefined)).toEqual(["plain card.code", "titled card.code"]);
  });

  it("lists at most 20 fields", () => {
    const cards = Array.from({ length: 25 }, (_, index) =>
      item(`card-${index}`, `Synthetic card ${index}`, card.fields),
    );
    const { catalog, connection } = vault(cards);
    const found = detailCandidates(policy(), catalog, connection, "card-code", page);
    expect(found).toHaveLength(20);
    expect(found[0]!.itemId).toBe("card-0");
    expect(found.at(-1)!.itemId).toBe("card-19");
    // A caller may ask for another bound, as the popup's fill checks every field.
    expect(detailCandidates(policy(), catalog, connection, "card-code", page, 3)).toHaveLength(3);
    expect(
      detailCandidates(policy(), catalog, connection, "card-code", page, Infinity),
    ).toHaveLength(25);
  });

  it("lists nothing when no field could give the detail", () => {
    const { catalog, connection } = vault([login]);
    expect(detailCandidates(policy(), catalog, connection, "birth-date", page)).toEqual([]);
  });
});
