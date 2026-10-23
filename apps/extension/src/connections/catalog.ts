import type { LocalVaultMetadata } from "@pateat/bitwarden";
import type { VaultCatalog } from "@pateat/contracts";

/** The settings catalog's entry for an open vault's metadata projection. */
export function catalogEntry(
  connectionId: string,
  connectionLabel: string,
  projected: LocalVaultMetadata,
): VaultCatalog["connections"][number] {
  return {
    id: connectionId,
    label: connectionLabel,
    provider: "bitwarden",
    userId: projected.userId,
    snapshotId: projected.snapshotId,
    groups: projected.groups,
    items: projected.items.map((item) => ({
      id: item.id,
      label: item.label,
      allowedOrigins: [],
      ...(item.inactive ? { inactive: true as const } : {}),
      groupIds: item.groupIds,
      fields: item.fields.map(({ id, label, name, kind, linkedFieldId, empty }) => ({
        id,
        label,
        name,
        kind,
        ...(linkedFieldId ? { linkedFieldId } : {}),
        ...(empty ? { empty } : {}),
      })),
    })),
  };
}
