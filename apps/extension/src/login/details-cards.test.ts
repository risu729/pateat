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
  detailFieldIds,
  detailSecret,
  detailValue,
  givesDetail,
  linkedField,
} from "./details";

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
const card = item("card", "Synthetic card", cardFields.map(builtin));
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
const identity = item("identity", "Synthetic identity", [
  custom(0, "Card PIN", "hidden"),
  custom(1, "Passcode"),
  custom(2, "PIN", "boolean"),
]);
const connection: VaultConnectionMetadata = {
  id: connectionId,
  label: "Synthetic vault",
  provider: "bitwarden",
  userId: "synthetic-user",
  groups: [],
  items: [card, yearless, login, identity],
};
const catalog: VaultCatalog = { connections: [connection] };
const policy = (excludedFields: { itemId: string; fieldId: string }[] = []): LocalSettings => ({
  connections: [
    {
      connectionId,
      enabled: true,
      selection: { mode: "all", groupIds: [], itemIds: [] },
      excludedItemIds: [],
      excludedFields,
    },
  ],
  excludedSites: [],
  siteDefaults: [],
  bindings: [],
});
const link = (detail: DetailLink["detail"], source: DetailLink["source"]): DetailLink => ({
  origin: "https://card.example",
  provider: "bitwarden",
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

  it("reads a PIN from a Text or Hidden field named as one, in any item", () => {
    for (const name of ["PIN", "Card PIN", "pin_1", "PIN番号", "ＰＩＮ", "暗証番号", "Passcode"]) {
      expect(givesDetail("pin", custom(0, name)), name).toBe(true);
      expect(givesDetail("pin", custom(0, name, "hidden")), name).toBe(true);
    }
    for (const name of ["Shipping note", "Spinner", "Pincode", "Password", "Member ID"])
      expect(givesDetail("pin", custom(0, name)), name).toBe(false);
    expect(givesDetail("pin", custom(0, "PIN", "boolean"))).toBe(false);
    expect(givesDetail("pin", builtin("card.code"))).toBe(false);
  });

  it("never reads a field named as a PIN as a member ID", () => {
    for (const name of ["暗証番号", "PIN number", "Card PIN", "Passcode", "PIN番号"])
      expect(givesDetail("member-id", custom(0, name)), name).toBe(false);
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
  });

  it("fills a PIN as its 4 to 12 digits", () => {
    expect(detailValue("pin", undefined, " 0123 ")).toBe("0123");
    expect(detailValue("pin", undefined, "０１２３")).toBe("0123");
    expect(detailValue("pin", undefined, "1".repeat(12))).toBe("1".repeat(12));
    expect(detailValue("pin", undefined, "123")).toBeUndefined();
    expect(detailValue("pin", undefined, "1".repeat(13))).toBeUndefined();
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
    expect(offered("pin")).toEqual(["login/暗証番号", "identity/Card PIN", "identity/Passcode"]);
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

  it("reads a PIN link only from a field named as one", () => {
    const pin = link("pin", { itemId: "identity", field: { custom: "Card PIN" } });
    expect(linkedField(policy(), catalog, connection, pin)).toEqual({
      itemId: "identity",
      fieldId: custom(0, "").id,
      name: "Card PIN",
    });
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
