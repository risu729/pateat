import {
  createSettingsStore,
  createDefaultSettings,
  type SettingsSnapshot,
  type VaultCatalog,
} from "@pateat/contracts";
import type { VaultEntry } from "../vault/record";
import { sameVaultEntry } from "../vault/record";
import type { ConnectionPolicy } from "./types";

export function quarantinedItems(
  snapshot: SettingsSnapshot,
  connectionId: string,
  snapshotId: string,
): string[] {
  const policy = snapshot.fieldPolicies?.find((entry) => entry.connectionId === connectionId);
  const connection = snapshot.settings.connections.find(
    (entry) => entry.connectionId === connectionId,
  );
  const unresolved =
    !policy || policy.snapshotId !== snapshotId
      ? [
          ...(policy?.protectedItemIds ?? []),
          ...(connection?.excludedFields
            .filter((ref) => ref.fieldId.startsWith("custom."))
            .map((ref) => ref.itemId) ?? []),
        ]
      : [];
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
    async adopt(input) {
      const captured = structuredClone(input);
      const accepted = captured.next.accepted;
      if (!accepted) throw new Error("invalid-request");
      const id = captured.next.profile.connectionId;
      let review: string[] = [];
      await options.settings.update(undefined, (snapshot) => {
        let connection = snapshot.settings.connections.find((entry) => entry.connectionId === id);
        if (!connection) {
          connection = createDefaultSettings({ connections: [captured.catalog] }).connections[0]!;
          snapshot.settings.connections.push(connection);
        }
        if (captured.enabled !== undefined) connection.enabled = captured.enabled;
        const priorBinding = snapshot.fieldPolicies?.find((entry) => entry.connectionId === id);
        review = [...(priorBinding?.quarantinedItemIds ?? [])];
        const protectedItems = [
          ...new Set([
            ...(priorBinding?.protectedItemIds ?? []),
            ...connection.excludedFields
              .filter((ref) => ref.fieldId.startsWith("custom."))
              .map((ref) => ref.itemId),
          ]),
        ];
        for (const itemId of protectedItems) {
          if (
            priorBinding?.snapshotId !== captured.previous?.accepted?.snapshotId ||
            !sameVaultEntry(
              customEvidence(captured.previous, itemId),
              customEvidence(captured.next, itemId),
            ) ||
            customEvidence(captured.next, itemId) === undefined
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
            customEvidence(captured.previous, ref.itemId) !== undefined &&
            customEvidence(captured.next, ref.itemId) !== undefined &&
            sameVaultEntry(
              customEvidence(captured.previous, ref.itemId),
              customEvidence(captured.next, ref.itemId),
            );
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
      await options.settings.update(captured.expectedRevision, (snapshot) => {
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
