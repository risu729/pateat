import {
  instantBefore,
  type AccountPolicy,
  type CustomFieldReview,
  type ExcludedField,
  type ItemPolicy,
  type LocalSettings,
  type VaultAccount,
  type VaultCatalog,
  type VaultItemMetadata,
} from "./schema";

const sameAccount = (left: VaultAccount, right: VaultAccount) =>
  left.provider === right.provider && left.server === right.server && left.userId === right.userId;

export type ConnectionAccount =
  | { ok: true; account: VaultAccount; policy: AccountPolicy | undefined }
  | { ok: false; reason: "connection-missing" | "vault-unavailable" | "account-ambiguous" };

type PolicyLists = Pick<LocalSettings, "accountPolicies" | "itemPolicies" | "customFieldReviews">;

/**
 * One provider account's synced policy (ADR 0023), or `account-ambiguous` when its user
 * ID has synced entries for another server, so that those entries are never silently
 * dropped.
 */
export function accountPolicy(
  settings: PolicyLists,
  account: VaultAccount,
): { ok: true; policy: AccountPolicy | undefined } | { ok: false; reason: "account-ambiguous" } {
  if (
    [...settings.accountPolicies, ...settings.itemPolicies, ...settings.customFieldReviews].some(
      (entry) =>
        entry.provider === account.provider &&
        entry.userId === account.userId &&
        entry.server !== account.server,
    )
  )
    return { ok: false, reason: "account-ambiguous" };
  return {
    ok: true,
    policy: settings.accountPolicies.find((entry) => sameAccount(entry, account)),
  };
}

/**
 * The provider account a local connection names, and its synced account policy. A
 * connection that cannot name its account (locked or unavailable) is `vault-unavailable`.
 * An account connected twice here shares one policy; naming it from a site default or
 * binding refuses (`siteDefaultConnection`).
 */
export function connectionAccount(
  settings: PolicyLists,
  catalog: VaultCatalog,
  connectionId: string,
): ConnectionAccount {
  const connection = catalog.connections.find((entry) => entry.id === connectionId);
  if (!connection) return { ok: false, reason: "connection-missing" };
  if (connection.userId === undefined) return { ok: false, reason: "vault-unavailable" };
  const account = {
    provider: connection.provider,
    server: connection.server,
    userId: connection.userId,
  };
  const resolved = accountPolicy(settings, account);
  return resolved.ok ? { ok: true, account, policy: resolved.policy } : resolved;
}

/**
 * Whether this device uses a local connection: `enabled` or `disabled` by its account's
 * synced policy (an account with no policy is not used, nor is a connection that is not
 * in the catalog), also while it is locked if its account is known, or why its account
 * cannot be told: `vault-unavailable` or `account-ambiguous`, which callers report rather
 * than skip. A connection whose account is not known yet follows its add form's choice
 * while that waits in `connections`: one added as unused is `disabled`.
 */
export function connectionUse(
  settings: PolicyLists & Partial<Pick<LocalSettings, "connections">>,
  catalog: VaultCatalog,
  connectionId: string,
): "enabled" | "disabled" | "vault-unavailable" | "account-ambiguous" {
  const connection = catalog.connections.find((entry) => entry.id === connectionId);
  if (!connection) return "disabled";
  const userId = connection.userId ?? connection.lockedUserId;
  if (userId === undefined)
    return settings.connections?.find((entry) => entry.connectionId === connectionId)?.enabled ===
      false
      ? "disabled"
      : "vault-unavailable";
  const resolved = accountPolicy(settings, {
    provider: connection.provider,
    server: connection.server,
    userId,
  });
  if (!resolved.ok) return resolved.reason;
  return resolved.policy?.enabled ? "enabled" : "disabled";
}

/** Whether this device uses a local connection: its account's synced policy is enabled. */
export function connectionEnabled(
  settings: PolicyLists,
  catalog: VaultCatalog,
  connectionId: string,
): boolean {
  return connectionUse(settings, catalog, connectionId) === "enabled";
}

export function itemPolicyFor(
  settings: Pick<LocalSettings, "itemPolicies">,
  account: VaultAccount,
  itemId: string,
): ItemPolicy | undefined {
  return settings.itemPolicies.find(
    (entry) => entry.itemId === itemId && sameAccount(entry, account),
  );
}

export function customFieldReviewFor(
  settings: Pick<LocalSettings, "customFieldReviews">,
  account: VaultAccount,
  itemId: string,
): CustomFieldReview | undefined {
  return settings.customFieldReviews.find(
    (entry) => entry.itemId === itemId && sameAccount(entry, account),
  );
}

type CatalogField = Pick<VaultItemMetadata["fields"][number], "id" | "name">;
const customFieldId = /^custom\.[^.]+\.(\d+)$/;

/** Whether a catalog field ID names a custom field, whose ID changes with every vault sync. */
export const isCustomFieldId = (fieldId: string) => customFieldId.test(fieldId);

/** An item's custom fields of one name (`null`: unnamed), ordered by their vault index. */
function customGroup(fields: readonly CatalogField[], name: string | null): string[] {
  return fields
    .flatMap((field) => {
      const index = customFieldId.exec(field.id)?.[1];
      return index !== undefined && field.name === name
        ? [{ id: field.id, index: Number(index) }]
        : [];
    })
    .sort((left, right) => left.index - right.index)
    .map((field) => field.id);
}

/**
 * The reference that names one field of a live item on every device (ADR 0023): a
 * built-in field's own ID, or a custom field's name with its position and count among the
 * item's custom fields of that name. Undefined for a field the item does not have.
 */
export function excludedFieldReference(
  fields: readonly CatalogField[],
  fieldId: string,
): ExcludedField | undefined {
  const field = fields.find((entry) => entry.id === fieldId);
  if (!field) return undefined;
  if (!isCustomFieldId(fieldId)) return fieldId;
  const group = customGroup(fields, field.name);
  return { custom: field.name, position: group.indexOf(fieldId) + 1, count: group.length };
}

/**
 * The live field IDs an item's exclusions name. `unresolved` when a custom reference no
 * longer names exactly one field: its name is gone, its count changed, or a name without a
 * position is now ambiguous. A built-in field the item lacks excludes nothing.
 */
export function resolveExcludedFields(
  references: readonly ExcludedField[],
  fields: readonly CatalogField[],
): { fieldIds: string[]; unresolved: boolean } {
  const fieldIds = new Set<string>();
  let unresolved = false;
  for (const reference of references) {
    if (typeof reference === "string") {
      if (fields.some((field) => field.id === reference)) fieldIds.add(reference);
      continue;
    }
    const group = customGroup(fields, reference.custom);
    const fieldId =
      reference.position === undefined
        ? group.length === 1
          ? group[0]
          : undefined
        : group.length === reference.count
          ? group[reference.position - 1]
          : undefined;
    if (fieldId === undefined) unresolved = true;
    else fieldIds.add(fieldId);
  }
  return { fieldIds: [...fieldIds], unresolved };
}

/**
 * Where one item stands on custom-field review (ADR 0023). An item with custom-field
 * exclusions or a review record is `reviewed`, and usable, only when its current evidence
 * matches the record and every exclusion resolves. Otherwise it is `vault-stale` when this
 * device's copy is strictly older than the record, and `review-required` when not. Other
 * items are `none`.
 */
export function customFieldReviewState(
  settings: Pick<LocalSettings, "itemPolicies" | "customFieldReviews">,
  account: VaultAccount,
  item: Pick<VaultItemMetadata, "id" | "fields" | "evidence" | "revisionDate">,
): "none" | "reviewed" | "review-required" | "vault-stale" {
  const references = itemPolicyFor(settings, account, item.id)?.excludedFields ?? [];
  const record = customFieldReviewFor(settings, account, item.id);
  if (!record && references.every((reference) => typeof reference === "string")) return "none";
  if (record && item.evidence !== undefined && record.evidence === item.evidence)
    return resolveExcludedFields(references, item.fields).unresolved
      ? "review-required"
      : "reviewed";
  if (
    record &&
    item.revisionDate !== undefined &&
    instantBefore(item.revisionDate, record.revisionDate)
  )
    return "vault-stale";
  return "review-required";
}

export type EligibilityReason =
  | "connection-missing"
  | "connection-disabled"
  | "vault-unavailable"
  | "account-ambiguous"
  | "item-missing"
  | "item-excluded"
  | "item-not-selected"
  | "review-required"
  | "fields-excluded";
export type ItemEligibility =
  | { eligible: true; item: VaultItemMetadata; fieldIds: string[] }
  | { eligible: false; reason: EligibilityReason };

/**
 * Whether the synced policy lets this device use one item of a local connection, and which
 * of its fields (ADR 0023). The policy is applied to the live catalog at each check, as
 * bindings are resolved. A paired device uses no item before its first settings sync.
 * `fields-excluded` is reported last.
 */
export function getItemEligibility(
  settings: LocalSettings,
  catalog: VaultCatalog,
  connectionId: string,
  itemId: string,
): ItemEligibility {
  if (catalog.settingsSyncPending) return { eligible: false, reason: "vault-unavailable" };
  const resolved = connectionAccount(settings, catalog, connectionId);
  if (!resolved.ok) return { eligible: false, reason: resolved.reason };
  const { account, policy } = resolved;
  if (!policy?.enabled) return { eligible: false, reason: "connection-disabled" };
  const item = catalog.connections
    .find((entry) => entry.id === connectionId)
    ?.items.find((entry) => entry.id === itemId);
  if (!item) return { eligible: false, reason: "item-missing" };
  const itemPolicy = itemPolicyFor(settings, account, itemId);
  if (itemPolicy?.excluded) return { eligible: false, reason: "item-excluded" };
  const { selection } = policy;
  if (
    selection.mode === "selected" &&
    !itemPolicy?.selected &&
    !item.groupIds.some((id) => selection.groups.some((group) => group.id === id))
  )
    return { eligible: false, reason: "item-not-selected" };
  const review = customFieldReviewState(settings, account, item);
  if (review === "review-required" || review === "vault-stale")
    return { eligible: false, reason: "review-required" };
  const excluded = new Set(
    resolveExcludedFields(itemPolicy?.excludedFields ?? [], item.fields).fieldIds,
  );
  const fieldIds = item.fields.filter((field) => !excluded.has(field.id)).map((field) => field.id);
  if (!fieldIds.length) return { eligible: false, reason: "fields-excluded" };
  return { eligible: true, item, fieldIds };
}

/**
 * Whether the item's synced exclusions name one of its live fields. An item whose
 * connection cannot name its account excludes nothing here; eligibility refuses it.
 */
export function isFieldExcluded(
  settings: LocalSettings,
  catalog: VaultCatalog,
  connectionId: string,
  itemId: string,
  fieldId: string,
): boolean {
  const resolved = connectionAccount(settings, catalog, connectionId);
  const item = catalog.connections
    .find((entry) => entry.id === connectionId)
    ?.items.find((entry) => entry.id === itemId);
  if (!resolved.ok || !item) return false;
  const references = itemPolicyFor(settings, resolved.account, itemId)?.excludedFields ?? [];
  return resolveExcludedFields(references, item.fields).fieldIds.includes(fieldId);
}

