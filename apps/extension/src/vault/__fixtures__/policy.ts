import type { ExcludedField, LocalSettings, VaultAccount, VaultCatalog } from "@pateat/contracts";

type CatalogConnection = Pick<
  VaultCatalog["connections"][number],
  "provider" | "server" | "userId" | "label"
>;

/** The synced account a synthetic catalog connection names. */
export function accountOf(connection: CatalogConnection): VaultAccount {
  if (connection.userId === undefined) throw new Error("Synthetic connection has no account");
  return { provider: connection.provider, server: connection.server, userId: connection.userId };
}

/** Sets a connection's synced account policy (ADR 0023), as the settings page would. */
export function setAccountPolicy(
  settings: LocalSettings,
  connection: CatalogConnection,
  enabled = true,
  selection: LocalSettings["accountPolicies"][number]["selection"] = { mode: "all" },
): LocalSettings {
  const account = accountOf(connection);
  settings.accountPolicies = [
    ...settings.accountPolicies.filter(
      (entry) =>
        entry.provider !== account.provider ||
        entry.server !== account.server ||
        entry.userId !== account.userId,
    ),
    { ...account, accountName: connection.label, enabled, selection },
  ];
  return settings;
}

/** The item policy of one item, created empty when the item has none. */
export function itemPolicy(
  settings: LocalSettings,
  connection: CatalogConnection,
  itemId: string,
): LocalSettings["itemPolicies"][number] {
  const account = accountOf(connection);
  const found = settings.itemPolicies.find(
    (entry) =>
      entry.itemId === itemId &&
      entry.provider === account.provider &&
      entry.server === account.server &&
      entry.userId === account.userId,
  );
  if (found) return found;
  const created = {
    ...account,
    itemId,
    itemName: itemId,
    selected: false,
    excluded: false,
    excludedFields: [] as ExcludedField[],
  };
  settings.itemPolicies.push(created);
  return created;
}

export function excludeItem(
  settings: LocalSettings,
  connection: CatalogConnection,
  itemId: string,
): LocalSettings {
  itemPolicy(settings, connection, itemId).excluded = true;
  return settings;
}

export function excludeField(
  settings: LocalSettings,
  connection: CatalogConnection,
  itemId: string,
  field: ExcludedField,
): LocalSettings {
  itemPolicy(settings, connection, itemId).excludedFields.push(field);
  return settings;
}
