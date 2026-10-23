import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  createDefaultSettings,
  detailFormatFits,
  localSettingsSchema,
  questionText,
  type DetailLink,
} from "./settings";

// One link per site, login item and detail, except a secret question's answer, which has
// one per question field (ADR 0061). Synthetic references only.
const link = (detail: DetailLink["detail"], custom: string): DetailLink => ({
  origin: "https://bank.example",
  provider: "bitwarden",
  userId: "synthetic-user",
  itemId: "login",
  detail,
  source: { itemId: "login", field: { custom } },
});
const valid = (detailLinks: DetailLink[]) =>
  v.safeParse(localSettingsSchema, { ...createDefaultSettings(), detailLinks }).success;

describe("detail links for answers and member IDs", () => {
  it("keeps an answer link per question field, and one member ID link", () => {
    expect(valid([link("secret-answer", "First pet?"), link("secret-answer", "Birth city?")])).toBe(
      true,
    );
    expect(valid([link("secret-answer", "First pet?"), link("secret-answer", "First pet?")])).toBe(
      false,
    );
    expect(valid([link("member-id", "Member ID"), link("member-id", "Customer number")])).toBe(
      false,
    );
    expect(valid([link("member-id", "Member ID"), link("secret-answer", "Member ID")])).toBe(true);
  });

  it("stores a confirmed question with an answer link only, normalized and once per item", () => {
    const asked = (custom: string, question: string): DetailLink => ({
      ...link("secret-answer", custom),
      question,
    });
    expect(valid([asked("お母さんの旧姓", "母親の旧姓は")])).toBe(true);
    // Two questions for one field are still one link per field.
    expect(
      valid([asked("お母さんの旧姓", "母親の旧姓は"), asked("お母さんの旧姓", "母の旧姓")]),
    ).toBe(false);
    // One question kept for two fields would match both on the page.
    expect(
      valid([asked("お母さんの旧姓", "母親の旧姓は"), asked("母の旧姓", "母親の旧姓は")]),
    ).toBe(false);
    expect(
      valid([
        asked("お母さんの旧姓", "母親の旧姓は"),
        { ...asked("母の旧姓", "母親の旧姓は"), itemId: "other" },
      ]),
    ).toBe(true);
    // Stored as compared: NFKC, without case, a trailing question mark removed.
    expect(valid([asked("First pet", "Name of your first pet?")])).toBe(false);
    expect(valid([asked("First pet", "name of your first pet")])).toBe(true);
    expect(valid([asked("First pet", "pet")])).toBe(false);
    expect(valid([asked("First pet", "x".repeat(201))])).toBe(false);
    expect(valid([{ ...link("member-id", "Member ID"), question: "member number" }])).toBe(false);
  });

  it("compares questions after NFKC, without case and trailing marks", () => {
    expect(questionText("  Mother\u2019s  maiden NAME？ ")).toBe("mother's maiden name");
    expect(questionText("母親の旧姓は：")).toBe("母親の旧姓は");
  });
});

describe("detail links and formats for card values and PINs", () => {
  const card = (detail: DetailLink["detail"], field: string) => ({
    ...link(detail, "unused"),
    source: { itemId: "card", field },
  });

  it("names a card's expiry date by its month, whose year the same card item gives", () => {
    expect(valid([card("card-expiry", "card.expMonth")] as DetailLink[])).toBe(true);
    expect(valid([card("card-number", "card.number")] as DetailLink[])).toBe(true);
    expect(valid([card("card-expiry", "card.expYear")] as DetailLink[])).toBe(false);
    expect(valid([link("pin", "暗証番号")])).toBe(true);
  });

  it("fits a format only to its own detail", () => {
    expect(detailFormatFits("card-expiry", "mm/yy")).toBe(true);
    expect(detailFormatFits("card-expiry", "yyyymm")).toBe(false);
    expect(detailFormatFits("card-expiry", undefined)).toBe(false);
    expect(detailFormatFits("birth-date", "yyyymm")).toBe(true);
    expect(detailFormatFits("birth-date", "mmyy")).toBe(false);
    expect(detailFormatFits("card-number", undefined)).toBe(true);
    expect(detailFormatFits("pin", "mmyy")).toBe(false);
  });
});
