import { describe, expect, it } from "vitest";
import type { VaultItemMetadata } from "@pateat/contracts";
import { readsSecret } from "../runtime/button-layout";

// Synthetic item metadata only: no value is ever read (ADR 0060 amendment of 2026-11-18).
describe("a binding that reads a secret into the page after a passkey button", () => {
  const field = (
    id: string,
    kind: VaultItemMetadata["fields"][number]["kind"],
    extra: Partial<VaultItemMetadata["fields"][number]> = {},
  ): VaultItemMetadata["fields"][number] => ({ id, label: id, name: null, kind, ...extra });
  const item = {
    id: "item",
    fields: [
      field("login.username", "text"),
      field("login.password", "hidden"),
      field("login.totp-code", "otp"),
      field("custom.member", "text"),
      field("custom.pin", "hidden"),
      field("custom.linked-password", "linked", { linkedFieldId: "login.password" }),
      field("custom.linked-username", "linked", { linkedFieldId: "login.username" }),
    ],
  } as unknown as VaultItemMetadata;
  const connection = { items: [item] };
  const binding = (slot: string, fieldId: string) => ({
    itemId: "item",
    slots: [{ slot, fieldId }],
  });

  it.each([
    ["the username field", "username", "login.username"],
    ["a text custom field", "username", "custom.member"],
    ["a Linked field that reads the username", "username", "custom.linked-username"],
  ])("never counts %s", (_label, slot, fieldId) => {
    expect(readsSecret(connection, binding(slot, fieldId))).toBe(false);
  });
  it.each([
    ["the password slot", "password", "login.username"],
    ["the password through another slot", "username", "login.password"],
    ["a TOTP code alone", "username", "login.totp-code"],
    ["a concealed custom field", "username", "custom.pin"],
    ["a Linked field that reads the password", "username", "custom.linked-password"],
  ])("counts %s", (_label, slot, fieldId) => {
    expect(readsSecret(connection, binding(slot, fieldId))).toBe(true);
  });
  it("reads the field's own ID for an item the catalog does not list", () => {
    expect(readsSecret({ items: [] }, { itemId: "gone", slots: [] })).toBe(false);
    expect(
      readsSecret(
        { items: [] },
        { itemId: "gone", slots: [{ slot: "username", fieldId: "login.password" }] },
      ),
    ).toBe(true);
  });
});
