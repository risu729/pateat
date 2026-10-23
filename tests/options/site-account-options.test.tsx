import { expect, it } from "vitest";
import { createDefaultSettings, type VaultCatalog } from "../../packages/contracts/src/index";
import { siteAccountOptions } from "../../apps/extension/src/options/site-policy";

const item = (id: string, label = "Same name") => ({
  id,
  label,
  allowedOrigins: [],
  groupIds: [],
  fields: [],
});
const catalog: VaultCatalog = {
  connections: [
    {
      id: "live",
      label: "Live",
      provider: "bitwarden",
      server: "cloud-us",
      userId: "33333333-3333-4333-8333-333333333333",
      state: "ready",
      groups: [],
      items: [
        item("44444444-4444-4444-8444-444444444444"),
        item("55555555-5555-4555-8555-555555555555"),
        item("66666666-6666-4666-8666-666666666666"),
        item("77777777-7777-4777-8777-777777777777", "Other"),
      ],
    },
  ],
};
const account = {
  provider: "bitwarden",
  server: "cloud-us",
  userId: "33333333-3333-4333-8333-333333333333",
};
const draft = createDefaultSettings(catalog);
draft.accountPolicies.push({
  ...account,
  accountName: "Live",
  enabled: true,
  selection: { mode: "all" },
});
const found = (accounts: { itemId: string; username?: string }[]) => ({
  version: 1 as const,
  ok: true as const,
  origin: "https://my.bank.example",
  accounts: accounts.map((entry) => ({
    connectionId: "live",
    uri: true,
    passkey: false,
    ...entry,
  })),
  complete: true,
});

it("labels same-named items by login username, then by an item ID prefix", () => {
  const labels = siteAccountOptions(
    catalog,
    found([
      { itemId: "44444444-4444-4444-8444-444444444444", username: "alice" },
      { itemId: "55555555-5555-4555-8555-555555555555", username: "bob" },
      { itemId: "66666666-6666-4666-8666-666666666666" },
    ]),
    false,
    draft,
  ).map((option) => option.label);
  expect(labels).toEqual(["Same name · alice", "Same name · bob", "Same name"]);

  // Without usernames, the names alone cannot tell the items apart.
  expect(
    siteAccountOptions(
      catalog,
      found([
        { itemId: "44444444-4444-4444-8444-444444444444" },
        { itemId: "55555555-5555-4555-8555-555555555555" },
      ]),
      true,
      draft,
    ).map((option) => option.label),
  ).toEqual([
    "Same name · ID 44444444",
    "Same name · ID 55555555",
    "Same name · ID 66666666",
    "Other",
  ]);
});

it("lists unmatched items only when asked, after the matches, and only those the draft allows", () => {
  const limited = structuredClone(draft);
  limited.itemPolicies.push({
    ...account,
    itemId: "66666666-6666-4666-8666-666666666666",
    itemName: "Same name",
    selected: false,
    excluded: true,
    excludedFields: [],
  });
  const quarantined = structuredClone(catalog);
  quarantined.connections[0]!.quarantinedItemIds = ["44444444-4444-4444-8444-444444444444"];
  const options = siteAccountOptions(
    quarantined,
    found([{ itemId: "77777777-7777-4777-8777-777777777777" }]),
    true,
    limited,
  );
  expect(options.map((option) => [option.itemId.slice(0, 8), option.uri])).toEqual([
    ["77777777", true],
    ["55555555", false],
  ]);
  const disabled = structuredClone(draft);
  disabled.accountPolicies[0]!.enabled = false;
  expect(siteAccountOptions(catalog, found([]), true, disabled)).toEqual([]);
  // The same user ID on another server is another account: its policy does not apply here.
  const elsewhere = structuredClone(draft);
  elsewhere.accountPolicies[0]!.server = "cloud-eu";
  expect(siteAccountOptions(catalog, found([]), true, elsewhere)).toEqual([]);
  // Before the first settings sync of a paired device, no unmatched item is offered.
  expect(
    siteAccountOptions({ ...catalog, settingsSyncPending: true }, found([]), true, draft),
  ).toEqual([]);
});
