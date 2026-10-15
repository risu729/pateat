import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  accountPolicySchema,
  connectionUse,
  createDefaultSettings,
  customFieldReviewSchema,
  customFieldReviewState,
  DUMMY_VAULT_CATALOG,
  excludedFieldReference,
  getItemEligibility,
  instantBefore,
  isFieldExcluded,
  itemPolicySchema,
  localSettingsSchema,
  parseInstant,
  resolveExcludedFields,
  resolveSiteAccount,
  siteDefaultConnection,
  vaultServerSchema,
  type AccountPolicy,
  type CustomFieldReview,
  type ExcludedField,
  type ItemPolicy,
  type LocalSettings,
  type VaultCatalog,
  type VaultItemMetadata,
} from "./settings";
import { createSettingsStore, type SettingsStorage } from "./settings-store";

// Synced vault policy (ADR 0023): synthetic accounts, items and evidence only.
const snapshotId = "11111111-1111-4111-8111-111111111111";
const custom = (index: number) => `custom.${snapshotId}.${index}`;
const account = {
  provider: "bitwarden",
  server: "https://vault.example",
  userId: "00000000-0000-4000-8000-000000000001",
};
const evidence = (digit: string) => `bitwarden-v1:sha256:${digit.repeat(64)}`;
const reviewedAt = "2026-10-11T07:10:03.1234567Z";

/** Built-in fields, a duplicated name (PIN, at vault indexes 0, 2 and 10) and unnamed fields. */
const fields = [
  { id: "login.username", name: null },
  { id: "login.password", name: null },
  { id: custom(0), name: "PIN" },
  { id: custom(1), name: "Branch" },
  { id: custom(2), name: "PIN" },
  { id: custom(3), name: null },
  { id: custom(4), name: null },
  { id: custom(10), name: "PIN" },
];

function item(overrides: Partial<VaultItemMetadata> = {}): VaultItemMetadata {
  return {
    id: "item-1",
    label: "Example Bank",
    allowedOrigins: ["https://bank.example"],
    groupIds: ["folder-1"],
    evidence: evidence("a"),
    revisionDate: reviewedAt,
    fields: fields.map((field) => ({
      ...field,
      label: field.name ?? field.id,
      kind: "text" as const,
    })),
    ...overrides,
  };
}

function catalog(items: VaultItemMetadata[] = [item()]): VaultCatalog {
  return {
    connections: [
      {
        id: "vault",
        label: "Personal vault",
        provider: account.provider,
        server: account.server,
        userId: account.userId,
        snapshotId,
        groups: [{ id: "folder-1", label: "Banking", kind: "folder" }],
        items,
      },
    ],
  };
}

function accountPolicy(overrides: Partial<AccountPolicy> = {}): AccountPolicy {
  return {
    ...account,
    accountName: "Personal vault",
    enabled: true,
    selection: { mode: "all" },
    ...overrides,
  };
}
function itemPolicy(overrides: Partial<ItemPolicy> = {}): ItemPolicy {
  return {
    ...account,
    itemId: "item-1",
    itemName: "Example Bank",
    selected: false,
    excluded: false,
    excludedFields: [],
    ...overrides,
  };
}
function review(overrides: Partial<CustomFieldReview> = {}): CustomFieldReview {
  return {
    ...account,
    itemId: "item-1",
    evidence: evidence("a"),
    revisionDate: reviewedAt,
    ...overrides,
  };
}
function settings(overrides: Partial<LocalSettings> = {}): LocalSettings {
  return {
    ...createDefaultSettings({ connections: [] }),
    accountPolicies: [accountPolicy()],
    ...overrides,
  };
}
const valid = (value: unknown) => v.is(localSettingsSchema, value);

describe("vault server", () => {
  it("is a Bitwarden cloud region or an exact HTTPS origin", () => {
    for (const server of [
      "cloud-us",
      "cloud-eu",
      "https://vault.example",
      "https://vault.example:8443",
      "https://[::1]",
    ])
      expect(v.is(vaultServerSchema, server), server).toBe(true);
    for (const server of [
      "",
      "cloud",
      "CLOUD-US",
      "http://vault.example",
      "https://vault.example/",
      "https://vault.example/path",
      "https://Vault.example",
      "https://user@vault.example",
      "https://vault.example:443",
      "vault.example",
      `https://${"a".repeat(2050)}.example`,
    ])
      expect(v.is(vaultServerSchema, server), server).toBe(false);
  });
});

describe("account, item and review entries", () => {
  it("accepts all or selected groups, without duplicate groups", () => {
    expect(v.is(accountPolicySchema, accountPolicy())).toBe(true);
    const selected = (groups: unknown) =>
      accountPolicy({ selection: { mode: "selected", groups } as never });
    expect(v.is(accountPolicySchema, selected([]))).toBe(true);
    expect(v.is(accountPolicySchema, selected([{ id: "g", name: "Group" }]))).toBe(true);
    for (const groups of [
      [
        { id: "g", name: "Group" },
        { id: "g", name: "Other" },
      ],
      [{ id: "g", name: "" }],
      [{ id: "g" }],
      Array.from({ length: 1001 }, (_, index) => ({ id: `g${index}`, name: "Group" })),
    ])
      expect(v.is(accountPolicySchema, selected(groups))).toBe(false);
    for (const malformed of [
      accountPolicy({ selection: { mode: "none" } as never }),
      accountPolicy({ selection: { mode: "all", groups: [] } as never }),
      accountPolicy({ accountName: "" }),
      { ...accountPolicy(), server: undefined },
      { ...accountPolicy(), excludedItemIds: [] },
    ])
      expect(v.is(accountPolicySchema, malformed)).toBe(false);
  });

  it.each<[string, ExcludedField]>([
    ["a built-in field ID", "login.password"],
    ["a named field with its position", { custom: "PIN", position: 2, count: 3 }],
    ["the only field of a name", { custom: "Branch", position: 1, count: 1 }],
    ["an unnamed field", { custom: null, position: 2, count: 2 }],
    ["a name without a position", { custom: "Branch" }],
    ["the unnamed group without a position", { custom: null }],
  ])("excludes %s", (_label, reference) => {
    expect(v.is(itemPolicySchema, itemPolicy({ excludedFields: [reference] }))).toBe(true);
  });

  it.each([
    ["a position without a count", { custom: "PIN", position: 1 }],
    ["a count without a position", { custom: "PIN", count: 2 }],
    ["a position beyond the count", { custom: "PIN", position: 3, count: 2 }],
    ["a position of zero", { custom: "PIN", position: 0, count: 1 }],
    ["a count of zero", { custom: null, position: 0, count: 0 }],
    ["a fractional position", { custom: "PIN", position: 1.5, count: 2 }],
    ["a count over 1000", { custom: "PIN", position: 1, count: 1001 }],
    ["an empty name", { custom: "" }],
    ["a name over 200 characters", { custom: "x".repeat(201) }],
    ["a missing name", { position: 1, count: 1 }],
    ["an extra key", { custom: "PIN", index: 1 }],
    ["an empty built-in ID", ""],
  ])("refuses an exclusion with %s", (_label, reference) => {
    expect(v.is(itemPolicySchema, itemPolicy({ excludedFields: [reference as never] }))).toBe(
      false,
    );
  });

  it("bounds an item's exclusions at 50 and refuses duplicates", () => {
    const builtins = (count: number) =>
      Array.from({ length: count }, (_, index) => `field.${index}`);
    expect(v.is(itemPolicySchema, itemPolicy({ excludedFields: builtins(50) }))).toBe(true);
    expect(v.is(itemPolicySchema, itemPolicy({ excludedFields: builtins(51) }))).toBe(false);
    for (const duplicate of [
      ["login.password", "login.password"],
      [
        { custom: "PIN", position: 1, count: 2 },
        { custom: "PIN", position: 1, count: 2 },
      ],
      [{ custom: null }, { custom: null }],
    ] as ExcludedField[][])
      expect(v.is(itemPolicySchema, itemPolicy({ excludedFields: duplicate }))).toBe(false);
    // Another position or count is another reference.
    expect(
      v.is(
        itemPolicySchema,
        itemPolicy({
          excludedFields: [
            { custom: "PIN", position: 1, count: 2 },
            { custom: "PIN", position: 1, count: 3 },
            { custom: "PIN" },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("names a review's evidence and revision date strictly", () => {
    expect(v.is(customFieldReviewSchema, review())).toBe(true);
    for (const revisionDate of [
      "2026-10-11T07:10:03Z",
      "2026-10-11T07:10:03.123456789Z",
      "2026-10-11T16:10:03.5+09:00",
      "2026-10-11T07:10:03-00:30",
    ])
      expect(v.is(customFieldReviewSchema, review({ revisionDate })), revisionDate).toBe(true);
    for (const revisionDate of [
      "",
      "2026-10-11",
      "2026-10-11T07:10:03",
      "2026-10-11T07:10:03.1234567890Z",
      "2026-10-11 07:10:03Z",
      "2026-10-11T07:10:03z",
      "2026-13-11T07:10:03Z",
      "2026-10-11T07:10:03.Z",
    ])
      expect(v.is(customFieldReviewSchema, review({ revisionDate })), revisionDate).toBe(false);
    for (const value of [
      "",
      `bitwarden-v1:sha256:${"a".repeat(63)}`,
      `bitwarden-v1:sha256:${"A".repeat(64)}`,
      `bitwarden-v0:sha256:${"a".repeat(64)}`,
      `bitwarden:sha256:${"a".repeat(64)}`,
      `bitwarden-v1:sha1:${"a".repeat(64)}`,
      `Bitwarden-v1:sha256:${"a".repeat(64)}`,
    ])
      expect(v.is(customFieldReviewSchema, review({ evidence: value })), value).toBe(false);
    expect(
      v.is(customFieldReviewSchema, review({ evidence: `dummy-v12:sha256:${"0".repeat(64)}` })),
    ).toBe(true);
  });
});

describe("synced policy list limits and keys", () => {
  const accounts = (count: number) =>
    Array.from({ length: count }, (_, index) => accountPolicy({ userId: `user-${index}` }));
  const items = (count: number) =>
    Array.from({ length: count }, (_, index) => itemPolicy({ itemId: `item-${index}` }));
  const reviews = (count: number) =>
    Array.from({ length: count }, (_, index) => review({ itemId: `item-${index}` }));

  it("keeps 100 account policies, 1,000 item policies and 1,000 reviews", () => {
    expect(valid(settings({ accountPolicies: accounts(100) }))).toBe(true);
    expect(valid(settings({ accountPolicies: accounts(101) }))).toBe(false);
    expect(valid(settings({ itemPolicies: items(1000) }))).toBe(true);
    expect(valid(settings({ itemPolicies: items(1001) }))).toBe(false);
    expect(valid(settings({ customFieldReviews: reviews(1000) }))).toBe(true);
    expect(valid(settings({ customFieldReviews: reviews(1001) }))).toBe(false);
  });

  it("keys entries by provider, server and user ID, and by item", () => {
    expect(valid(settings({ accountPolicies: [accountPolicy(), accountPolicy()] }))).toBe(false);
    // Display names and settings do not make another key.
    expect(
      valid(
        settings({
          accountPolicies: [
            accountPolicy(),
            accountPolicy({ accountName: "Other", enabled: false }),
          ],
        }),
      ),
    ).toBe(false);
    // The same user ID on another server, or of another provider, is another account.
    expect(
      valid(
        settings({
          accountPolicies: [
            accountPolicy(),
            accountPolicy({ server: "cloud-us" }),
            accountPolicy({ provider: "other" }),
          ],
        }),
      ),
    ).toBe(true);
    expect(valid(settings({ itemPolicies: [itemPolicy(), itemPolicy({ selected: true })] }))).toBe(
      false,
    );
    expect(
      valid(settings({ itemPolicies: [itemPolicy(), itemPolicy({ server: "cloud-eu" })] })),
    ).toBe(true);
    expect(
      valid(settings({ customFieldReviews: [review(), review({ evidence: evidence("b") })] })),
    ).toBe(false);
    expect(valid(settings({ customFieldReviews: [review(), review({ itemId: "item-2" })] }))).toBe(
      true,
    );
  });
});

describe("provider instants", () => {
  it("parses seconds with up to nine fractional digits and a zone to nanoseconds", () => {
    const seconds = BigInt(Date.parse("2026-10-11T07:10:03Z")) * 1_000_000n;
    expect(parseInstant("2026-10-11T07:10:03Z")).toBe(seconds);
    expect(parseInstant("2026-10-11T07:10:03.1234567Z")).toBe(seconds + 123_456_700n);
    expect(parseInstant("2026-10-11T07:10:03.123456789Z")).toBe(seconds + 123_456_789n);
    expect(parseInstant("2026-10-11T07:10:03.5Z")).toBe(seconds + 500_000_000n);
    expect(parseInstant("2026-10-11T16:10:03.1234567+09:00")).toBe(seconds + 123_456_700n);
    expect(parseInstant("2026-10-11T06:40:03.1234567-00:30")).toBe(seconds + 123_456_700n);
    for (const value of [
      "2026-10-11T07:10:03",
      "2026-10-11T07:10:03.1234567890Z",
      "2026-10-11T07:10Z",
      "2026-10-11T07:10:03+0900",
      "2026-13-11T07:10:03Z",
      "2026-02-30T07:10:03Z",
      "2026-10-11T25:00:00Z",
      "not a date",
    ])
      expect(parseInstant(value), value).toBeUndefined();
  });

  it("compares instants strictly, beyond millisecond precision and across zones", () => {
    expect(instantBefore("2026-10-11T07:10:03.1234566Z", "2026-10-11T07:10:03.1234567Z")).toBe(
      true,
    );
    expect(instantBefore("2026-10-11T07:10:03.1234567Z", "2026-10-11T07:10:03.1234566Z")).toBe(
      false,
    );
    // The same instant is not before itself.
    expect(instantBefore(reviewedAt, reviewedAt)).toBe(false);
    expect(instantBefore("2026-10-11T16:10:03.1234567+09:00", reviewedAt)).toBe(false);
    expect(instantBefore("2026-10-11T16:10:03.12345+09:00", reviewedAt)).toBe(true);
    // A value that does not parse is never before or after anything.
    expect(instantBefore("2026-10-11", reviewedAt)).toBe(false);
    expect(instantBefore(reviewedAt, "2026-10-11")).toBe(false);
  });
});

describe("excluded field references", () => {
  it("names built-in fields by ID and custom fields within their same-name group", () => {
    expect(excludedFieldReference(fields, "login.password")).toBe("login.password");
    expect(excludedFieldReference(fields, custom(0))).toEqual({
      custom: "PIN",
      position: 1,
      count: 3,
    });
    expect(excludedFieldReference(fields, custom(2))).toEqual({
      custom: "PIN",
      position: 2,
      count: 3,
    });
    // Positions follow the numeric vault index, not the catalog order or string order.
    expect(excludedFieldReference(fields, custom(10))).toEqual({
      custom: "PIN",
      position: 3,
      count: 3,
    });
    expect(excludedFieldReference([...fields].reverse(), custom(2))).toEqual({
      custom: "PIN",
      position: 2,
      count: 3,
    });
    // A single field of a name still carries its position and count.
    expect(excludedFieldReference(fields, custom(1))).toEqual({
      custom: "Branch",
      position: 1,
      count: 1,
    });
    // Unnamed fields form one group.
    expect(excludedFieldReference(fields, custom(4))).toEqual({
      custom: null,
      position: 2,
      count: 2,
    });
    expect(excludedFieldReference(fields, custom(9))).toBeUndefined();
    expect(excludedFieldReference(fields, "login.totp")).toBeUndefined();
  });

  it("round-trips every field through resolution", () => {
    for (const field of fields) {
      const reference = excludedFieldReference(fields, field.id)!;
      expect(v.is(itemPolicySchema, itemPolicy({ excludedFields: [reference] }))).toBe(true);
      expect(resolveExcludedFields([reference], fields)).toEqual({
        fieldIds: [field.id],
        unresolved: false,
      });
    }
  });

  it("resolves custom references on another device's field IDs", () => {
    const other = "22222222-2222-4222-8222-222222222222";
    const moved = fields.map((field) => ({
      ...field,
      id: field.id.replace(snapshotId, other),
    }));
    expect(
      resolveExcludedFields(
        [{ custom: "PIN", position: 3, count: 3 }, { custom: "Branch" }],
        moved,
      ),
    ).toEqual({
      fieldIds: [`custom.${other}.10`, `custom.${other}.1`],
      unresolved: false,
    });
  });

  it("is unresolved when a custom reference no longer names exactly one field", () => {
    // The count changed.
    expect(resolveExcludedFields([{ custom: "PIN", position: 1, count: 2 }], fields)).toEqual({
      fieldIds: [],
      unresolved: true,
    });
    // The name is gone.
    expect(resolveExcludedFields([{ custom: "Region", position: 1, count: 1 }], fields)).toEqual({
      fieldIds: [],
      unresolved: true,
    });
    expect(resolveExcludedFields([{ custom: "Region" }], fields).unresolved).toBe(true);
    // A name without a position resolves only while exactly one field has it.
    expect(resolveExcludedFields([{ custom: "Branch" }], fields)).toEqual({
      fieldIds: [custom(1)],
      unresolved: false,
    });
    expect(resolveExcludedFields([{ custom: "PIN" }], fields).unresolved).toBe(true);
    expect(resolveExcludedFields([{ custom: null }], fields).unresolved).toBe(true);
    expect(
      resolveExcludedFields(
        [{ custom: null }],
        fields.filter((field) => field.id !== custom(4)),
      ),
    ).toEqual({ fieldIds: [custom(3)], unresolved: false });
    // Other references still resolve alongside an unresolved one.
    expect(
      resolveExcludedFields(["login.password", { custom: "PIN", position: 1, count: 4 }], fields),
    ).toEqual({ fieldIds: ["login.password"], unresolved: true });
  });

  it("excludes nothing for a built-in field the item lacks, without blocking it", () => {
    expect(resolveExcludedFields(["login.totp", "login.password"], fields)).toEqual({
      fieldIds: ["login.password"],
      unresolved: false,
    });
    // A built-in reference never matches a custom field with that name.
    expect(resolveExcludedFields(["PIN"], fields)).toEqual({ fieldIds: [], unresolved: false });
  });

  it("names each field once", () => {
    expect(
      resolveExcludedFields(
        [{ custom: "Branch" }, { custom: "Branch", position: 1, count: 1 }, "login.password"],
        fields,
      ),
    ).toEqual({ fieldIds: [custom(1), "login.password"], unresolved: false });
  });
});

describe("custom-field review state", () => {
  const state = (value: LocalSettings, live = item()) =>
    customFieldReviewState(value, account, live);
  const excludePin = itemPolicy({ excludedFields: [{ custom: "PIN", position: 2, count: 3 }] });

  it("is none for an item without custom-field exclusions or a review record", () => {
    expect(state(settings())).toBe("none");
    expect(
      state(settings({ itemPolicies: [itemPolicy({ excludedFields: ["login.password"] })] })),
    ).toBe("none");
    // Even when the item has no evidence or its references are another account's.
    expect(state(settings(), item({ evidence: undefined }))).toBe("none");
    expect(state(settings({ itemPolicies: [{ ...excludePin, userId: "someone-else" }] }))).toBe(
      "none",
    );
  });

  it("is reviewed when the evidence matches and every reference resolves", () => {
    expect(state(settings({ itemPolicies: [excludePin], customFieldReviews: [review()] }))).toBe(
      "reviewed",
    );
  });

  it("needs a review when the evidence changed and the local copy is not older", () => {
    const changed = item({ evidence: evidence("b") });
    const value = settings({ itemPolicies: [excludePin], customFieldReviews: [review()] });
    expect(state(value, changed)).toBe("review-required");
    // The same instant is not older.
    expect(state(value, { ...changed, revisionDate: "2026-10-11T16:10:03.1234567+09:00" })).toBe(
      "review-required",
    );
    expect(state(value, { ...changed, revisionDate: "2026-10-12T00:00:00Z" })).toBe(
      "review-required",
    );
    // Without evidence, the item cannot be told reviewed.
    expect(state(value, item({ evidence: undefined }))).toBe("review-required");
    expect(state(value, item({ evidence: undefined, revisionDate: undefined }))).toBe(
      "review-required",
    );
  });

  it("waits for a vault sync when the local copy is strictly older than the record", () => {
    const value = settings({ itemPolicies: [excludePin], customFieldReviews: [review()] });
    // 100 nanoseconds older: only the seventh fractional digit differs.
    expect(
      state(value, item({ evidence: evidence("b"), revisionDate: "2026-10-11T07:10:03.1234566Z" })),
    ).toBe("vault-stale");
    expect(
      state(value, item({ evidence: undefined, revisionDate: "2026-10-11T16:10:03+09:00" })),
    ).toBe("vault-stale");
  });

  it("needs a review for an unresolved reference even with matching evidence", () => {
    const changedCount = itemPolicy({ excludedFields: [{ custom: "PIN", position: 2, count: 2 }] });
    expect(state(settings({ itemPolicies: [changedCount], customFieldReviews: [review()] }))).toBe(
      "review-required",
    );
    const ambiguous = itemPolicy({ excludedFields: [{ custom: "PIN" }] });
    expect(state(settings({ itemPolicies: [ambiguous], customFieldReviews: [review()] }))).toBe(
      "review-required",
    );
    // A missing built-in field does not block the item.
    const builtin = itemPolicy({ excludedFields: ["login.totp", { custom: "Branch" }] });
    expect(state(settings({ itemPolicies: [builtin], customFieldReviews: [review()] }))).toBe(
      "reviewed",
    );
  });

  it("needs a review for custom-field exclusions without a record", () => {
    expect(state(settings({ itemPolicies: [excludePin] }))).toBe("review-required");
  });

  it("protects an item by its record even without exclusions", () => {
    const value = settings({ customFieldReviews: [review()] });
    expect(state(value)).toBe("reviewed");
    expect(state(value, item({ evidence: evidence("b") }))).toBe("review-required");
    expect(
      state(value, item({ evidence: evidence("b"), revisionDate: "2026-01-01T00:00:00Z" })),
    ).toBe("vault-stale");
  });
});

describe("item eligibility under synced policy", () => {
  const eligibility = (value: LocalSettings, live: VaultCatalog = catalog(), itemId = "item-1") =>
    getItemEligibility(value, live, "vault", itemId);
  const reason = (value: LocalSettings, live?: VaultCatalog, itemId?: string) => {
    const result = eligibility(value, live, itemId);
    return result.eligible ? "eligible" : result.reason;
  };

  it("uses an item of an enabled account with all its fields", () => {
    expect(eligibility(settings())).toMatchObject({
      eligible: true,
      item: { id: "item-1" },
      fieldIds: fields.map((field) => field.id),
    });
  });

  it("uses no item while the first settings sync is pending, before any other check", () => {
    const pending = { ...catalog(), settingsSyncPending: true as const };
    expect(reason(settings(), pending)).toBe("vault-unavailable");
    expect(reason(settings({ accountPolicies: [] }), pending)).toBe("vault-unavailable");
    expect(
      getItemEligibility(settings(), { ...pending, connections: [] }, "vault", "item-1"),
    ).toEqual({ eligible: false, reason: "vault-unavailable" });
  });

  it("reports a missing connection and one that cannot name its account", () => {
    expect(getItemEligibility(settings(), catalog(), "other", "item-1")).toEqual({
      eligible: false,
      reason: "connection-missing",
    });
    const locked = catalog();
    delete locked.connections[0]!.userId;
    locked.connections[0]!.lockedUserId = account.userId;
    expect(reason(settings(), locked)).toBe("vault-unavailable");
  });

  it("refuses an account whose user ID has synced entries for another server", () => {
    const elsewhere = { server: "cloud-us" };
    for (const value of [
      settings({ accountPolicies: [accountPolicy(), accountPolicy(elsewhere)] }),
      settings({ itemPolicies: [itemPolicy(elsewhere)] }),
      settings({ customFieldReviews: [review(elsewhere)] }),
      settings({ accountPolicies: [accountPolicy(elsewhere)] }),
    ])
      expect(reason(value)).toBe("account-ambiguous");
    // Another provider or user ID on another server is unrelated.
    expect(
      reason(
        settings({
          accountPolicies: [
            accountPolicy(),
            accountPolicy({ ...elsewhere, provider: "other" }),
            accountPolicy({ ...elsewhere, userId: "someone-else" }),
          ],
        }),
      ),
    ).toBe("eligible");
  });

  it("does not use an account without a policy or with a disabled one", () => {
    expect(reason(settings({ accountPolicies: [] }))).toBe("connection-disabled");
    expect(reason(settings({ accountPolicies: [accountPolicy({ enabled: false })] }))).toBe(
      "connection-disabled",
    );
    // A disabled account is reported before a missing item.
    expect(
      reason(settings({ accountPolicies: [accountPolicy({ enabled: false })] }), catalog(), "x"),
    ).toBe("connection-disabled");
    expect(reason(settings(), catalog(), "x")).toBe("item-missing");
  });

  it("selects items by item or by group, and an item exclusion wins", () => {
    const selected = (groups: { id: string; name: string }[]) =>
      accountPolicy({ selection: { mode: "selected", groups } });
    expect(reason(settings({ accountPolicies: [selected([])] }))).toBe("item-not-selected");
    expect(
      reason(settings({ accountPolicies: [selected([{ id: "folder-1", name: "Banking" }])] })),
    ).toBe("eligible");
    expect(
      reason(settings({ accountPolicies: [selected([{ id: "folder-2", name: "Banking" }])] })),
    ).toBe("item-not-selected");
    expect(
      reason(
        settings({
          accountPolicies: [selected([])],
          itemPolicies: [itemPolicy({ selected: true })],
        }),
      ),
    ).toBe("eligible");
    // Another account's selection of the same item ID does not count.
    expect(
      reason(
        settings({
          accountPolicies: [selected([])],
          itemPolicies: [itemPolicy({ selected: true, userId: "someone-else" })],
        }),
      ),
    ).toBe("item-not-selected");
    expect(
      reason(
        settings({
          accountPolicies: [selected([{ id: "folder-1", name: "Banking" }])],
          itemPolicies: [itemPolicy({ selected: true, excluded: true })],
        }),
      ),
    ).toBe("item-excluded");
    expect(reason(settings({ itemPolicies: [itemPolicy({ excluded: true })] }))).toBe(
      "item-excluded",
    );
  });

  it("checks review after selection and before field exclusions", () => {
    const blocked = itemPolicy({
      excludedFields: fields.map((field) => excludedFieldReference(fields, field.id)!),
    });
    // Every field excluded with no record: the review is reported, not the fields.
    expect(reason(settings({ itemPolicies: [blocked] }))).toBe("review-required");
    // An excluded or unselected item is reported first.
    expect(reason(settings({ itemPolicies: [{ ...blocked, excluded: true }] }))).toBe(
      "item-excluded",
    );
    expect(
      reason(
        settings({
          accountPolicies: [accountPolicy({ selection: { mode: "selected", groups: [] } })],
          itemPolicies: [blocked],
        }),
      ),
    ).toBe("item-not-selected");
    // A copy older than its record is also refused as waiting for review.
    const stale = catalog([
      item({ evidence: evidence("b"), revisionDate: "2026-01-01T00:00:00Z" }),
    ]);
    expect(
      reason(settings({ itemPolicies: [blocked], customFieldReviews: [review()] }), stale),
    ).toBe("review-required");
    // Once reviewed, the field exclusions apply.
    expect(reason(settings({ itemPolicies: [blocked], customFieldReviews: [review()] }))).toBe(
      "fields-excluded",
    );
  });

  it("drops the excluded fields of a reviewed item", () => {
    const value = settings({
      itemPolicies: [
        itemPolicy({
          excludedFields: [
            "login.password",
            "login.totp",
            { custom: "PIN", position: 3, count: 3 },
          ],
        }),
      ],
      customFieldReviews: [review()],
    });
    expect(eligibility(value)).toMatchObject({
      eligible: true,
      fieldIds: ["login.username", custom(0), custom(1), custom(2), custom(3), custom(4)],
    });
    expect(isFieldExcluded(value, catalog(), "vault", "item-1", custom(10))).toBe(true);
    expect(isFieldExcluded(value, catalog(), "vault", "item-1", custom(0))).toBe(false);
    expect(isFieldExcluded(value, catalog(), "vault", "item-1", "login.password")).toBe(true);
    expect(isFieldExcluded(value, catalog(), "other", "item-1", "login.password")).toBe(false);
  });
});

describe("connection use before its account is known", () => {
  const unknown: VaultCatalog = {
    connections: [{ ...catalog().connections[0]!, userId: undefined, snapshotId: undefined }],
  };
  it("follows the add form's choice while it waits", () => {
    const base = settings();
    expect(connectionUse(base, unknown, "vault")).toBe("vault-unavailable");
    expect(
      connectionUse(
        { ...base, connections: [{ connectionId: "vault", enabled: true }] },
        unknown,
        "vault",
      ),
    ).toBe("vault-unavailable");
    expect(
      connectionUse(
        { ...base, connections: [{ connectionId: "vault", enabled: false }] },
        unknown,
        "vault",
      ),
    ).toBe("disabled");
  });
});

describe("site defaults by provider account", () => {
  const twoServers = (): VaultCatalog => {
    const live = catalog();
    live.connections.push({
      ...live.connections[0]!,
      id: "vault-us",
      server: "cloud-us",
    });
    return live;
  };
  const siteDefault = (server: string) => ({
    origin: "https://bank.example",
    ...account,
    server,
    itemId: "item-1",
  });

  it("matches the connection of the same provider, server and user ID", () => {
    expect(siteDefaultConnection(siteDefault(account.server), catalog())).toEqual({
      ok: true,
      connectionId: "vault",
    });
    expect(siteDefaultConnection(siteDefault("cloud-us"), twoServers())).toEqual({
      ok: true,
      connectionId: "vault-us",
    });
    expect(
      siteDefaultConnection({ ...siteDefault(account.server), userId: "someone-else" }, catalog()),
    ).toEqual({ ok: false, reason: "connection-missing" });
  });

  it("refuses a user ID connected here only on another server as ambiguous", () => {
    expect(siteDefaultConnection(siteDefault("cloud-eu"), catalog())).toEqual({
      ok: false,
      reason: "account-ambiguous",
    });
    const value = settings({ siteDefaults: [siteDefault("cloud-eu")] });
    expect(resolveSiteAccount(value, catalog(), "https://bank.example/login")).toEqual({
      ok: false,
      reason: "account-ambiguous",
    });
  });

  it("refuses a login when the account's user ID has policies for another server", () => {
    const value = settings({
      accountPolicies: [accountPolicy(), accountPolicy({ server: "cloud-us" })],
      siteDefaults: [siteDefault("cloud-us")],
    });
    expect(resolveSiteAccount(value, twoServers(), "https://bank.example/login")).toEqual({
      ok: false,
      reason: "account-ambiguous",
    });
    expect(
      resolveSiteAccount(
        settings({ siteDefaults: [siteDefault(account.server)] }),
        catalog(),
        "https://bank.example/login",
      ),
    ).toMatchObject({ ok: true, connectionId: "vault", itemId: "item-1" });
  });

  it("names the demo catalog's accounts on cloud-us", () => {
    expect(DUMMY_VAULT_CATALOG.connections.map((connection) => connection.server)).toEqual([
      "cloud-us",
      "cloud-us",
    ]);
  });
});

function memoryStorage(initial?: unknown) {
  let value = initial;
  const writes: unknown[] = [];
  const storage: SettingsStorage = {
    async read() {
      return structuredClone(value);
    },
    async write(snapshot) {
      value = structuredClone(snapshot);
      writes.push(value);
    },
  };
  return {
    storage,
    writes,
    get value() {
      return value as { revision: number; settings: LocalSettings } | undefined;
    },
  };
}
const save = (expectedRevision: number, value: LocalSettings) => ({
  version: 1,
  type: "settings.save",
  expectedRevision,
  settings: value,
});

describe("settings page saves and custom-field review (ADR 0023)", () => {
  const pin = { custom: "PIN", position: 2, count: 3 } as const;
  const stored = (value: LocalSettings) =>
    memoryStorage({ version: 1, revision: 3, settings: value });
  const storeFor = (memory: ReturnType<typeof memoryStorage>, live = catalog()) =>
    createSettingsStore(memory.storage, live);

  it("keeps the stored review records, whatever the page sends", async () => {
    const memory = stored(
      settings({
        itemPolicies: [itemPolicy({ excludedFields: [pin] })],
        customFieldReviews: [review()],
      }),
    );
    const store = storeFor(memory);
    const sent = (revision: number, customFieldReviews: CustomFieldReview[]) =>
      store.handle(
        save(
          revision,
          settings({ itemPolicies: [itemPolicy({ excludedFields: [pin] })], customFieldReviews }),
        ),
      );
    // Saves are queued in order, so each one names the revision the previous one wrote.
    const responses = await Promise.all([
      sent(3, []),
      sent(4, [review({ evidence: evidence("c") })]),
      sent(5, [review(), review({ itemId: "item-2" })]),
    ]);
    expect(responses).toMatchObject([
      { ok: true, snapshot: { revision: 4, settings: { customFieldReviews: [review()] } } },
      { ok: true, snapshot: { revision: 5, settings: { customFieldReviews: [review()] } } },
      { ok: true, snapshot: { revision: 6, settings: { customFieldReviews: [review()] } } },
    ]);
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
  });

  it("keeps the stored custom-field exclusions of an item waiting for review", async () => {
    const blocked = catalog([
      item({ evidence: evidence("b"), revisionDate: "2026-10-12T00:00:00Z" }),
    ]);
    const memory = stored(
      settings({
        itemPolicies: [itemPolicy({ excludedFields: ["login.password", pin] })],
        customFieldReviews: [review()],
      }),
    );
    const store = storeFor(memory, blocked);
    // Built-in exclusions change; custom ones are restored, and a new one is not added.
    const response = await store.handle(
      save(
        3,
        settings({
          itemPolicies: [
            itemPolicy({
              selected: true,
              excludedFields: ["login.username", { custom: "Branch", position: 1, count: 1 }],
            }),
          ],
        }),
      ),
    );
    expect(response).toMatchObject({ ok: true });
    expect(memory.value!.settings.itemPolicies).toEqual([
      itemPolicy({ selected: true, excludedFields: ["login.username", pin] }),
    ]);
    // Removing the item's policy keeps an entry with its custom exclusions only.
    expect(await store.handle(save(4, settings()))).toMatchObject({ ok: true });
    expect(memory.value!.settings.itemPolicies).toEqual([itemPolicy({ excludedFields: [pin] })]);
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
  });

  it("keeps the stored custom-field exclusions of an item waiting for a vault sync", async () => {
    const stale = catalog([
      item({ evidence: evidence("b"), revisionDate: "2026-01-01T00:00:00Z" }),
    ]);
    const memory = stored(
      settings({
        itemPolicies: [itemPolicy({ excludedFields: [pin] })],
        customFieldReviews: [review()],
      }),
    );
    const store = storeFor(memory, stale);
    expect(
      await store.handle(save(3, settings({ itemPolicies: [itemPolicy({ excluded: true })] }))),
    ).toMatchObject({ ok: true });
    expect(memory.value!.settings.itemPolicies).toEqual([
      itemPolicy({ excluded: true, excludedFields: [pin] }),
    ]);
  });

  it("records the current evidence when an item gains its first custom-field exclusion", async () => {
    const memory = stored(settings());
    const store = storeFor(memory);
    expect(
      await store.handle(
        save(3, settings({ itemPolicies: [itemPolicy({ excludedFields: [pin] })] })),
      ),
    ).toMatchObject({ ok: true, snapshot: { revision: 4 } });
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
    // The item is reviewed and its exclusion applies.
    expect(getItemEligibility(memory.value!.settings, catalog(), "vault", "item-1")).toMatchObject({
      eligible: true,
    });
    expect(isFieldExcluded(memory.value!.settings, catalog(), "vault", "item-1", custom(2))).toBe(
      true,
    );
    // A later change of a reviewed item's exclusions keeps the existing record.
    const branch = { custom: "Branch", position: 1, count: 1 } as const;
    expect(
      await store.handle(
        save(4, settings({ itemPolicies: [itemPolicy({ excludedFields: [pin, branch] })] })),
      ),
    ).toMatchObject({ ok: true });
    expect(memory.value!.settings.itemPolicies[0]!.excludedFields).toEqual([pin, branch]);
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
    const later = catalog([item({ evidence: evidence("b") })]);
    const relaxed = storeFor(memory, later);
    expect(
      await relaxed.handle(
        save(5, settings({ itemPolicies: [itemPolicy({ excludedFields: [] })] })),
      ),
    ).toMatchObject({ ok: true });
    // The evidence changed, so the item waits for review and keeps its stored references.
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
    expect(memory.value!.settings.itemPolicies[0]!.excludedFields).toEqual([pin, branch]);
  });

  it("records the first exclusion once for an account connected twice", async () => {
    const one = catalog();
    const twice = { connections: [...one.connections, { ...one.connections[0]!, id: "again" }] };
    const memory = stored(settings());
    expect(
      await storeFor(memory, twice).handle(
        save(3, settings({ itemPolicies: [itemPolicy({ excludedFields: [pin] })] })),
      ),
    ).toMatchObject({ ok: true });
    expect(memory.value!.settings.customFieldReviews).toEqual([review()]);
  });

  it("records nothing for built-in exclusions or an item without evidence", async () => {
    const memory = stored(settings());
    const store = storeFor(
      memory,
      catalog([item({ evidence: undefined, revisionDate: undefined })]),
    );
    expect(
      await store.handle(
        save(3, settings({ itemPolicies: [itemPolicy({ excludedFields: ["login.password"] })] })),
      ),
    ).toMatchObject({ ok: true });
    expect(memory.value!.settings.customFieldReviews).toEqual([]);
    expect(
      await store.handle(
        save(4, settings({ itemPolicies: [itemPolicy({ excludedFields: [pin] })] })),
      ),
    ).toMatchObject({ ok: true });
    expect(memory.value!.settings.customFieldReviews).toEqual([]);
    // Without a record, the item waits for review rather than silently using the field.
    expect(
      getItemEligibility(
        memory.value!.settings,
        catalog([item({ evidence: undefined, revisionDate: undefined })]),
        "vault",
        "item-1",
      ),
    ).toEqual({
      eligible: false,
      reason: "review-required",
    });
  });

  it("refuses a save whose kept exclusions exceed the item limit, without writing", async () => {
    const blocked = catalog([item({ evidence: evidence("b") })]);
    const memory = stored(
      settings({
        itemPolicies: [itemPolicy({ excludedFields: [pin] })],
        customFieldReviews: [review()],
      }),
    );
    const store = storeFor(memory, blocked);
    const builtins = Array.from({ length: 50 }, (_, index) => `field.${index}`);
    expect(
      await store.handle(
        save(3, settings({ itemPolicies: [itemPolicy({ excludedFields: builtins })] })),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid-settings" } });
    expect(memory.writes).toHaveLength(0);
  });

  it("leaves trusted updates unchanged", async () => {
    const memory = stored(settings({ customFieldReviews: [review()] }));
    const store = storeFor(memory, catalog([item({ evidence: evidence("b") })]));
    const next = await store.update(3, (snapshot) => ({
      ...snapshot,
      settings: { ...snapshot.settings, customFieldReviews: [review({ evidence: evidence("b") })] },
    }));
    expect(next.revision).toBe(4);
    expect(memory.value!.settings.customFieldReviews).toEqual([
      review({ evidence: evidence("b") }),
    ]);
  });
});
