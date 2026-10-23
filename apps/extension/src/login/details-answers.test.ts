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
  savedDetailLink,
  savedDetailLinks,
} from "./details";

// Secret-question answers and member IDs (ADR 0061). Synthetic vault data only.
const connectionId = "personal";
const snapshot = "60000000-0000-4000-8000-000000000002";
const custom = (index: number, name: string, kind: "text" | "hidden" | "boolean" = "text") => ({
  id: `custom.${snapshot}.${index}`,
  label: name,
  name,
  kind,
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
const login = item("login", "Synthetic login", [
  { id: "login.username", label: "Username", name: null, kind: "text" },
  custom(0, "母親の旧姓は？", "hidden"),
  custom(1, "会員番号"),
  custom(2, "暗証番号", "hidden"),
  custom(3, "Remember me", "boolean"),
]);
const other = item("other", "Synthetic other", [
  custom(0, "母親の旧姓は？", "hidden"),
  custom(1, "Member ID"),
]);
const connection: VaultConnectionMetadata = {
  id: connectionId,
  label: "Synthetic vault",
  provider: "bitwarden",
  userId: "synthetic-user",
  groups: [],
  items: [login, other],
};
const catalog: VaultCatalog = { connections: [connection] };
const policy = (extra: Partial<LocalSettings> = {}): LocalSettings => ({
  connections: [
    {
      connectionId,
      enabled: true,
      selection: { mode: "all", groupIds: [], itemIds: [] },
      excludedItemIds: [],
      excludedFields: [],
    },
  ],
  excludedSites: [],
  repromptSites: [],
  passkeyBrowserSites: [],
  siteDefaults: [],
  bindings: [],
  ...extra,
});
const owner = {
  origin: "https://bank.example",
  provider: "bitwarden",
  userId: "synthetic-user",
  itemId: "login",
};
const link = (
  detail: DetailLink["detail"],
  source: DetailLink["source"],
  overrides: Partial<DetailLink> = {},
): DetailLink => ({ ...owner, detail, source, ...overrides });

describe("which fields give a secret question's answer or a member ID", () => {
  it("reads an answer from any named Text or Hidden custom field", () => {
    expect(givesDetail("secret-answer", custom(0, "First pet?"))).toBe(true);
    expect(givesDetail("secret-answer", custom(0, "First pet?", "hidden"))).toBe(true);
    expect(givesDetail("secret-answer", custom(0, "First pet?", "boolean"))).toBe(false);
    expect(givesDetail("secret-answer", { ...custom(0, "x"), name: null })).toBe(false);
    expect(
      givesDetail("secret-answer", {
        id: "login.password",
        label: "P",
        name: null,
        kind: "hidden",
      }),
    ).toBe(false);
  });

  it("reads a member ID from a field named as one, never a PIN, code, card or phone", () => {
    for (const name of ["会員番号", "お客様番号", "Member ID", "Customer number", "契約番号"])
      expect(givesDetail("member-id", custom(0, name)), name).toBe(true);
    for (const name of ["暗証番号", "PIN number", "Card number", "電話番号", "Passcode", "Note"])
      expect(givesDetail("member-id", custom(0, name)), name).toBe(false);
  });

  it("fills an answer or a member ID trimmed, within its length", () => {
    expect(detailValue("secret-answer", undefined, "  synthetic answer ")).toBe("synthetic answer");
    expect(detailValue("secret-answer", undefined, "a".repeat(128))).toBe("a".repeat(128));
    expect(detailValue("secret-answer", undefined, "a".repeat(129))).toBeUndefined();
    expect(detailValue("secret-answer", undefined, "   ")).toBeUndefined();
    expect(detailValue("member-id", undefined, " AB-0001 ")).toBe("AB-0001");
    expect(detailValue("member-id", undefined, "1".repeat(65))).toBeUndefined();
  });
});

describe("links to the login item's own fields", () => {
  it("offers answers and member IDs only from the login item", () => {
    const page = { host: "bank.example", loginItemId: "login" };
    expect(
      detailCandidates(policy(), catalog, connection, "secret-answer", page).map(
        (entry) => `${entry.itemId}/${entry.fieldLabel}`,
      ),
    ).toEqual(["login/母親の旧姓は？", "login/会員番号", "login/暗証番号"]);
    expect(
      detailCandidates(policy(), catalog, connection, "member-id", page).map(
        (entry) => `${entry.itemId}/${entry.fieldLabel}`,
      ),
    ).toEqual(["login/会員番号"]);
  });

  it("never offers a field excluded in the settings", () => {
    const excluded = policy({
      connections: [
        {
          connectionId,
          enabled: true,
          selection: { mode: "all", groupIds: [], itemIds: [] },
          excludedItemIds: [],
          excludedFields: [{ itemId: "login", fieldId: custom(0, "").id }],
        },
      ],
    });
    expect(
      detailCandidates(excluded, catalog, connection, "secret-answer", {
        host: "bank.example",
        loginItemId: "login",
      }).map((entry) => entry.fieldLabel),
    ).not.toContain("母親の旧姓は？");
  });

  it("refuses a link that reads another item's field", () => {
    const own = link("secret-answer", { itemId: "login", field: { custom: "母親の旧姓は？" } });
    expect(linkedField(policy(), catalog, connection, own)).toEqual({
      itemId: "login",
      fieldId: custom(0, "").id,
      name: "母親の旧姓は？",
    });
    expect(
      linkedField(policy(), catalog, connection, {
        ...own,
        source: { itemId: "other", field: { custom: "母親の旧姓は？" } },
      }),
    ).toBeUndefined();
    expect(
      linkedField(
        policy(),
        catalog,
        connection,
        link("member-id", { itemId: "other", field: { custom: "Member ID" } }),
      ),
    ).toBeUndefined();
  });

  it("keeps one answer link per question field", () => {
    const first = link("secret-answer", { itemId: "login", field: { custom: "母親の旧姓は？" } });
    const second = link("secret-answer", { itemId: "login", field: { custom: "会員番号" } });
    const settings = policy({ detailLinks: [first, second] });
    expect(savedDetailLinks(settings, owner, "secret-answer")).toEqual([first, second]);
    expect(savedDetailLink(settings, owner, "member-id")).toBeUndefined();
  });
});
