import type {
  ConnectionSettings,
  LocalSettings,
  VaultCatalog,
  VaultConnectionMetadata,
} from "@pateat/contracts";
import { CircleAlert, Vault } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { Badge, checkClass, controlClass, fieldClass, Row, RowList, RowSub, RowTitle } from "./ui";

export function toggleId(ids: string[], id: string, included: boolean): string[] {
  return included ? [...new Set([...ids, id])] : ids.filter((entry) => entry !== id);
}

function Checkbox({
  label,
  text,
  checked,
  onChange,
}: {
  label: string;
  text: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={checkClass}>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{text}</span>
    </label>
  );
}

/** Excluded items, and excluded fields of the items that are not excluded themselves. */
function exclusions(connection: ConnectionSettings, metadata: VaultConnectionMetadata) {
  const items = metadata.items.filter((item) => connection.excludedItemIds.includes(item.id));
  const fields = connection.excludedFields.filter((ref) =>
    metadata.items.some(
      (item) =>
        item.id === ref.itemId &&
        !items.includes(item) &&
        item.fields.some((field) => field.id === ref.fieldId),
    ),
  );
  return { items: items.length, fields: fields.length };
}

const disclosureClass = "min-w-0 open:basis-full";
const summaryClass =
  "flex min-h-9 cursor-pointer items-center gap-2 text-sm font-semibold text-accent-ink";
const listClass = "mt-2 flex flex-col gap-2 rounded-lg border border-border bg-surface-sunken p-3";

/**
 * Which items of one vault Pateat may use: the vault itself, all items or only selected
 * groups and items, and the items and fields it never uses. Names and labels only.
 */
export function VaultAccess({
  connection,
  metadata,
  edit,
  disabled = false,
}: {
  connection: ConnectionSettings;
  metadata: VaultConnectionMetadata;
  edit: (update: (value: ConnectionSettings) => void) => void;
  /** While saved settings load or none are accepted, the controls wait. */
  disabled?: boolean;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const label = metadata.label;
  const selected = connection.selection;
  const selectedCount =
    metadata.groups.filter((group) => selected.groupIds.includes(group.id)).length +
    metadata.items.filter((item) => selected.itemIds.includes(item.id)).length;
  const excluded = exclusions(connection, metadata);
  const parts = [
    excluded.items && t("{{count}} item", { count: excluded.items }),
    excluded.fields && t("{{count}} field", { count: excluded.fields }),
  ].filter(Boolean);
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
          aria-checked={connection.enabled}
          aria-label={t("{{vault}}: Use this vault", { vault: label })}
          className="relative m-0 h-5 w-9 flex-none cursor-pointer appearance-none rounded-full bg-border-strong transition-colors after:absolute after:top-0.5 after:left-0.5 after:size-4 after:rounded-full after:bg-surface after:transition-[left] after:content-[''] checked:bg-accent checked:after:left-[1.125rem] disabled:cursor-default disabled:opacity-50"
          checked={connection.enabled}
          onChange={(event) => {
            const checked = event.target.checked;
            edit((value) => {
              value.enabled = checked;
            });
          }}
        />
        {t("Use this vault")}
      </label>
      <label className={`${fieldClass} flex-[0_1_280px]`}>
        {t("Items for Pateat")}
        <select
          aria-label={t("{{vault}}: Items for Pateat", { vault: label })}
          className={controlClass}
          value={selected.mode}
          onChange={(event) => {
            const mode = event.target.value === "selected" ? "selected" : "all";
            edit((value) => {
              value.selection.mode = mode;
            });
          }}
        >
          <option value="all">{t("All except exclusions")}</option>
          <option value="selected">{t("Selected groups and items only")}</option>
        </select>
      </label>
      {selected.mode === "selected" && (
        <details className={disclosureClass}>
          <summary className={summaryClass}>
            {t("Included groups and items")}{" "}
            <Badge muted>
              {selectedCount}
              <span className="visually-hidden">{t(" selected")}</span>
            </Badge>
          </summary>
          <fieldset
            className={listClass}
            aria-label={t("{{vault}}: Included groups and items", { vault: label })}
          >
            <p className="m-0 text-[0.8125rem] leading-5 text-ink-muted">
              {t("{{groups}}, {{items}} selected", {
                groups: t("{{selected}} of {{count}} group", {
                  count: metadata.groups.length,
                  selected: metadata.groups.filter((group) => selected.groupIds.includes(group.id))
                    .length,
                }),
                items: t("{{selected}} of {{count}} item", {
                  count: metadata.items.length,
                  selected: metadata.items.filter((item) => selected.itemIds.includes(item.id))
                    .length,
                }),
              })}
            </p>
            {metadata.groups.map((group) => (
              <Checkbox
                key={group.id}
                label={t("{{vault}}: Include group {{group}}", {
                  vault: label,
                  group: group.label,
                })}
                text={t("Include group {{group}}", { group: group.label })}
                checked={selected.groupIds.includes(group.id)}
                onChange={(checked) =>
                  edit((value) => {
                    value.selection.groupIds = toggleId(
                      value.selection.groupIds,
                      group.id,
                      checked,
                    );
                  })
                }
              />
            ))}
            {metadata.items.map((item) => (
              <Checkbox
                key={item.id}
                label={t("{{vault}}: Include item {{item}}", { vault: label, item: item.label })}
                text={t("Include item {{item}}", { item: item.label })}
                checked={selected.itemIds.includes(item.id)}
                onChange={(checked) =>
                  edit((value) => {
                    value.selection.itemIds = toggleId(value.selection.itemIds, item.id, checked);
                  })
                }
              />
            ))}
          </fieldset>
        </details>
      )}
      <details className={disclosureClass}>
        <summary className={summaryClass}>
          {t("Excluded items and fields")}{" "}
          <Badge muted>
            {excluded.items + excluded.fields}
            <span className="visually-hidden">{t(" excluded")}</span>
          </Badge>
        </summary>
        <div className={listClass}>
          <p className="m-0 text-[0.8125rem] leading-5 text-ink-muted">
            {parts.length
              ? t("{{entries}} excluded", { entries: parts.join(t(" and ")) })
              : t("Nothing excluded")}
          </p>
          {metadata.items.map((item) => {
            const itemExcluded = connection.excludedItemIds.includes(item.id);
            const excludedFields = item.fields.filter((field) =>
              connection.excludedFields.some(
                (ref) => ref.itemId === item.id && ref.fieldId === field.id,
              ),
            ).length;
            return (
              <details key={item.id} className="rounded-lg border border-border bg-surface px-3">
                <summary className="flex min-h-9 cursor-pointer items-center gap-2 text-sm">
                  <span className="font-semibold">{item.label}</span>{" "}
                  <span className="text-[0.8125rem] text-ink-muted">
                    {itemExcluded
                      ? t("Item excluded")
                      : excludedFields
                        ? t("{{count}} field excluded", { count: excludedFields })
                        : t("Nothing excluded")}
                  </span>
                </summary>
                <div className="flex flex-col gap-2 pb-3">
                  <Checkbox
                    label={t("{{vault}}: Exclude item {{item}}", {
                      vault: label,
                      item: item.label,
                    })}
                    text={t("Exclude item {{item}}", { item: item.label })}
                    checked={itemExcluded}
                    onChange={(checked) =>
                      edit((value) => {
                        value.excludedItemIds = toggleId(value.excludedItemIds, item.id, checked);
                      })
                    }
                  />
                  {item.fields.map((field) => (
                    <Checkbox
                      key={field.id}
                      label={t("{{vault}}: Exclude {{field}} from {{item}}", {
                        vault: label,
                        field: field.label,
                        item: item.label,
                      })}
                      text={t("Exclude {{field}} from {{item}}", {
                        field: field.label,
                        item: item.label,
                      })}
                      checked={connection.excludedFields.some(
                        (ref) => ref.itemId === item.id && ref.fieldId === field.id,
                      )}
                      onChange={(checked) =>
                        edit((value) => {
                          value.excludedFields = value.excludedFields.filter(
                            (ref) => ref.itemId !== item.id || ref.fieldId !== field.id,
                          );
                          if (checked)
                            value.excludedFields.push({ itemId: item.id, fieldId: field.id });
                        })
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

/**
 * Vaults that have no Bitwarden connection row on this page, such as the demo vaults, and
 * saved entries for connections this device no longer has.
 */
export function VaultRows({
  ids,
  draft,
  catalog,
  change,
}: {
  ids: string[];
  draft: LocalSettings;
  catalog: VaultCatalog;
  change: (id: string, edit: (connection: ConnectionSettings) => void) => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const rows: ReactNode[] = [];
  for (const id of ids) {
    const connection = draft.connections.find((entry) => entry.connectionId === id);
    if (!connection) continue;
    const metadata = catalog.connections.find((entry) => entry.id === id);
    rows.push(
      metadata ? (
        <Row key={id} icon={Vault} main={<RowTitle>{metadata.label}</RowTitle>}>
          <VaultAccess
            connection={connection}
            metadata={metadata}
            edit={(update) => change(id, update)}
          />
        </Row>
      ) : (
        <Row
          key={id}
          icon={CircleAlert}
          main={
            <>
              <RowTitle>{t("Unavailable connection")}</RowTitle>
              <RowSub>{t("{{id}}. Its saved settings are kept.", { id })}</RowSub>
            </>
          }
        />
      ),
    );
  }
  return <RowList id="connections">{rows}</RowList>;
}
