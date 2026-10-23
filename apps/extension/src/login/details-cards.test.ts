import { describe, expect, it } from "vitest";
import type {
  DetailLink,
  LocalSettings,
  VaultCatalog,
  VaultConnectionMetadata,
  VaultItemMetadata,
} from "@pateat/contracts";
import {
  cardGuessFields,
  cardLast4,
  rankCards,
  type CardFacts,
  detailCandidates,
  detailFieldIds,
  detailFieldValues,
  detailSecret,
  detailValue,
  givesDetail,
  linkedField,
} from "./details";
import { connectionPolicy } from "../connections/__fixtures__/policy";

// Whole card numbers, card expiry dates and PINs (ADR 0061, owner 2026-10-23 11:41 UTC).
// Synthetic vault data only.
const connectionId = "personal";
const snapshot = "60000000-0000-4000-8000-000000000003";
const custom = (index: number, name: string, kind: "text" | "hidden" | "boolean" = "text") => ({
  id: `custom.${snapshot}.${index}`,
  label: name,
  name,
  kind,
});
const builtin = (id: string) => ({
  id,
  label: id.split(".")[1]!,
  name: null,
  kind: "text" as const,
});
const item = (
  id: string,
  label: string,
  fields: VaultItemMetadata["fields"],
): VaultItemMetadata => ({
  id,
  label,
  allowedOrigins: [],
  groupIds: [],
  fields,
});
const cardFields = ["card.number", "card.expMonth", "card.expYear", "card.code"];
const card = item("card", "Synthetic card", [
  ...cardFields.map(builtin),
  custom(0, "Card PIN", "hidden"),
]);
// A card whose year is missing gives no expiry date.
const yearless = item(
  "yearless",
  "Synthetic yearless card",
  ["card.number", "card.expMonth"].map(builtin),
);
const login = item("login", "Synthetic login", [
  { id: "login.username", label: "Username", name: null, kind: "text" },
  custom(0, "暗証番号", "hidden"),
  custom(1, "Shipping note"),
  custom(2, "会員番号"),
]);
// A PIN is a credential of one account: never read from an identity or another login.
const identity = item("identity", "Synthetic identity", [
  custom(0, "Card PIN", "hidden"),
  custom(1, "Passcode"),
  custom(2, "PIN", "boolean"),
  builtin("identity.phone"),
]);
const otherLogin = item("other-login", "Synthetic other login", [
  { id: "login.password", label: "Password", name: null, kind: "hidden" },
  custom(0, "PIN", "hidden"),
]);
const connection: VaultConnectionMetadata = {
  id: connectionId,
  label: "Synthetic vault",
  provider: "bitwarden",
  server: "cloud-us",
  userId: "synthetic-user",
  groups: [],
  items: [card, yearless, login, identity, otherLogin],
};
const catalog: VaultCatalog = { connections: [connection] };
const policy = (excludedFields: { itemId: string; fieldId: string }[] = []): LocalSettings => ({
  connections: [{ connectionId, enabled: true }],
  ...connectionPolicy(connection, { excludedFields }),
  excludedSites: [],
  repromptSites: [],
  passkeyBrowserSites: [],
  siteDefaults: [],
  bindings: [],
});
const link = (detail: DetailLink["detail"], source: DetailLink["source"]): DetailLink => ({
  origin: "https://card.example",
  provider: "bitwarden",
  server: "cloud-us",
  userId: "synthetic-user",
  itemId: "login",
  detail,
  source,
});
const page = { host: "card.example", loginItemId: "login" };
const offered = (detail: DetailLink["detail"], settings = policy()) =>
  detailCandidates(settings, catalog, connection, detail, page).map(
    (entry) => `${entry.itemId}/${entry.fieldLabel}`,
  );

describe("which fields give a card's number, its expiry date or a PIN", () => {
  it("reads a card's number and expiry month only from the card's own fields", () => {
    expect(givesDetail("card-number", builtin("card.number"))).toBe(true);
    expect(givesDetail("card-number", builtin("card.code"))).toBe(false);
    expect(givesDetail("card-number", custom(0, "Card number"))).toBe(false);
    expect(givesDetail("card-expiry", builtin("card.expMonth"))).toBe(true);
    expect(givesDetail("card-expiry", builtin("card.expYear"))).toBe(false);
    expect(givesDetail("card-expiry", custom(0, "Expiry"))).toBe(false);
    expect(detailFieldIds("card-expiry", "card.expMonth")).toEqual([
      "card.expMonth",
      "card.expYear",
    ]);
    expect(detailFieldIds("card-number", "card.number")).toEqual(["card.number"]);
  });

  it("reads a PIN from a Text or Hidden field named as one", () => {
    for (const name of ["PIN", "Card PIN", "pin_1", "PIN番号", "ＰＩＮ", "暗証番号", "Passcode"]) {
      expect(givesDetail("pin", custom(0, name)), name).toBe(true);
      expect(givesDetail("pin", custom(0, name, "hidden")), name).toBe(true);
    }
    for (const name of ["Shipping note", "Spinner", "Pincode", "Password", "Member ID"])
      expect(givesDetail("pin", custom(0, name)), name).toBe(false);
    expect(givesDetail("pin", custom(0, "PIN", "boolean"))).toBe(false);
    expect(givesDetail("pin", builtin("card.code"))).toBe(false);
  });

  it("never reads a field named as a PIN as a member ID, a birth date or a phone number", () => {
    for (const name of ["暗証番号", "PIN number", "Card PIN", "Passcode", "PIN番号"])
      expect(givesDetail("member-id", custom(0, name)), name).toBe(false);
    for (const name of ["Phone PIN", "電話暗証番号", "Telephone passcode"])
      expect(givesDetail("phone-last-4", custom(0, name)), name).toBe(false);
    for (const name of ["Birth PIN", "生年月日の暗証番号", "DOB passcode"])
      expect(givesDetail("birth-date", custom(0, name)), name).toBe(false);
    // Fields named only as a phone or a birth date still give them.
    expect(givesDetail("phone-last-4", custom(0, "Phone"))).toBe(true);
    expect(givesDetail("birth-date", custom(0, "生年月日"))).toBe(true);
  });
});

describe("the values made for a card or a PIN", () => {
  it("fills a card's whole number as its 12 to 19 digits", () => {
    expect(detailValue("card-number", undefined, "4000 0000 0000 0002")).toBe("4000000000000002");
    expect(detailValue("card-number", undefined, "４０００-００００-００００-０００２")).toBe(
      "4000000000000002",
    );
    expect(detailValue("card-number", undefined, "1".repeat(12))).toBe("1".repeat(12));
    expect(detailValue("card-number", undefined, "1".repeat(19))).toBe("1".repeat(19));
    expect(detailValue("card-number", undefined, "1".repeat(11))).toBeUndefined();
    expect(detailValue("card-number", undefined, "1".repeat(20))).toBeUndefined();
    expect(detailValue("card-number", undefined, "")).toBeUndefined();
    // Only digits, perhaps grouped by spaces or hyphens: any other text is no value.
    for (const value of [
      "4000 0000 0000 000x",
      "4000/0000/0000/0002",
      "Card 4000000000000002",
      "4000000000000002 (old 4000000000000010)",
      "-4000000000000002",
    ])
      expect(detailValue("card-number", undefined, value), value).toBeUndefined();
  });

  it("fills a PIN as its 4 to 12 digits", () => {
    expect(detailValue("pin", undefined, " 0123 ")).toBe("0123");
    expect(detailValue("pin", undefined, "０１２３")).toBe("0123");
    expect(detailValue("pin", undefined, "1".repeat(12))).toBe("1".repeat(12));
    expect(detailValue("pin", undefined, "123")).toBeUndefined();
    expect(detailValue("pin", undefined, "1".repeat(13))).toBeUndefined();
    expect(detailValue("pin", undefined, "01-23")).toBe("0123");
    expect(detailValue("pin", undefined, "０１ ２３")).toBe("0123");
    for (const value of ["12ab34", "PIN 1234 (old 5678)", "1234.", "12_34", "#1234"])
      expect(detailValue("pin", undefined, value), value).toBeUndefined();
  });

  it("writes a card's expiry month and year in the input's format", () => {
    expect(detailValue("card-expiry", "mmyy", "4", "2031")).toBe("0431");
    expect(detailValue("card-expiry", "mm/yy", "04", "31")).toBe("04/31");
    expect(detailValue("card-expiry", "mmyyyy", "12", "31")).toBe("122031");
    expect(detailValue("card-expiry", "mm/yyyy", "１", "２０３１")).toBe("01/2031");
  });

  it("makes no expiry date from a month or year that is not one, or without both", () => {
    for (const [month, year] of [
      ["0", "2031"],
      ["13", "2031"],
      ["", "2031"],
      ["4", ""],
      ["4", "231"],
      ["4", "20311"],
      ["April", "2031"],
    ])
      expect(detailValue("card-expiry", "mmyy", month!, year), `${month} ${year}`).toBeUndefined();
    expect(detailValue("card-expiry", "mmyy", "4")).toBeUndefined();
    expect(detailValue("card-expiry", undefined, "4", "2031")).toBeUndefined();
    // A birth date's format writes no expiry date, and an expiry's no birth date.
    expect(detailValue("card-expiry", "yyyymm", "4", "2031")).toBeUndefined();
    expect(detailValue("birth-date", "mmyy", "1990-04-01")).toBeUndefined();
  });

  it("fills a card number and a PIN under their own input rules", () => {
    expect(detailSecret("card-number")).toBe("card-number");
    expect(detailSecret("pin")).toBe("pin");
    expect(detailSecret("card-code")).toBe("card-code");
    expect(detailSecret("card-expiry")).toBe("detail");
    expect(detailSecret("birth-date")).toBe("detail");
  });
});

describe("links to card values and PINs", () => {
  it("offers card items for a card's number and expiry date, and fields named as PINs", () => {
    expect(offered("card-number")).toEqual(["card/number", "yearless/number"]);
    // A card without a year gives no expiry date; the popup names both fields.
    expect(offered("card-expiry")).toEqual(["card/expMonth / expYear"]);
    // A PIN only from the login item or a card item, never an identity or another login.
    expect(offered("pin")).toEqual(["card/Card PIN", "login/暗証番号"]);
  });

  it("needs the card's year allowed too for its expiry date", () => {
    const yearExcluded = policy([{ itemId: "card", fieldId: "card.expYear" }]);
    expect(offered("card-expiry", yearExcluded)).toEqual([]);
    const expiry = link("card-expiry", { itemId: "card", field: "card.expMonth" });
    expect(linkedField(policy(), catalog, connection, expiry)).toEqual({
      itemId: "card",
      fieldId: "card.expMonth",
      name: null,
    });
    expect(linkedField(yearExcluded, catalog, connection, expiry)).toBeUndefined();
    expect(
      linkedField(policy(), catalog, connection, {
        ...expiry,
        source: { itemId: "yearless", field: "card.expMonth" },
      }),
    ).toBeUndefined();
  });

  it("reads a PIN link only from a field named as one, of the login item or a card", () => {
    const pin = link("pin", { itemId: "card", field: { custom: "Card PIN" } });
    expect(linkedField(policy(), catalog, connection, pin)).toEqual({
      itemId: "card",
      fieldId: custom(0, "").id,
      name: "Card PIN",
    });
    expect(
      linkedField(policy(), catalog, connection, {
        ...pin,
        source: { itemId: "login", field: { custom: "暗証番号" } },
      }),
    ).toEqual({ itemId: "login", fieldId: custom(0, "").id, name: "暗証番号" });
    for (const source of [
      { itemId: "identity", field: { custom: "Card PIN" } },
      { itemId: "other-login", field: { custom: "PIN" } },
    ])
      expect(linkedField(policy(), catalog, connection, { ...pin, source }), source.itemId).toBe(
        undefined,
      );
    // An identity still gives a phone number.
    expect(
      linkedField(
        policy(),
        catalog,
        connection,
        link("phone-last-4", { itemId: "identity", field: "identity.phone" }),
      ),
    ).toEqual({ itemId: "identity", fieldId: "identity.phone", name: null });
    expect(
      linkedField(policy(), catalog, connection, {
        ...pin,
        source: { itemId: "login", field: { custom: "会員番号" } },
      }),
    ).toBeUndefined();
    // A card number link never reads the card's code.
    expect(
      linkedField(
        policy(),
        catalog,
        connection,
        link("card-number", { itemId: "card", field: "card.code" }),
      ),
    ).toBeUndefined();
  });
});

describe("values split over several inputs (owner, 2026-10-23 12:26 UTC)", () => {
  const at = (value: string) => ({ by: "name" as const, value });
  const birth = (
    ...parts: [part: "year" | "month" | "day", format: "yyyy" | "mm" | "m" | "dd" | "d"][]
  ) => ({
    detail: "birth-date" as const,
    parts: parts.map(([part, format]) => ({ part, format, target: at(part) })),
  });
  const groups = (detail: "card-number" | "pin", ...lengths: number[]) => ({
    detail,
    parts: lengths.map((length, index) => ({ part: index + 1, length, target: at(`g${index}`) })),
  });
  const values = (made: { value: string }[] | "unfit" | undefined) =>
    typeof made === "string" ? made : made?.map((entry) => entry.value);

  it("makes a birth date's year, month and day in each part's format", () => {
    const full = birth(["year", "yyyy"], ["month", "mm"], ["day", "dd"]);
    expect(detailFieldValues(full, "1990-04-05")).toEqual([
      { value: "1990", secret: "date-part", part: "year" },
      { value: "04", secret: "date-part", part: "month" },
      { value: "05", secret: "date-part", part: "day" },
    ]);
    expect(
      values(detailFieldValues(birth(["year", "yyyy"], ["month", "m"], ["day", "d"]), "1990/4/5")),
    ).toEqual(["1990", "4", "5"]);
    expect(
      values(detailFieldValues(birth(["year", "yyyy"], ["month", "m"]), "1990年4月5日")),
    ).toEqual(["1990", "4"]);
    expect(values(detailFieldValues(birth(["month", "mm"], ["day", "d"]), "19901205"))).toEqual([
      "12",
      "5",
    ]);
    // A value that is no date gives none of the parts.
    expect(detailFieldValues(full, "1990-02-30")).toBeUndefined();
    expect(detailFieldValues(full, "April 1990")).toBeUndefined();
  });

  it("makes a card expiry's month and its year with two or four digits", () => {
    const expiry = (year: "yy" | "yyyy", month: "mm" | "m") => ({
      detail: "card-expiry" as const,
      parts: [
        { part: "month" as const, format: month, target: at("month") },
        { part: "year" as const, format: year, target: at("year") },
      ],
    });
    // Only a card expiry year may be matched with the other number of digits in a select.
    expect(detailFieldValues(expiry("yy", "mm"), "4", "2031")).toEqual([
      { value: "04", secret: "date-part", part: "month" },
      { value: "31", secret: "date-part", part: "year", shortYear: true },
    ]);
    expect(values(detailFieldValues(expiry("yyyy", "m"), "１２", "31"))).toEqual(["12", "2031"]);
    expect(detailFieldValues(expiry("yy", "mm"), "13", "2031")).toBeUndefined();
    expect(detailFieldValues(expiry("yy", "mm"), "4")).toBeUndefined();
  });

  it("cuts a card number's or a PIN's digits into its groups, which must hold all of them", () => {
    expect(detailFieldValues(groups("card-number", 4, 4, 4, 4), "4000 0000 0000 0002")).toEqual(
      ["4000", "0000", "0000", "0002"].map((value) => ({
        value,
        secret: "card-number",
        group: 4,
      })),
    );
    expect(values(detailFieldValues(groups("card-number", 4, 6, 5), "3400-000000-00009"))).toEqual([
      "3400",
      "000000",
      "00009",
    ]);
    expect(detailFieldValues(groups("pin", 2, 2), "０１２３")).toEqual([
      { value: "01", secret: "pin", group: 2 },
      { value: "23", secret: "pin", group: 2 },
    ]);
    // The last group may hold fewer digits than its input allows, as a last box of 7 for
    // card numbers of 16 to 19 digits; it still goes only into an input of its length.
    expect(detailFieldValues(groups("card-number", 4, 4, 4, 7), "4000 0000 0000 0002")).toEqual([
      { value: "4000", secret: "card-number", group: 4 },
      { value: "0000", secret: "card-number", group: 4 },
      { value: "0000", secret: "card-number", group: 4 },
      { value: "0002", secret: "card-number", group: 7 },
    ]);
    expect(
      values(detailFieldValues(groups("card-number", 4, 4, 4, 7), "4000 0000 0000 0000 006")),
    ).toEqual(["4000", "0000", "0000", "0000006"]);
    // Too few digits for the groups before the last, or too many for the last, fill none
    // of them, and say the value does not fit.
    expect(detailFieldValues(groups("card-number", 4, 4, 4), "4000 0000 0000 0002")).toBe("unfit");
    expect(detailFieldValues(groups("card-number", 4, 4, 4, 4, 4), "4000 0000 0000 0002")).toBe(
      "unfit",
    );
    expect(detailFieldValues(groups("pin", 2, 2), "12345")).toBe("unfit");
    expect(detailFieldValues(groups("pin", 1, 1, 1, 1), "12345")).toBe("unfit");
    // A PIN too short to be one is unreadable, whatever its groups.
    expect(detailFieldValues(groups("pin", 1, 1, 1, 1), "123")).toBeUndefined();
  });

  it("makes one input's value as before, and never a secret question's answer", () => {
    expect(
      detailFieldValues({ detail: "birth-date", format: "yyyymm", target: at("b") }, "1990-04-05"),
    ).toEqual([{ value: "199004", secret: "detail" }]);
    expect(detailFieldValues({ detail: "pin", target: at("p") }, "0123")).toEqual([
      { value: "0123", secret: "pin" },
    ]);
    expect(
      detailFieldValues({ detail: "secret-answer", target: at("a") }, "synthetic answer"),
    ).toBeUndefined();
  });
});

describe("the popup's guess of a card (owner 2026-10-23 12:26 UTC)", () => {
  const candidates = ["one", "two", "three"].map((itemId) => ({ itemId }));
  const order = (result: { candidates: { itemId: string }[]; preselect: boolean }) => [
    result.candidates.map((entry) => entry.itemId),
    result.preselect,
  ];
  const facts = new Map<string, CardFacts>([
    ["one", { last4: "1111", brand: "Visa" }],
    ["two", { last4: "9876", brand: "Mastercard" }],
    ["three", { last4: "9876", brand: "Visa" }],
  ]);

  it("puts the one card ending in the shown digits first and selects it", () => {
    expect(order(rankCards(candidates, facts, { last4: ["1111"], brands: [] }))).toEqual([
      ["one", "two", "three"],
      true,
    ]);
    expect(
      order(rankCards(candidates.slice(0, 2).reverse(), facts, { last4: ["1111"], brands: [] })),
    ).toEqual([["one", "two"], true]);
  });

  it("never selects one of two cards ending in the same digits, unless only one has the brand", () => {
    expect(order(rankCards(candidates, facts, { last4: ["9876"], brands: [] }))).toEqual([
      ["two", "three", "one"],
      false,
    ]);
    expect(order(rankCards(candidates, facts, { last4: ["9876"], brands: ["Visa"] }))).toEqual([
      ["three", "one", "two"],
      true,
    ]);
    // Two shown runs that each match a card are a tie too.
    expect(
      order(rankCards(candidates.slice(0, 2), facts, { last4: ["1111", "9876"], brands: [] })),
    ).toEqual([["one", "two"], false]);
  });

  it("takes the only card of a shown brand when no digits match, and keeps the name order otherwise", () => {
    expect(order(rankCards(candidates, facts, { last4: [], brands: ["Mastercard"] }))).toEqual([
      ["two", "one", "three"],
      true,
    ]);
    // Two Visa cards: the order by name stays.
    expect(order(rankCards(candidates, facts, { last4: [], brands: ["Visa"] }))).toEqual([
      ["one", "two", "three"],
      true,
    ]);
    // A page that names several brands, as a list of accepted cards does, names none.
    expect(
      order(rankCards(candidates, facts, { last4: [], brands: ["Mastercard", "Visa"] })),
    ).toEqual([["one", "two", "three"], true]);
  });

  it("selects none when the page shows last digits no card ends in", () => {
    // A card whose known digits differ from the shown ones is not the page's card.
    expect(
      order(rankCards(candidates, facts, { last4: ["5555"], brands: ["Mastercard"] })),
    ).toEqual([["one", "two", "three"], false]);
    // Cards whose digits are unknown, as one without a number, come first, the brand's first.
    const partly = new Map<string, CardFacts>([
      ["one", { last4: "1111" }],
      ["two", { brand: "Visa" }],
      ["three", { brand: "Mastercard" }],
    ]);
    expect(
      order(rankCards(candidates, partly, { last4: ["5555"], brands: ["Mastercard"] })),
    ).toEqual([["three", "two", "one"], false]);
  });

  it("selects none while a candidate was not read", () => {
    const some = new Map<string, CardFacts>([
      ["one", { last4: "1111" }],
      ["two", { last4: "9876" }],
    ]);
    expect(order(rankCards(candidates, some, { last4: ["1111"], brands: [] }))).toEqual([
      ["one", "two", "three"],
      false,
    ]);
  });

  it("reads only a card's number and brand, while the item and the field are allowed", () => {
    const branded = item("branded", "Synthetic branded card", [
      ...cardFields.map(builtin),
      builtin("card.brand"),
    ]);
    const withBrand = { ...connection, items: [...connection.items, branded] };
    const all = { connections: [withBrand] };
    expect(cardGuessFields(policy(), all, withBrand, "branded")).toEqual([
      "card.number",
      "card.brand",
    ]);
    expect(cardGuessFields(policy(), all, withBrand, "card")).toEqual(["card.number"]);
    expect(
      cardGuessFields(
        policy([{ itemId: "branded", fieldId: "card.number" }]),
        all,
        withBrand,
        "branded",
      ),
    ).toEqual(["card.brand"]);
    const excluded = {
      ...policy(),
      ...connectionPolicy(withBrand, { excludedItemIds: ["branded"] }),
    };
    expect(cardGuessFields(excluded, all, withBrand, "branded")).toEqual([]);
    expect(cardGuessFields(policy(), all, withBrand, "login")).toEqual([]);
    expect(cardGuessFields(policy(), all, withBrand, "missing")).toEqual([]);
  });

  it("compares a card number by its last four digits", () => {
    expect(cardLast4("4242 4242 4242 7351")).toBe("7351");
    expect(cardLast4("４２４２-７３５１")).toBe("7351");
    expect(cardLast4("735")).toBeUndefined();
  });
});
