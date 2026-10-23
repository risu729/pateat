import { describe, expect, it } from "vitest";
import * as v from "valibot";
import { createDefaultSettings, localSettingsSchema, type DetailLink } from "./settings";

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
});
