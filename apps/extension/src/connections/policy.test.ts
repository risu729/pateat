import { describe, expect, it, vi } from "vitest";
import {
  createSettingsStore,
  createDefaultSettings,
  type SettingsSnapshot,
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
} from "../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Email } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { activeEntry, snapshotId } from "../vault/__fixtures__/vault";
import { createConnectionPolicy, quarantinedItems } from "./policy";

const nextSnapshot = "20000000-0000-4000-8000-000000000002";
function entry(variant: CustomAccountVariant, snapshot = snapshotId) {
  const raw = rawCustomAccount(variant);
  const token = parsePasswordTokenOutcome(raw.token, 200);
  const mapper = createBitwardenAccountMapper(
    accountProfile,
    { kind: "bootstrap", email: v1Email },
    { nowSeconds: () => accountNow },
  );
  if (!token || token.kind !== "authenticated" || !mapper.ok)
    throw new Error("Synthetic account admission failed");
  const prepared = mapper.data.map({
    connectionId: accountProfile.connectionId,
    authenticated: token,
    sync: raw.sync,
  });
  if (!prepared.ok) throw new Error("Synthetic account mapping failed");
  const result = activeEntry();
  result.accepted.prepared = prepared.data;
  result.accepted.snapshotId = snapshot;
  result.revision = crypto.randomUUID();
  return result;
}
function catalog(record: ReturnType<typeof entry>): VaultCatalog["connections"][number] {
  const cipher = record.accepted.prepared.ciphers[0]!;
  return {
    id: accountProfile.connectionId,
    label: "Synthetic vault",
    provider: "bitwarden",
    groups: [],
    items: [
      {
        id: String(cipher.id),
        label: "Duplicate custom labels",
        allowedOrigins: [],
        groupIds: [],
        fields: [
          { id: "login.password", label: "Password" },
          ...(cipher.fields ?? []).map((_, ordinal) => ({
            id: `custom.${record.accepted.snapshotId}.${ordinal}`,
            label: "Duplicate label",
          })),
        ],
      },
      {
        id: "unaffected",
        label: "Unrelated login",
        allowedOrigins: [],
        groupIds: [],
        fields: [{ id: "login.password", label: "Password" }],
      },
    ],
  };
}
function harness(variant: CustomAccountVariant = "unchanged") {
  const previous = entry("unchanged");
  let next = entry(variant, nextSnapshot);
  let metadata = catalog(next);
  const itemId = String(previous.accepted.prepared.ciphers[0]!.id);
  let snapshot: SettingsSnapshot = {
    version: 1,
    revision: 7,
    settings: createDefaultSettings({ connections: [catalog(previous)] }),
    fieldPolicies: [
      { connectionId: accountProfile.connectionId, snapshotId, quarantinedItemIds: [] },
    ],
  };
  const connection = snapshot.settings.connections[0]!;
  connection.enabled = false;
  connection.excludedFields = [
    { itemId, fieldId: `custom.${snapshotId}.1` },
    { itemId: "unaffected", fieldId: "login.password" },
  ];
  const storage = {
    read: vi.fn(async () => structuredClone(snapshot)),
    write: vi.fn(async (input: unknown) => {
      snapshot = structuredClone(input) as SettingsSnapshot;
    }),
  };
  const settings = createSettingsStore(storage, async () => ({ connections: [metadata] }));
  const current = vi.fn(async () => ({
    entry: structuredClone(next),
    catalog: structuredClone(metadata),
  }));
  const policy = createConnectionPolicy({ settings, current });
  return {
    previous,
    next,
    itemId,
    storage,
    settings,
    current,
    policy,
    metadata,
    read: () => structuredClone(snapshot),
    setSnapshot: (value: SettingsSnapshot) => {
      snapshot = structuredClone(value);
    },
    setCatalog: (record: ReturnType<typeof entry>) => {
      metadata = catalog(record);
    },
    replaceCurrent: () => {
      next = entry("changed", crypto.randomUUID());
      metadata = catalog(next);
    },
    adopt: () => policy.adopt({ previous, next, catalog: metadata }),
  };
}

describe("snapshot-bound custom field policy", () => {
  it("a deny added then removed by ordinary saves retains history across a cache replacement during removal and restart", async () => {
    const h = harness();
    h.setCatalog(h.previous);
    const initial = h.read();
    initial.settings.connections[0]!.excludedFields = [];
    h.setSnapshot(initial);
    const added = structuredClone(initial.settings);
    added.connections[0]!.excludedFields = [
      { itemId: h.itemId, fieldId: `custom.${snapshotId}.1` },
    ];
    expect(
      (
        await h.settings.handle({
          version: 1,
          type: "settings.save",
          expectedRevision: initial.revision,
          settings: added,
        })
      ).ok,
    ).toBe(true);
    const withDeny = h.read();
    expect(withDeny.fieldPolicies?.[0]).toMatchObject({ snapshotId, protectedItemIds: [h.itemId] });
    const removed = structuredClone(withDeny.settings);
    removed.connections[0]!.excludedFields = [];
    const write = h.storage.write.getMockImplementation()!;
    h.storage.write.mockImplementationOnce(async (snapshot) => {
      await write(snapshot);
      h.replaceCurrent();
    });
    expect(
      (
        await h.settings.handle({
          version: 1,
          type: "settings.save",
          expectedRevision: withDeny.revision,
          settings: removed,
        })
      ).ok,
    ).toBe(true);
    const changed = await h.current();
    expect(
      quarantinedItems(h.read(), accountProfile.connectionId, changed.entry.accepted.snapshotId),
    ).toEqual([h.itemId]);
    // A fresh policy instance reconstructs the same protected state after a crash.
    const restarted = createConnectionPolicy({ settings: h.settings, current: h.current });
    expect(
      await restarted.adopt({
        previous: h.previous,
        next: changed.entry,
        catalog: changed.catalog,
      }),
    ).toEqual({ policyReviewItemIds: [h.itemId] });
    expect(
      quarantinedItems(h.read(), accountProfile.connectionId, changed.entry.accepted.snapshotId),
    ).toEqual([h.itemId]);
  });
  it.each(["unchanged", "builtin-changed"] satisfies CustomAccountVariant[])(
    "rebinds unchanged encrypted custom ordinals after %s while retaining built-in denies and enabled intent",
    async (variant) => {
      const h = harness(variant);
      expect(await h.adopt()).toEqual({ policyReviewItemIds: [] });
      expect(h.read().settings.connections[0]).toMatchObject({
        enabled: false,
        excludedFields: [
          { itemId: h.itemId, fieldId: `custom.${nextSnapshot}.1` },
          { itemId: "unaffected", fieldId: "login.password" },
        ],
      });
      expect(h.read().fieldPolicies).toEqual([
        {
          connectionId: accountProfile.connectionId,
          snapshotId: nextSnapshot,
          quarantinedItemIds: [],
          protectedItemIds: [h.itemId],
        },
      ]);
    },
  );
  it.each(["changed", "reordered", "removed"] satisfies CustomAccountVariant[])(
    "quarantines only the affected item for %s custom ciphertext rather than guessing duplicate labels",
    async (variant) => {
      const h = harness(variant);
      expect(await h.adopt()).toEqual({ policyReviewItemIds: [h.itemId] });
      expect(h.read().settings.connections[0]!.excludedFields[0]).toEqual({
        itemId: h.itemId,
        fieldId: `custom.${snapshotId}.1`,
      });
      expect(quarantinedItems(h.read(), accountProfile.connectionId, nextSnapshot)).toEqual([
        h.itemId,
      ]);
    },
  );
  it("a restart with a new cache but old settings quarantines old custom refs before any adoption retry", () => {
    const h = harness();
    expect(quarantinedItems(h.read(), accountProfile.connectionId, nextSnapshot)).toEqual([
      h.itemId,
    ]);
    expect(h.storage.write).not.toHaveBeenCalled();
  });
  it("a failed settings adoption leaves the old draft intact and the new snapshot dynamically quarantined", async () => {
    const h = harness();
    const old = h.read();
    h.storage.write.mockRejectedValueOnce(new Error("Synthetic storage unavailable"));
    await expect(h.adopt()).rejects.toThrow();
    expect(h.read()).toEqual(old);
    expect(quarantinedItems(h.read(), accountProfile.connectionId, nextSnapshot)).toEqual([
      h.itemId,
    ]);
  });
  it("ordinary settings saves cannot remove an unresolved deny or overwrite its trusted snapshot binding", async () => {
    const h = harness("changed");
    await h.adopt();
    const draft = h.read();
    draft.settings.connections[0]!.excludedFields = [];
    const response = await h.settings.handle({
      version: 1,
      type: "settings.save",
      expectedRevision: draft.revision,
      settings: draft.settings,
    });
    expect(response.ok).toBe(true);
    expect(h.read().settings.connections[0]!.excludedFields).toContainEqual({
      itemId: h.itemId,
      fieldId: `custom.${snapshotId}.1`,
    });
    expect(h.read().fieldPolicies?.[0]?.quarantinedItemIds).toEqual([h.itemId]);
  });
  it("explicit review applies only current known custom IDs at the accepted revision and preserves unrelated denies", async () => {
    const h = harness("changed");
    await h.adopt();
    expect(
      await h.policy.review!({
        connectionId: accountProfile.connectionId,
        itemId: h.itemId,
        snapshotId: nextSnapshot,
        expectedRevision: h.read().revision,
        excludedFieldIds: [`custom.${nextSnapshot}.0`, `custom.${nextSnapshot}.2`],
      }),
    ).toEqual({ policyReviewItemIds: [] });
    expect(h.read().settings.connections[0]!.excludedFields).toEqual([
      { itemId: "unaffected", fieldId: "login.password" },
      { itemId: h.itemId, fieldId: `custom.${nextSnapshot}.0` },
      { itemId: h.itemId, fieldId: `custom.${nextSnapshot}.2` },
    ]);
  });
  it.each(["changed", "reordered"] satisfies CustomAccountVariant[])(
    "retains reviewed-all-allowed item history and checks %s ciphertext on the next adoption",
    async (variant) => {
      const h = harness("changed");
      await h.adopt();
      await h.policy.review!({
        connectionId: accountProfile.connectionId,
        itemId: h.itemId,
        snapshotId: nextSnapshot,
        expectedRevision: h.read().revision,
        excludedFieldIds: [],
      });
      expect(h.read().settings.connections[0]!.excludedFields).toEqual([
        { itemId: "unaffected", fieldId: "login.password" },
      ]);
      expect(h.read().fieldPolicies?.[0]).toMatchObject({
        protectedItemIds: [h.itemId],
        quarantinedItemIds: [],
      });
      const after = entry(variant, crypto.randomUUID());
      const outcome = await h.policy.adopt({
        previous: h.next,
        next: after,
        catalog: catalog(after),
      });
      expect(outcome.policyReviewItemIds).toEqual(variant === "changed" ? [] : [h.itemId]);
      expect(
        quarantinedItems(h.read(), accountProfile.connectionId, after.accepted.snapshotId),
      ).toEqual(outcome.policyReviewItemIds);
      expect(outcome.policyReviewItemIds).not.toContain("unaffected");
    },
  );
  it("rejects an ordinary save if protective deny restoration would exceed the final schema limit", async () => {
    const h = harness("changed");
    await h.adopt();
    const before = h.read();
    const draft = structuredClone(before.settings);
    draft.connections[0]!.excludedFields = Array.from({ length: 1000 }, (_, index) => ({
      itemId: `unrelated-${index}`,
      fieldId: "login.password",
    }));
    h.storage.write.mockClear();
    const result = await h.settings.handle({
      version: 1,
      type: "settings.save",
      expectedRevision: before.revision,
      settings: draft,
    });
    expect(result.ok).toBe(false);
    expect(h.storage.write).not.toHaveBeenCalled();
    expect(h.read()).toEqual(before);
  });
  it.each(["revision", "snapshot", "unknown-field", "duplicate-field"] as const)(
    "rejects %s review without removing quarantine",
    async (failure) => {
      const h = harness("changed");
      await h.adopt();
      const old = h.read();
      await expect(
        h.policy.review!({
          connectionId: accountProfile.connectionId,
          itemId: h.itemId,
          snapshotId: failure === "snapshot" ? snapshotId : nextSnapshot,
          expectedRevision: failure === "revision" ? 7 : old.revision,
          excludedFieldIds:
            failure === "unknown-field"
              ? [`custom.${nextSnapshot}.99`]
              : failure === "duplicate-field"
                ? [`custom.${nextSnapshot}.0`, `custom.${nextSnapshot}.0`]
                : [],
        }),
      ).rejects.toThrow();
      expect(h.read()).toEqual(old);
    },
  );
  it.each([false, true])(
    "a cache replacement during review write never publishes the old review as authorization for the new snapshot (deny=%s)",
    async (deny) => {
      const h = harness("changed");
      await h.adopt();
      const original = h.storage.write.getMockImplementation()!;
      h.storage.write.mockImplementationOnce(async (snapshot) => {
        await original(snapshot);
        h.replaceCurrent();
      });
      await expect(
        h.policy.review!({
          connectionId: accountProfile.connectionId,
          itemId: h.itemId,
          snapshotId: nextSnapshot,
          expectedRevision: h.read().revision,
          excludedFieldIds: deny ? [`custom.${nextSnapshot}.1`] : [],
        }),
      ).rejects.toThrow("revision-conflict");
      const current = await h.current();
      expect(
        quarantinedItems(h.read(), accountProfile.connectionId, current.entry.accepted.snapshotId),
      ).toEqual([h.itemId]);
    },
  );
});
