import {
  excludedFieldReference,
  type ExcludedField,
  type LocalSettings,
  type VaultConnectionMetadata,
} from "@pateat/contracts";

type SyncedPolicy = Pick<LocalSettings, "accountPolicies" | "itemPolicies" | "customFieldReviews">;

/**
 * One connection's synced policy (ADR 0023), keyed by its account: whether it is used, the
 * items chosen when only some are (all when `selectedItemIds` is absent), and the items
 * and fields excluded, by catalog field ID. A custom-field exclusion is recorded as
 * reviewed against the item's evidence, which the catalog item must carry.
 */
export function connectionPolicy(
  connection: Pick<VaultConnectionMetadata, "provider" | "server" | "userId" | "label" | "items">,
  change: {
    enabled?: boolean;
    selectedItemIds?: string[];
    excludedItemIds?: string[];
    excludedFields?: { itemId: string; fieldId: string }[];
  } = {},
): SyncedPolicy {
  if (!connection.userId) throw new Error("A connection's policy needs its user ID");
  const account = {
    provider: connection.provider,
    server: connection.server,
    userId: connection.userId,
  };
  const itemIds = new Set([
    ...(change.selectedItemIds ?? []),
    ...(change.excludedItemIds ?? []),
    ...(change.excludedFields ?? []).map((entry) => entry.itemId),
  ]);
  const itemPolicies: SyncedPolicy["itemPolicies"] = [];
  const customFieldReviews: SyncedPolicy["customFieldReviews"] = [];
  for (const itemId of itemIds) {
    const item = connection.items.find((entry) => entry.id === itemId);
    const excludedFields = (change.excludedFields ?? [])
      .filter((entry) => entry.itemId === itemId)
      .map((entry): ExcludedField => {
        // A built-in field is named by its ID even when the item is not in the catalog.
        const reference = item
          ? excludedFieldReference(item.fields, entry.fieldId)
          : entry.fieldId.startsWith("custom.")
            ? undefined
            : entry.fieldId;
        if (reference === undefined) throw new Error(`${itemId} has no field ${entry.fieldId}`);
        return reference;
      });
    itemPolicies.push({
      ...account,
      itemId,
      itemName: item?.label ?? itemId,
      selected: change.selectedItemIds?.includes(itemId) ?? false,
      excluded: change.excludedItemIds?.includes(itemId) ?? false,
      excludedFields,
    });
    if (excludedFields.some((reference) => typeof reference !== "string")) {
      if (!item?.evidence || !item.revisionDate)
        throw new Error(`${itemId} needs evidence and a revision date to exclude custom fields`);
      customFieldReviews.push({
        ...account,
        itemId,
        evidence: item.evidence,
        revisionDate: item.revisionDate,
      });
    }
  }
  return {
    accountPolicies: [
      {
        ...account,
        accountName: connection.label,
        enabled: change.enabled ?? true,
        selection: change.selectedItemIds ? { mode: "selected", groups: [] } : { mode: "all" },
      },
    ],
    itemPolicies,
    customFieldReviews,
  };
}
