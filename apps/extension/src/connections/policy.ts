import {
  createSettingsStore,
  createDefaultSettings,
  type SettingsSnapshot,
  type VaultCatalog,
} from "@pateat/contracts";
import type { VaultEntry } from "../vault/record";
import { sameVaultEntry } from "../vault/record";
import type { ConnectionPolicy } from "./types";

function protectedItemIds(snapshot: SettingsSnapshot, connectionId: string): string[] {
  const policy = snapshot.fieldPolicies?.find((entry) => entry.connectionId === connectionId);
  const connection = snapshot.settings.connections.find(
    (entry) => entry.connectionId === connectionId,
  );
  return [
    ...new Set([
      ...(policy?.protectedItemIds ?? []),
      ...(connection?.excludedFields
        .filter((ref) => ref.fieldId.startsWith("custom."))
        .map((ref) => ref.itemId) ?? []),
    ]),
  ];
}
export function quarantinedItems(
  snapshot: SettingsSnapshot,
  connectionId: string,
  snapshotId: string,
): string[] {
  const policy = snapshot.fieldPolicies?.find((entry) => entry.connectionId === connectionId);
  const unresolved =
    !policy || policy.snapshotId !== snapshotId ? protectedItemIds(snapshot, connectionId) : [];
  return [...new Set([...(policy?.quarantinedItemIds ?? []), ...unresolved])];
}
function customEvidence(entry: VaultEntry | null, id: string): unknown {
  const cipher = entry?.accepted?.prepared.ciphers.find((item) => String(item.id) === id);
  if (!cipher) return undefined;
  // Sealed data contains custom fields; compare the complete encrypted representation.
  // Key/context changes cannot prove ordinal identity, even if labels remain the same.
  let sealed = false;
  if (cipher.data) {
    try {
      sealed = Object.hasOwn(JSON.parse(cipher.data), "format_version");
    } catch {
      return undefined;
    }
  }
  return {
    ...(sealed ? { data: cipher.data } : { fields: cipher.fields ?? [] }),
    key: cipher.key ?? null,
    organizationId: cipher.organizationId ?? null,
  };
}
type SettingsStore = ReturnType<typeof createSettingsStore>;
/** This background-only policy protects custom denies across independent cache/settings commits. */
export function createConnectionPolicy(options: {
  settings: SettingsStore;
  current(
    connectionId: string,
  ): Promise<{ entry: VaultEntry; catalog: VaultCatalog["connections"][number] }>;
}): ConnectionPolicy {
  return {
    async quarantined(connectionId, snapshotId) {
      return quarantinedItems(await options.settings.read(), connectionId, snapshotId);
    },
    async protectedItems(connectionId) {
      return protectedItemIds(await options.settings.read(), connectionId);
    },
    async register(connectionId, enabled) {
      await options.settings.update(undefined, "vault-added", (snapshot) => {
        if (!snapshot.settings.connections.some((entry) => entry.connectionId === connectionId))
          snapshot.settings.connections.push({
            connectionId,
            enabled,
            selection: { mode: "all", groupIds: [], itemIds: [] },
            excludedItemIds: [],
            excludedFields: [],
          });
        return snapshot;
      });
    },
    async adopt(input) {
      const captured = structuredClone(input);
      const accepted = captured.next.accepted;
      if (!accepted) throw new Error("invalid-request");
      const id = captured.next.profile.connectionId;
      let review: string[] = [];
      const cause = captured.automatic ? "automatic-vault-sync" : "vault-sync";
      await options.settings.update(undefined, cause, (snapshot) => {
        let connection = snapshot.settings.connections.find((entry) => entry.connectionId === id);
        if (!connection) {
          connection = createDefaultSettings({ connections: [captured.catalog] }).connections[0]!;
          snapshot.settings.connections.push(connection);
        }
        const priorBinding = snapshot.fieldPolicies?.find((entry) => entry.connectionId === id);
        review = [...(priorBinding?.quarantinedItemIds ?? [])];
        const protectedItems = protectedItemIds(snapshot, id);
        // Equal decrypted custom fields count as unchanged evidence: Bitwarden re-encrypts
        // the whole item on every save, so other edits change the ciphertext too.
        const sameFields = new Set(captured.sameCustomFields ?? []);
        const unchangedFields = (itemId: string) => {
          const before = customEvidence(captured.previous, itemId);
          const after = customEvidence(captured.next, itemId);
          return (
            before !== undefined &&
            after !== undefined &&
            (sameFields.has(itemId) || sameVaultEntry(before, after))
          );
        };
        for (const itemId of protectedItems) {
          if (
            priorBinding?.snapshotId !== captured.previous?.accepted?.snapshotId ||
            !unchangedFields(itemId)
          )
            review.push(itemId);
        }
        for (const ref of connection.excludedFields) {
          if (!ref.fieldId.startsWith("custom.")) continue;
          const parts = /^custom\.([0-9a-f-]{36})\.(\d+)$/.exec(ref.fieldId);
          const old = captured.previous?.accepted;
          const unchanged =
            old &&
            parts?.[1] === old.snapshotId &&
            (!priorBinding || priorBinding.snapshotId === old.snapshotId) &&
            !review.includes(ref.itemId) &&
            unchangedFields(ref.itemId);
          const nextId = parts ? `custom.${accepted.snapshotId}.${parts[2]}` : undefined;
          if (
            unchanged &&
            captured.catalog.items
              .find((item) => item.id === ref.itemId)
              ?.fields.some((field) => field.id === nextId)
          )
            ref.fieldId = nextId!;
          else review.push(ref.itemId);
        }
        review = [...new Set(review)];
        snapshot.fieldPolicies = [
          ...(snapshot.fieldPolicies ?? []).filter((entry) => entry.connectionId !== id),
          {
            connectionId: id,
            snapshotId: accepted.snapshotId,
            quarantinedItemIds: review,
            protectedItemIds: protectedItems,
          },
        ];
        return snapshot;
      });
      return { policyReviewItemIds: review };
    },
    async review(input) {
      const captured = structuredClone(input);
      const current = await options.current(captured.connectionId);
      if (current.entry.accepted?.snapshotId !== captured.snapshotId)
        throw new Error("revision-conflict");
      const item = current.catalog.items.find((entry) => entry.id === captured.itemId);
      if (
        !item ||
        new Set(captured.excludedFieldIds).size !== captured.excludedFieldIds.length ||
        captured.excludedFieldIds.some(
          (id) =>
            !id.startsWith(`custom.${captured.snapshotId}.`) ||
            !item.fields.some((field) => field.id === id),
        )
      )
        throw new Error("invalid-request");
      let review: string[] = [];
      await options.settings.update(captured.expectedRevision, "field-review", (snapshot) => {
        review = quarantinedItems(snapshot, captured.connectionId, captured.snapshotId);
        if (!review.includes(captured.itemId)) throw new Error("revision-conflict");
        const connection = snapshot.settings.connections.find(
          (entry) => entry.connectionId === captured.connectionId,
        );
        if (!connection) throw new Error("invalid-request");
        connection.excludedFields = [
          ...connection.excludedFields.filter(
            (ref) => ref.itemId !== captured.itemId || !ref.fieldId.startsWith("custom."),
          ),
          ...captured.excludedFieldIds.map((fieldId) => ({ itemId: captured.itemId, fieldId })),
        ];
        review = review.filter((id) => id !== captured.itemId);
        const prior = snapshot.fieldPolicies?.find(
          (entry) => entry.connectionId === captured.connectionId,
        );
        snapshot.fieldPolicies = [
          ...(snapshot.fieldPolicies ?? []).filter(
            (entry) => entry.connectionId !== captured.connectionId,
          ),
          {
            connectionId: captured.connectionId,
            snapshotId: captured.snapshotId,
            quarantinedItemIds: review,
            protectedItemIds: [
              ...new Set([
                ...(prior?.protectedItemIds ?? []),
                captured.itemId,
                ...connection.excludedFields
                  .filter((ref) => ref.fieldId.startsWith("custom."))
                  .map((ref) => ref.itemId),
              ]),
            ],
          },
        ];
        return snapshot;
      });
      // Recheck after the independent settings write; a concurrent newer vault never
      // makes this review authorize another snapshot.
      if (
        (await options.current(captured.connectionId)).entry.accepted?.snapshotId !==
        captured.snapshotId
      )
        throw new Error("revision-conflict");
      return { policyReviewItemIds: review };
    },
  };
}
