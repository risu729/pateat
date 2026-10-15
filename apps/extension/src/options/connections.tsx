import {
  connectionAccount,
  excludedFieldReference,
  isCustomFieldId,
  itemPolicyFor,
  resolveExcludedFields,
  type LocalSettings,
  type VaultAccount,
  type VaultCatalog,
  type VaultConnectionMetadata,
  type VaultItemMetadata,
} from "@pateat/contracts";
import { Vault } from "lucide-react";
import type { ReactNode } from "react";
import { Badge, checkClass, controlClass, fieldClass, Row, RowList, RowTitle } from "./ui";

function Checkbox({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={checkClass}>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label.slice(label.indexOf(": ") + 2)}</span>
    </label>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function countOf(entries: { id: string }[], ids: string[], noun: string): string {
  const selected = entries.filter((entry) => ids.includes(entry.id)).length;
  return `${selected} of ${plural(entries.length, noun)}`;
}

type AccountPolicy = LocalSettings["accountPolicies"][number];
type ItemPolicy = LocalSettings["itemPolicies"][number];

/** The draft's policy for one item, as the controls read it. */
function itemState(draft: LocalSettings, account: VaultAccount, item: VaultItemMetadata) {
  const policy = itemPolicyFor(draft, account, item.id);
  return {
    selected: policy?.selected ?? false,
    excluded: policy?.excluded ?? false,
    excludedFieldIds: resolveExcludedFields(policy?.excludedFields ?? [], item.fields).fieldIds,
  };
}

/** Excluded items, and excluded fields of the items that are not excluded themselves. */
function exclusions(
  draft: LocalSettings,
  account: VaultAccount,
  metadata: VaultConnectionMetadata,
) {
  let items = 0;
  let fields = 0;
  for (const item of metadata.items) {
    const state = itemState(draft, account, item);
    if (state.excluded) items += 1;
    else fields += state.excludedFieldIds.length;
  }
  return { items, fields };
}

/** Edits one account's policy, creating it (not used, all items) when it has none. */
function editAccount(
  settings: LocalSettings,
  account: VaultAccount,
  accountName: string,
  update: (policy: AccountPolicy) => void,
) {
  let policy = settings.accountPolicies.find(
    (entry) =>
      entry.provider === account.provider &&
      entry.server === account.server &&
      entry.userId === account.userId,
  );
  if (!policy) {
    policy = { ...account, accountName, enabled: false, selection: { mode: "all" } };
    settings.accountPolicies.push(policy);
  }
  update(policy);
}

/** Edits one item's policy; one that selects, excludes and names nothing is removed. */
function editItem(
  settings: LocalSettings,
  account: VaultAccount,
  item: VaultItemMetadata,
  update: (policy: ItemPolicy) => void,
) {
  let policy = itemPolicyFor(settings, account, item.id);
  if (!policy) {
    policy = {
      ...account,
      itemId: item.id,
      itemName: item.label.slice(0, 200),
      selected: false,
      excluded: false,
      excludedFields: [],
    };
    settings.itemPolicies.push(policy);
  }
  update(policy);
  settings.itemPolicies = settings.itemPolicies.filter(
    (entry) => entry.selected || entry.excluded || entry.excludedFields.length,
  );
}

/** Adds or removes the exclusion of one live field, named as every device names it. */
function setFieldExcluded(
  policy: ItemPolicy,
  item: VaultItemMetadata,
  fieldId: string,
  on: boolean,
) {
  policy.excludedFields = policy.excludedFields.filter(
    (ref) => resolveExcludedFields([ref], item.fields).fieldIds[0] !== fieldId,
  );
  const reference = on ? excludedFieldReference(item.fields, fieldId) : undefined;
  if (reference !== undefined) policy.excludedFields.push(reference);
}

const disclosureClass = "min-w-0 open:basis-full";
const summaryClass =
  "flex min-h-9 cursor-pointer items-center gap-2 text-sm font-semibold text-accent-ink";
const listClass = "mt-2 flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3";

/**
 * Which items of one vault Pateat may use: the vault itself, all items or only selected
 * groups and items, and the items and fields it never uses. Names and labels only. These
 * settings are synced per provider account (ADR 0023), so every device that connects the
 * account uses them.
 */
export function VaultAccess({
  draft,
  catalog,
  metadata,
  edit,
  disabled = false,
}: {
  draft: LocalSettings;
  catalog: VaultCatalog;
  metadata: VaultConnectionMetadata;
  edit: (update: (value: LocalSettings) => void) => void;
  /** While saved settings load or none are accepted, the controls wait. */
  disabled?: boolean;
}) {
  const label = metadata.label;
  const resolved = connectionAccount(draft, catalog, metadata.id);
  if (!resolved.ok)
    return resolved.reason === "account-ambiguous" ? (
      <p className="m-0 basis-full text-[0.8125rem] leading-5 text-ink-muted sm:pl-11">
        Saved settings name this account on another server, so Pateat does not use it here.
      </p>
    ) : null;
  const { account } = resolved;
  const enabled = resolved.policy?.enabled ?? false;
  const selection = resolved.policy?.selection ?? { mode: "all" as const };
  const selectedGroups =
    selection.mode === "selected" ? selection.groups.map((group) => group.id) : [];
  const selectedItems = metadata.items
    .filter((item) => itemState(draft, account, item).selected)
    .map((item) => item.id);
  const selectedCount =
    metadata.groups.filter((group) => selectedGroups.includes(group.id)).length +
    selectedItems.length;
  const excluded = exclusions(draft, account, metadata);
  const parts = [
    excluded.items && plural(excluded.items, "item"),
    excluded.fields && plural(excluded.fields, "field"),
  ].filter(Boolean);
  const changeAccount = (update: (policy: AccountPolicy) => void) =>
    edit((value) => editAccount(value, account, label.slice(0, 200), update));
  const changeItem = (item: VaultItemMetadata, update: (policy: ItemPolicy) => void) =>
    edit((value) => editItem(value, account, item, update));
  return (
    <fieldset
      aria-label={label}
      disabled={disabled}
      className="m-0 flex min-w-0 basis-full flex-wrap items-end gap-x-6 gap-y-3 border-0 border-t border-dashed border-border p-0 pt-3 sm:pl-11"
    >
      <label className="m-0 inline-flex min-h-10 cursor-pointer items-center gap-2 text-[0.95rem] font-normal">
        <input
          type="checkbox"
          role="switch"
          aria-checked={enabled}
          aria-label={`${label}: Use this vault`}
          className="relative m-0 h-5 w-9 flex-none cursor-pointer appearance-none rounded-full bg-border-strong transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-surface after:transition-[left] after:content-[''] checked:bg-accent checked:after:left-[1.125rem] disabled:cursor-default disabled:opacity-50"
          checked={enabled}
          onChange={(event) => {
            const checked = event.target.checked;
            changeAccount((policy) => {
              policy.enabled = checked;
            });
          }}
        />
        Use this vault
      </label>
      <label className={`${fieldClass} flex-[0_1_280px]`}>
        Items for Pateat
        <select
          aria-label={`${label}: Items for Pateat`}
          className={controlClass}
          value={selection.mode}
          onChange={(event) => {
            const mode = event.target.value === "selected" ? "selected" : "all";
            changeAccount((policy) => {
              policy.selection = mode === "all" ? { mode } : { mode, groups: [] };
            });
          }}
        >
          <option value="all">All except exclusions</option>
          <option value="selected">Selected groups and items only</option>
        </select>
      </label>
      {selection.mode === "selected" && (
        <details className={disclosureClass}>
          <summary className={summaryClass}>
            Included groups and items{" "}
            <Badge muted>
              {selectedCount}
              <span className="visually-hidden"> selected</span>
            </Badge>
          </summary>
          <fieldset className={listClass} aria-label={`${label}: Included groups and items`}>
            <p className="m-0 text-[0.8125rem] leading-5 text-ink-muted">
              {countOf(metadata.groups, selectedGroups, "group")},{" "}
              {countOf(metadata.items, selectedItems, "item")} selected
            </p>
            {metadata.groups.map((group) => (
              <Checkbox
                key={group.id}
                label={`${label}: Include group ${group.label}`}
                checked={selectedGroups.includes(group.id)}
                onChange={(checked) =>
                  changeAccount((policy) => {
                    if (policy.selection.mode !== "selected") return;
                    policy.selection.groups = policy.selection.groups.filter(
                      (entry) => entry.id !== group.id,
                    );
                    if (checked)
                      policy.selection.groups.push({
                        id: group.id,
                        name: group.label.slice(0, 200),
                      });
                  })
                }
              />
            ))}
            {metadata.items.map((item) => (
              <Checkbox
                key={item.id}
                label={`${label}: Include item ${item.label}`}
                checked={selectedItems.includes(item.id)}
                onChange={(checked) =>
                  changeItem(item, (policy) => {
                    policy.selected = checked;
                  })
                }
              />
            ))}
          </fieldset>
        </details>
      )}
      <details className={disclosureClass}>
        <summary className={summaryClass}>
          Excluded items and fields{" "}
          <Badge muted>
            {excluded.items + excluded.fields}
            <span className="visually-hidden"> excluded</span>
          </Badge>
        </summary>
        <div className={listClass}>
          <p className="m-0 text-[0.8125rem] leading-5 text-ink-muted">
            {parts.length ? `${parts.join(" and ")} excluded` : "Nothing excluded"}
          </p>
          {metadata.items.map((item) => {
            const state = itemState(draft, account, item);
            const itemExcluded = state.excluded;
            const excludedFields = state.excludedFieldIds.length;
            // Custom fields waiting for review change only through that review.
            const reviewing = metadata.quarantinedItemIds?.includes(item.id) ?? false;
            return (
              <details key={item.id} className="rounded-lg border border-border bg-surface px-3">
                <summary className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
                  <span className="font-semibold">{item.label}</span>{" "}
                  <span className="text-[0.8125rem] text-ink-muted">
                    {itemExcluded
                      ? "Item excluded"
                      : excludedFields
                        ? `${plural(excludedFields, "field")} excluded`
                        : "Nothing excluded"}
                  </span>
                </summary>
                <div className="flex flex-col gap-2 pb-3">
                  <Checkbox
                    label={`${label}: Exclude item ${item.label}`}
                    checked={itemExcluded}
                    onChange={(checked) =>
                      changeItem(item, (policy) => {
                        policy.excluded = checked;
                      })
                    }
                  />
                  {item.fields.map((field) => (
                    <Checkbox
                      key={field.id}
                      label={`${label}: Exclude ${field.label} from ${item.label}`}
                      checked={state.excludedFieldIds.includes(field.id)}
                      disabled={reviewing && isCustomFieldId(field.id)}
                      onChange={(checked) =>
                        changeItem(item, (policy) =>
                          setFieldExcluded(policy, item, field.id, checked),
                        )
                      }
                    />
                  ))}
                </div>
              </details>
            );
          })}
        </div>
      </details>
    </fieldset>
  );
}

/** Vaults that have no Bitwarden connection row on this page, such as the demo vaults. */
export function VaultRows({
  ids,
  draft,
  catalog,
  edit,
}: {
  ids: string[];
  draft: LocalSettings;
  catalog: VaultCatalog;
  edit: (update: (value: LocalSettings) => void) => void;
}) {
  const rows: ReactNode[] = [];
  for (const id of ids) {
    const metadata = catalog.connections.find((entry) => entry.id === id);
    if (!metadata) continue;
    rows.push(
      <Row key={id} icon={Vault} main={<RowTitle>{metadata.label}</RowTitle>}>
        <VaultAccess draft={draft} catalog={catalog} metadata={metadata} edit={edit} />
      </Row>,
    );
  }
  return <RowList id="connections">{rows}</RowList>;
}
