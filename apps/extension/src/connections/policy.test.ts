import { describe, expect, it, vi } from "vitest";
import {
  createSettingsStore,
  type LocalSettings,
  type SettingsSnapshot,
  type VaultAccount,
  type VaultCatalog,
} from "@pateat/contracts";
import { createBitwardenAccountMapper } from "@pateat/bitwarden";
import { parsePasswordTokenOutcome } from "../../../../packages/bitwarden/src/auth-models";
import {
  rawCustomAccount,
  type CustomAccountVariant,
} from "../../../../packages/bitwarden/src/__fixtures__/connection";
import {
  accountNow,
  accountProfile,
  accountUserId,
} from "../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Email } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { activeEntry } from "../vault/__fixtures__/vault";
import { createConnectionPolicy, itemEvidence, reviewBlockedItems, withEvidence } from "./policy";

// Synthetic accounts and ciphertexts only. Every entry gets its own snapshot ID, because
// evidence is cached per accepted snapshot.

type Entry = ReturnType<typeof entry>;
type CatalogConnection = VaultCatalog["connections"][number];

const connectionId = accountProfile.connectionId;
const account: VaultAccount = { provider: "bitwarden", server: "cloud-us", userId: accountUserId };
const evidencePattern = /^bitwarden-v1:sha256:[0-9a-f]{64}$/;
/** The fixture ciphers' own revision date. */
const fixtureRevision = "2024-01-30T17:55:36.150Z";
const later = "2024-02-01T08:00:00.1234567Z";

function entry(
  variant: CustomAccountVariant,
  options: { revisionDate?: string | undefined; snapshot?: string } = {},
) {
  const raw = rawCustomAccount(variant);
  const token = parsePasswordTokenOutcome(raw.token, 200);
  const mapper = createBitwardenAccountMapper(
    accountProfile,
    { kind: "bootstrap", email: v1Email },
    { nowSeconds: () => accountNow },
  );
  if (!token || token.kind !== "authenticated" || !mapper.ok)
    throw new Error("Synthetic account admission failed");
  const prepared = mapper.data.map({ connectionId, authenticated: token, sync: raw.sync });
  if (!prepared.ok) throw new Error("Synthetic account mapping failed");
  const result = activeEntry();
  result.accepted.prepared = prepared.data;
  result.accepted.snapshotId = options.snapshot ?? crypto.randomUUID();
  if (options.revisionDate)
    result.accepted.prepared.ciphers[0]!.revisionDate = options.revisionDate as never;
  result.revision = crypto.randomUUID();
  return result;
}
const itemIdOf = (record: Entry) => String(record.accepted.prepared.ciphers[0]!.id);

/**
 * The catalog of one snapshot: the item's custom fields share one name, except the Linked
 * field, which is unnamed here so that the unnamed group is covered too.
 */
function catalog(record: Entry): CatalogConnection {
  const cipher = record.accepted.prepared.ciphers[0]!;
  const snapshot = record.accepted.snapshotId;
  return {
    id: connectionId,
    label: "Synthetic vault",
    provider: "bitwarden",
    server: "cloud-us",
    userId: record.accepted.userId,
    snapshotId: snapshot,
    groups: [],
    items: [
      {
        id: String(cipher.id),
        label: "Duplicate custom labels",
        allowedOrigins: [],
        groupIds: [],
        fields: [
          { id: "login.password", label: "Password", name: null, kind: "hidden" as const },
          ...(cipher.fields ?? []).map((field, ordinal) => {
            const linked = (field as { type?: number }).type === 3;
            return {
              id: `custom.${snapshot}.${ordinal}`,
              label: linked ? "Linked" : "Duplicate label",
              name: linked ? null : "Duplicate label",
              kind: linked ? ("linked" as const) : ("text" as const),
            };
          }),
        ],
      },
      {
        id: "unaffected",
        label: "Unrelated login",
        allowedOrigins: [],
        groupIds: [],
        fields: [{ id: "login.password", label: "Password", name: null, kind: "hidden" as const }],
      },
    ],
  };
}
/** The catalog as the connection runtime shows it, with each item's evidence. */
async function shown(record: Entry): Promise<CatalogConnection> {
  return withEvidence(catalog(record), await itemEvidence(record));
}
async function evidenceOf(record: Entry) {
  const found = (await itemEvidence(record)).get(itemIdOf(record));
  if (!found) throw new Error("Synthetic item has no evidence");
  return found;
}

const accountPolicy = (enabled = true): LocalSettings["accountPolicies"][number] => ({
  ...account,
  accountName: "Synthetic vault",
  enabled,
  selection: { mode: "all" },
});
const secondDuplicate = { custom: "Duplicate label", position: 2, count: 3 } as const;

async function harness(
  variant: CustomAccountVariant = "unchanged",
  options: {
    /** The next snapshot's cipher revision date; the fixture's own when absent. */
    nextRevision?: string;
    /** The review record's revision date; the previous snapshot's when absent. */
    recordRevision?: string;
    /** Whether the synced settings hold the account's policy. */
    policy?: boolean;
  } = {},
) {
  const previous = entry("unchanged");
  let next = entry(variant, { revisionDate: options.nextRevision });
  const itemId = itemIdOf(previous);
  const reviewed = await evidenceOf(previous);
  let snapshot: SettingsSnapshot = {
    version: 1,
    revision: 7,
    settings: {
      connections: [],
      accountPolicies: options.policy === false ? [] : [accountPolicy()],
      itemPolicies: [
        {
          ...account,
          itemId,
          itemName: "Duplicate custom labels",
          selected: false,
          excluded: false,
          excludedFields: ["login.totp", secondDuplicate],
        },
        {
          ...account,
          itemId: "unaffected",
          itemName: "Unrelated login",
          selected: false,
          excluded: false,
          excludedFields: ["login.password"],
        },
      ],
      customFieldReviews: [
        {
          ...account,
          itemId,
          evidence: reviewed.evidence,
          revisionDate: options.recordRevision ?? reviewed.revisionDate!,
        },
      ],
      excludedSites: [],
      siteDefaults: [],
      bindings: [],
    },
  };
  const storage = {
    read: vi.fn(async () => structuredClone(snapshot)),
    write: vi.fn(async (input: unknown) => {
      snapshot = structuredClone(input) as SettingsSnapshot;
    }),
  };
  // The settings page's catalog carries evidence, as the connection runtime builds it.
  const settings = createSettingsStore(storage, async () => ({ connections: [await shown(next)] }));
  const current = vi.fn(async () => ({
    entry: structuredClone(next),
    catalog: catalog(next),
  }));
  const knownAccount = vi.fn(async (id: string) => (id === connectionId ? account : undefined));
  const policy = createConnectionPolicy({ settings, current, account: knownAccount });
  return {
    previous,
    get next() {
      return next;
    },
    itemId,
    reviewed,
    storage,
    settings,
    current,
    policy,
    read: () => structuredClone(snapshot),
    setSnapshot: (value: SettingsSnapshot) => {
      snapshot = structuredClone(value);
    },
    replaceCurrent: (record: Entry) => {
      next = record;
    },
    adopt: (sameCustomFields?: string[], from: Entry | null = previous) =>
      policy.adopt({
        previous: from,
        next,
        catalog: catalog(next),
        ...(sameCustomFields ? { sameCustomFields } : {}),
      }),
    review: (excludedFieldIds: string[], overrides: { snapshotId?: string } = {}) =>
      policy.review!({
        connectionId,
        itemId,
        snapshotId: overrides.snapshotId ?? next.accepted.snapshotId,
        expectedRevision: snapshot.revision,
        excludedFieldIds,
      }),
    blocked: async () => reviewBlockedItems(structuredClone(snapshot), await shown(next)),
    record: () => snapshot.settings.customFieldReviews.find((entry) => entry.itemId === itemId),
    itemPolicy: () => snapshot.settings.itemPolicies.find((entry) => entry.itemId === itemId),
  };
}

describe("custom-field evidence", () => {
  it("hashes each item's encrypted custom fields with the provider's prefix and keeps its revision date", async () => {
    const record = entry("unchanged");
    const evidence = await itemEvidence(record);
    expect([...evidence.keys()]).toEqual([itemIdOf(record)]);
    expect(evidence.get(itemIdOf(record))).toEqual({
      evidence: expect.stringMatching(evidencePattern),
      revisionDate: fixtureRevision,
    });
    // Only an accepted snapshot has evidence.
    expect(await itemEvidence(null)).toEqual(new Map());
  });

  it("is the same on every device whatever order the server's keys arrived in", async () => {
    const first = entry("unchanged");
    const second = entry("unchanged");
    const reversed = <T extends object>(value: T): T =>
      Object.fromEntries(Object.entries(value).reverse()) as T;
    second.accepted.prepared.ciphers = second.accepted.prepared.ciphers.map((cipher) =>
      reversed({ ...cipher, ...(cipher.fields ? { fields: cipher.fields.map(reversed) } : {}) }),
    );
    const fieldKeys = (record: Entry) =>
      Object.keys(record.accepted.prepared.ciphers[0]!.fields![0]!);
    expect(fieldKeys(second)).toEqual(fieldKeys(first).reverse());
    expect(await evidenceOf(second)).toEqual(await evidenceOf(first));
  });

  it("changes with the custom-field ciphertext only", async () => {
    const unchanged = (await evidenceOf(entry("unchanged"))).evidence;
    // A built-in field's change leaves the custom fields' ciphertext as it was.
    expect((await evidenceOf(entry("builtin-changed"))).evidence).toBe(unchanged);
    for (const variant of ["changed", "reordered", "removed", "reencrypted"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- independent snapshots
      const changed = (await evidenceOf(entry(variant))).evidence;
      expect(changed, variant).toMatch(evidencePattern);
      expect(changed, variant).not.toBe(unchanged);
    }
  });

  it("hashes a sealed item's data rather than its fields, and skips unreadable data", async () => {
    const sealed = (record: Entry, data: object, fields?: unknown[]) => {
      const cipher = record.accepted.prepared.ciphers[0]!;
      cipher.data = JSON.stringify({ format_version: 1, ...data }) as never;
      if (fields) cipher.fields = fields as never;
      return record;
    };
    const first = await evidenceOf(sealed(entry("unchanged"), { envelope: "one" }));
    // The sealed data holds the custom fields; separate `fields` do not count.
    expect(await evidenceOf(sealed(entry("unchanged"), { envelope: "one" }, []))).toEqual(first);
    expect((await evidenceOf(sealed(entry("unchanged"), { envelope: "two" }))).evidence).not.toBe(
      first.evidence,
    );
    const unreadable = entry("unchanged");
    unreadable.accepted.prepared.ciphers[0]!.data = "{not json" as never;
    expect(await itemEvidence(unreadable)).toEqual(new Map());
  });

  it("leaves out a revision date that is not an instant", async () => {
    const record = entry("unchanged", { revisionDate: "yesterday" });
    expect(await evidenceOf(record)).toEqual({ evidence: expect.stringMatching(evidencePattern) });
  });
});

describe("custom-field review across vault syncs", () => {
  it.each(["unchanged", "builtin-changed"] satisfies CustomAccountVariant[])(
    "keeps an item usable when the custom fields' ciphertext is unchanged (%s)",
    async (variant) => {
      const h = await harness(variant);
      const before = h.read().settings;
      expect(await h.adopt()).toEqual({ policyReviewItemIds: [] });
      expect(h.read().settings).toEqual(before);
      expect(h.read().olderAfterSync).toBeUndefined();
      expect(await h.policy.quarantined!(connectionId, h.next.accepted.snapshotId)).toEqual([]);
    },
  );

  it.each(["changed", "reordered", "removed", "reencrypted"] satisfies CustomAccountVariant[])(
    "blocks only the affected item when its custom ciphertext changed (%s)",
    async (variant) => {
      const h = await harness(variant);
      const before = h.read().settings;
      expect(await h.adopt()).toEqual({ policyReviewItemIds: [h.itemId] });
      // The record and the exclusions stay as reviewed; nothing guesses the new ordinals.
      expect(h.read().settings).toEqual(before);
      expect(await h.policy.quarantined!(connectionId, h.next.accepted.snapshotId)).toEqual([
        h.itemId,
      ]);
      expect(await h.blocked()).toEqual({ blocked: [h.itemId], stale: [] });
    },
  );

  it("keeps the review of a re-encrypted item whose decrypted custom fields are equal", async () => {
    const h = await harness("reencrypted", { nextRevision: later });
    expect(await h.adopt([h.itemId])).toEqual({ policyReviewItemIds: [] });
    const now = await evidenceOf(h.next);
    expect(now.evidence).not.toBe(h.reviewed.evidence);
    expect(h.record()).toEqual({
      ...account,
      itemId: h.itemId,
      evidence: now.evidence,
      revisionDate: later,
    });
    // The exclusions are references and need no rebinding.
    expect(h.itemPolicy()!.excludedFields).toEqual(["login.totp", secondDuplicate]);
    expect(await h.policy.quarantined!(connectionId, h.next.accepted.snapshotId)).toEqual([]);
  });

  it("blocks a re-encrypted item the crypto host did not find equal", async () => {
    const h = await harness("reencrypted", { nextRevision: later });
    const record = h.record();
    // Another item's equality says nothing about this one.
    expect(await h.adopt(["unaffected"])).toEqual({ policyReviewItemIds: [h.itemId] });
    expect(h.record()).toEqual(record);
  });

  it("never carries a review across from a previous snapshot the record does not name", async () => {
    const h = await harness("reencrypted", { nextRevision: later });
    const other = h.read();
    other.settings.customFieldReviews[0]!.evidence = `bitwarden-v1:sha256:${"0".repeat(64)}`;
    h.setSnapshot(other);
    expect(await h.adopt([h.itemId])).toEqual({ policyReviewItemIds: [h.itemId] });
    expect(h.record()!.evidence).toBe(`bitwarden-v1:sha256:${"0".repeat(64)}`);
  });

  it("relies on the synced record on a device without the previous snapshot", async () => {
    const h = await harness("reencrypted", { nextRevision: later });
    expect(await h.adopt([h.itemId], null)).toEqual({ policyReviewItemIds: [h.itemId] });
  });

  it("a failed settings write leaves the settings as they were and the new snapshot blocked", async () => {
    const h = await harness("changed");
    const old = h.read();
    h.storage.write.mockRejectedValueOnce(new Error("Synthetic storage unavailable"));
    await expect(h.adopt()).rejects.toThrow();
    expect(h.read()).toEqual(old);
    expect(await h.policy.quarantined!(connectionId, h.next.accepted.snapshotId)).toEqual([
      h.itemId,
    ]);
  });

  it("reports no quarantine for a snapshot that is not the current one", async () => {
    const h = await harness("changed");
    expect(await h.policy.quarantined!(connectionId, h.previous.accepted.snapshotId)).toEqual([]);
  });

  it("refuses an adoption whose catalog names another account", async () => {
    const h = await harness("changed");
    const old = h.read();
    await expect(
      h.policy.adopt({
        previous: h.previous,
        next: h.next,
        catalog: { ...catalog(h.next), userId: "another-account" },
      }),
    ).rejects.toThrow("invalid-request");
    expect(h.read()).toEqual(old);
  });
});

describe("a local copy older than its review record", () => {
  // Another device reviewed a newer revision of the item than this device has synced.
  const newer = "2025-06-01T00:00:00.000000001Z";

  it("asks for a vault sync before the item can be reviewed", async () => {
    const h = await harness("changed", { recordRevision: newer });
    expect(await h.blocked()).toEqual({ blocked: [h.itemId], stale: [h.itemId] });
    const old = h.read();
    await expect(h.review([])).rejects.toThrow("revision-conflict");
    expect(h.read()).toEqual(old);
  });

  it("offers review once a vault sync found the item still older", async () => {
    const h = await harness("changed", { recordRevision: newer });
    expect(await h.adopt()).toEqual({ policyReviewItemIds: [h.itemId] });
    expect(h.read().olderAfterSync).toEqual([
      { connectionId, snapshotId: h.next.accepted.snapshotId, itemIds: [h.itemId] },
    ]);
    expect(await h.blocked()).toEqual({ blocked: [h.itemId], stale: [] });
    expect(await h.review([])).toEqual({ policyReviewItemIds: [] });
    expect(h.record()).toMatchObject({
      evidence: (await evidenceOf(h.next)).evidence,
      revisionDate: fixtureRevision,
    });
  });

  it("asks for a sync again once another snapshot is accepted, and forgets items no longer older", async () => {
    const h = await harness("changed", { recordRevision: newer });
    await h.adopt();
    const synced = h.next;
    // A snapshot accepted outside the adoption does not inherit the check.
    h.replaceCurrent(entry("changed"));
    expect(await h.blocked()).toEqual({ blocked: [h.itemId], stale: [h.itemId] });
    // A later sync that brings the item up to date drops it from the list.
    h.replaceCurrent(entry("reordered", { revisionDate: "2025-07-01T00:00:00Z" }));
    expect(await h.adopt(undefined, synced)).toEqual({ policyReviewItemIds: [h.itemId] });
    expect(h.read().olderAfterSync).toBeUndefined();
    expect(await h.blocked()).toEqual({ blocked: [h.itemId], stale: [] });
  });

  it("does not treat an equal revision date as older", async () => {
    const h = await harness("changed", { recordRevision: fixtureRevision });
    expect(await h.blocked()).toEqual({ blocked: [h.itemId], stale: [] });
    await h.adopt();
    expect(h.read().olderAfterSync).toBeUndefined();
  });
});

describe("explicit custom-field review", () => {
  it("names the excluded fields by reference and records the reviewed evidence", async () => {
    const h = await harness("changed");
    await h.adopt();
    const snapshot = h.next.accepted.snapshotId;
    expect(await h.review([`custom.${snapshot}.0`, `custom.${snapshot}.2`])).toEqual({
      policyReviewItemIds: [],
    });
    // Built-in exclusions stay; the custom ones are replaced by what was reviewed.
    expect(h.itemPolicy()!.excludedFields).toEqual([
      "login.totp",
      { custom: "Duplicate label", position: 1, count: 3 },
      { custom: "Duplicate label", position: 3, count: 3 },
    ]);
    expect(h.record()).toEqual({
      ...account,
      itemId: h.itemId,
      ...(await evidenceOf(h.next)),
    });
    expect(h.read().settings.itemPolicies.find((entry) => entry.itemId === "unaffected")).toEqual(
      expect.objectContaining({ excludedFields: ["login.password"] }),
    );
    expect(await h.policy.quarantined!(connectionId, snapshot)).toEqual([]);
  });

  it("names an unnamed custom field as the unnamed group", async () => {
    const h = await harness("changed");
    await h.adopt();
    await h.review([`custom.${h.next.accepted.snapshotId}.3`]);
    expect(h.itemPolicy()!.excludedFields).toEqual([
      "login.totp",
      { custom: null, position: 1, count: 1 },
    ]);
  });

  it("creates the item's policy when it had none, and drops one left with nothing", async () => {
    const h = await harness("changed");
    await h.adopt();
    const without = h.read();
    without.settings.itemPolicies = without.settings.itemPolicies.filter(
      (entry) => entry.itemId !== h.itemId,
    );
    h.setSnapshot(without);
    await h.review([`custom.${h.next.accepted.snapshotId}.1`]);
    expect(h.itemPolicy()).toEqual({
      ...account,
      itemId: h.itemId,
      itemName: "Duplicate custom labels",
      selected: false,
      excluded: false,
      excludedFields: [{ custom: "Duplicate label", position: 2, count: 3 }],
    });

    const allowed = await harness("changed");
    await allowed.adopt();
    const builtinFree = allowed.read();
    builtinFree.settings.itemPolicies[0]!.excludedFields = [secondDuplicate];
    allowed.setSnapshot(builtinFree);
    await allowed.review([]);
    // Allowing every custom field leaves no exclusion; the record keeps the item reviewed.
    expect(allowed.itemPolicy()).toBeUndefined();
    expect(allowed.record()).toMatchObject({ evidence: (await evidenceOf(allowed.next)).evidence });
  });

  it.each(["changed", "reordered"] satisfies CustomAccountVariant[])(
    "keeps an all-allowed review and checks %s ciphertext on the next adoption",
    async (variant) => {
      const h = await harness("changed");
      await h.adopt();
      await h.review([]);
      const reviewed = h.next;
      h.replaceCurrent(entry(variant));
      const outcome = await h.adopt(undefined, reviewed);
      // The same ciphertext as reviewed is still reviewed; other ciphertext is not.
      expect(outcome.policyReviewItemIds).toEqual(variant === "changed" ? [] : [h.itemId]);
      expect(outcome.policyReviewItemIds).not.toContain("unaffected");
    },
  );

  it("refuses an item that is not waiting for review", async () => {
    const h = await harness("unchanged");
    await h.adopt();
    const old = h.read();
    await expect(h.review([])).rejects.toThrow("revision-conflict");
    expect(h.read()).toEqual(old);
  });

  it.each([
    "revision",
    "snapshot",
    "unknown-field",
    "duplicate-field",
    "builtin-field",
    "other-snapshot-field",
  ] as const)("refuses a %s review without changing anything", async (failure) => {
    const h = await harness("changed");
    await h.adopt();
    const old = h.read();
    const snapshot = h.next.accepted.snapshotId;
    const fields = {
      revision: [],
      snapshot: [],
      "unknown-field": [`custom.${snapshot}.99`],
      "duplicate-field": [`custom.${snapshot}.0`, `custom.${snapshot}.0`],
      "builtin-field": ["login.password"],
      "other-snapshot-field": [`custom.${h.previous.accepted.snapshotId}.0`],
    }[failure];
    await expect(
      h.policy.review!({
        connectionId,
        itemId: h.itemId,
        snapshotId: failure === "snapshot" ? h.previous.accepted.snapshotId : snapshot,
        expectedRevision: failure === "revision" ? old.revision - 1 : old.revision,
        excludedFieldIds: fields,
      }),
    ).rejects.toThrow();
    expect(h.read()).toEqual(old);
  });

  it.each([false, true])(
    "a vault replaced during the review's write never lets it authorize the new snapshot (deny=%s)",
    async (deny) => {
      const h = await harness("changed");
      await h.adopt();
      const write = h.storage.write.getMockImplementation()!;
      h.storage.write.mockImplementationOnce(async (snapshot) => {
        await write(snapshot);
        h.replaceCurrent(entry("reordered"));
      });
      await expect(
        h.review(deny ? [`custom.${h.next.accepted.snapshotId}.1`] : []),
      ).rejects.toThrow("revision-conflict");
      expect(await h.policy.quarantined!(connectionId, h.next.accepted.snapshotId)).toEqual([
        h.itemId,
      ]);
    },
  );
});

describe("settings page saves", () => {
  it("cannot remove the custom exclusions or the record of an item waiting for review", async () => {
    const h = await harness("changed");
    await h.adopt();
    const draft = h.read();
    draft.settings.itemPolicies[0]!.excludedFields = ["login.password"];
    draft.settings.customFieldReviews = [];
    const response = await h.settings.handle({
      version: 1,
      type: "settings.save",
      expectedRevision: draft.revision,
      settings: draft.settings,
    });
    expect(response.ok).toBe(true);
    expect(h.itemPolicy()!.excludedFields).toEqual(["login.password", secondDuplicate]);
    expect(h.record()).toMatchObject({ evidence: h.reviewed.evidence });
    expect(await h.policy.quarantined!(connectionId, h.next.accepted.snapshotId)).toEqual([
      h.itemId,
    ]);
  });

  it("records the current evidence with an item's first custom exclusion", async () => {
    const h = await harness("unchanged");
    const draft = h.read();
    draft.settings.customFieldReviews = [];
    draft.settings.itemPolicies[0]!.excludedFields = [];
    h.setSnapshot(draft);
    const added = h.read();
    added.settings.itemPolicies[0]!.excludedFields = [secondDuplicate];
    const response = await h.settings.handle({
      version: 1,
      type: "settings.save",
      expectedRevision: added.revision,
      settings: added.settings,
    });
    expect(response.ok).toBe(true);
    expect(h.record()).toEqual({ ...account, itemId: h.itemId, ...(await evidenceOf(h.next)) });
    expect(await h.policy.quarantined!(connectionId, h.next.accepted.snapshotId)).toEqual([]);
  });
});

describe("protected items", () => {
  it("lists the account's items with a review record or a custom exclusion", async () => {
    const h = await harness("changed");
    expect(await h.policy.protectedItems!(connectionId)).toEqual([h.itemId]);
    const edited = h.read();
    edited.settings.customFieldReviews = [];
    edited.settings.itemPolicies.push({
      ...account,
      itemId: "custom-only",
      itemName: "Custom only",
      selected: false,
      excluded: false,
      excludedFields: [{ custom: null }],
    });
    // Entries of another server's account with the same user ID are not this account's.
    edited.settings.itemPolicies.push({
      ...account,
      server: "cloud-eu",
      itemId: "elsewhere",
      itemName: "Elsewhere",
      selected: false,
      excluded: false,
      excludedFields: [{ custom: "PIN" }],
    });
    edited.settings.customFieldReviews.push({
      ...account,
      server: "https://vault.example.test",
      itemId: "self-hosted",
      evidence: h.reviewed.evidence,
      revisionDate: fixtureRevision,
    });
    h.setSnapshot(edited);
    expect(await h.policy.protectedItems!(connectionId)).toEqual([h.itemId, "custom-only"]);
  });

  it("lists nothing for a connection whose account is not known", async () => {
    const h = await harness("changed");
    expect(await h.policy.protectedItems!("other-connection")).toEqual([]);
  });
});

describe("policy choice of a new connection", () => {
  it("creates the account's enabled policy from the add form's choice at the first adoption", async () => {
    const h = await harness("unchanged", { policy: false });
    await h.policy.register(connectionId, true);
    expect(h.read().settings.connections).toEqual([{ connectionId, enabled: true }]);
    await h.adopt();
    expect(h.read().settings.accountPolicies).toEqual([accountPolicy()]);
    // The pending choice is consumed once the account is known.
    expect(h.read().settings.connections).toEqual([]);
  });

  it("creates no policy when the add form left the vault unused", async () => {
    const h = await harness("unchanged", { policy: false });
    await h.policy.register(connectionId, false);
    await h.adopt();
    expect(h.read().settings.accountPolicies).toEqual([]);
    expect(h.read().settings.connections).toEqual([]);
  });

  it("keeps the account's synced policy over the add form's choice", async () => {
    const h = await harness("unchanged");
    const disabled = h.read();
    disabled.settings.accountPolicies = [accountPolicy(false)];
    h.setSnapshot(disabled);
    await h.policy.register(connectionId, true);
    await h.adopt();
    expect(h.read().settings.accountPolicies).toEqual([accountPolicy(false)]);
    expect(h.read().settings.connections).toEqual([]);
  });

  it("a sign-in that completes after registration keeps a later edit of the pending choice", async () => {
    const h = await harness("unchanged", { policy: false });
    await h.policy.register(connectionId, true);
    const edited = h.read();
    edited.settings.connections[0]!.enabled = false;
    h.setSnapshot(edited);
    // "Sign in again" passes no choice; registering again changes nothing.
    await h.policy.register(connectionId, true);
    expect(h.read().settings.connections).toEqual([{ connectionId, enabled: false }]);
    await h.adopt();
    expect(h.read().settings.accountPolicies).toEqual([]);
  });

  it("an adoption without a pending choice creates no policy", async () => {
    const h = await harness("unchanged", { policy: false });
    await h.adopt();
    expect(h.read().settings.accountPolicies).toEqual([]);
  });
});
