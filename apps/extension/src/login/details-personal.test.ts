import { describe, expect, it } from "vitest";
import type {
  LocalSettings,
  VaultCatalog,
  VaultConnectionMetadata,
  VaultItemMetadata,
} from "@pateat/contracts";
import { connectionPolicy } from "../connections/__fixtures__/policy";
import { detailCandidates, linkedField, proposedField, readsFrom, shownDetail } from "./details";

// A birth date or phone number is read only from an identity, the login item or a secure
// note, the login item's first (ADR 0061, owner 2026-11-21 10:12 and 10:23 UTC).
// Synthetic vault data only.
const connectionId = "personal";
const snapshot = "60000000-0000-4000-8000-000000000004";
const custom = (index: number, name: string) => ({
  id: `custom.${snapshot}.${index}`,
  label: name,
  name,
  kind: "text" as const,
});
const builtin = (id: string, label: string) => ({ id, label, name: null, kind: "text" as const });
const item = (id: string, fields: VaultItemMetadata["fields"]): VaultItemMetadata => ({
  id,
  label: `Synthetic ${id}`,
  allowedOrigins: [],
  groupIds: [],
  fields,
});
const password = { id: "login.password", label: "Password", name: null, kind: "hidden" as const };
const login = item("login", [password, custom(0, "電話番号")]);
const identity = item("identity", [builtin("identity.phone", "Phone"), custom(0, "生年月日")]);
const note = item("note", [custom(0, "Phone"), custom(1, "Birth date")]);
// Another site's login item: its phone field may hold that site's own number.
const otherSite = item("other-site", [password, custom(0, "にゃんPay 電話番号")]);
const card = item("card", [builtin("card.number", "Number"), custom(0, "Phone")]);
const vault = (items: VaultItemMetadata[]): VaultConnectionMetadata => ({
  id: connectionId,
  label: "Synthetic vault",
  provider: "bitwarden",
  server: "cloud-us",
  userId: "synthetic-user",
  groups: [],
  items,
});
const policy = (connection: VaultConnectionMetadata): LocalSettings => ({
  connections: [{ connectionId, enabled: true }],
  ...connectionPolicy(connection),
  excludedSites: [],
  repromptSites: [],
  passkeyBrowserSites: [],
  siteDefaults: [],
  bindings: [],
});
const page = { host: "synthetic.example", loginItemId: "login" };
const candidates = (items: VaultItemMetadata[], detail: "phone-last-4" | "birth-date") => {
  const connection = vault(items);
  const catalog: VaultCatalog = { connections: [connection] };
  return detailCandidates(policy(connection), catalog, connection, detail, page).map((entry) => [
    entry.itemId,
    entry.fieldLabel,
  ]);
};
const proposed = (items: VaultItemMetadata[], detail: "phone-last-4" | "birth-date") => {
  const connection = vault(items);
  const catalog: VaultCatalog = { connections: [connection] };
  return proposedField(policy(connection), catalog, connection, detail, page)?.fieldId;
};

describe("a birth date or phone number (ADR 0061)", () => {
  it("is read only from the login item, an identity or a secure note", () => {
    for (const detail of ["phone-last-4", "birth-date"] as const) {
      expect(readsFrom(detail, login, "login")).toBe(true);
      expect(readsFrom(detail, identity, "login")).toBe(true);
      expect(readsFrom(detail, note, "login")).toBe(true);
      expect(readsFrom(detail, otherSite, "login")).toBe(false);
      expect(readsFrom(detail, card, "login")).toBe(false);
    }
    // A card's details still come from a card.
    expect(readsFrom("card-number", card, "login")).toBe(true);
  });

  it("lists the login item's field first, then an identity's, then a secure note's", () => {
    const all = [otherSite, note, card, identity, login];
    expect(candidates(all, "phone-last-4")).toEqual([
      ["login", "電話番号"],
      ["identity", "Phone"],
      ["note", "Phone"],
    ]);
    expect(candidates(all, "birth-date")).toEqual([
      ["identity", "生年月日"],
      ["note", "Birth date"],
    ]);
  });

  it("gives no value to a saved link to another site's login item", () => {
    const connection = vault([login, otherSite]);
    const catalog: VaultCatalog = { connections: [connection] };
    expect(
      linkedField(policy(connection), catalog, connection, {
        detail: "phone-last-4",
        itemId: "login",
        source: { itemId: "other-site", field: { custom: "にゃんPay 電話番号" } },
      }),
    ).toBe(undefined);
  });

  it("is filled without a link only from the one field that gives it", () => {
    expect(proposed([identity, otherSite, card], "phone-last-4")).toBe("identity.phone");
    expect(proposed([identity, login], "phone-last-4")).toBe(undefined);
    expect(proposed([identity, note], "birth-date")).toBe(undefined);
    expect(proposed([otherSite], "phone-last-4")).toBe(undefined);
    // Never another detail, even from its only field.
    const connection = vault([login]);
    expect(
      proposedField(policy(connection), { connections: [connection] }, connection, "pin", page),
    ).toBe(undefined);
  });

  it("is shown as the fill types it: a phone number's last four digits, a date as year-month-day", () => {
    expect(shownDetail("phone-last-4", "+81 90-0000-1234")).toBe("1234");
    expect(shownDetail("phone-last-4", "no number")).toBe(undefined);
    expect(shownDetail("birth-date", "1990年4月1日")).toBe("1990-04-01");
    expect(shownDetail("birth-date", "not a date")).toBe(undefined);
    expect(shownDetail("card-code", "123")).toBe(undefined);
  });
});
