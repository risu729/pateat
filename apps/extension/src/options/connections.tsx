import type {
  ConnectionSettings,
  LocalSettings,
  VaultCatalog,
  VaultConnectionMetadata,
} from "@pateat/contracts";

export function toggleId(ids: string[], id: string, included: boolean): string[] {
  return included ? [...new Set([...ids, id])] : ids.filter((entry) => entry !== id);
}

function Checkbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="checkbox-row">
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
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

function exclusionSummary(connection: ConnectionSettings, metadata: VaultConnectionMetadata) {
  const excluded = metadata.items.filter((item) => connection.excludedItemIds.includes(item.id));
  // Fields of an excluded item are not counted, matching that item's own summary.
  const fields = connection.excludedFields.filter((ref) =>
    metadata.items.some(
      (item) =>
        item.id === ref.itemId &&
        !excluded.includes(item) &&
        item.fields.some((field) => field.id === ref.fieldId),
    ),
  );
  const parts = [
    excluded.length && plural(excluded.length, "item"),
    fields.length && plural(fields.length, "field"),
  ].filter(Boolean);
  return parts.length ? `${parts.join(" and ")} excluded` : "Nothing excluded";
}

export function Connections({
  draft,
  catalog,
  change,
}: {
  draft: LocalSettings;
  catalog: VaultCatalog;
  change: (id: string, edit: (connection: ConnectionSettings) => void) => void;
}) {
  return (
    <div id="connections" className="grid gap-5 lg:grid-cols-2">
      {draft.connections.map((connection) => {
        const metadata = catalog.connections.find((entry) => entry.id === connection.connectionId);
        if (!metadata)
          return (
            <p key={connection.connectionId}>
              Unavailable connection: {connection.connectionId}. Its saved settings are preserved.
            </p>
          );
        const edit = (update: (value: ConnectionSettings) => void) =>
          change(connection.connectionId, update);
        return (
          <fieldset key={connection.connectionId} className="connection">
            <legend>{metadata.label}</legend>
            <Checkbox
              label={`${metadata.label}: Enabled`}
              checked={connection.enabled}
              onChange={(checked) =>
                edit((value) => {
                  value.enabled = checked;
                })
              }
            />
            <label>
              Item access
              <select
                aria-label={`${metadata.label}: Item access`}
                value={connection.selection.mode}
                onChange={(event) =>
                  edit((value) => {
                    value.selection.mode = event.target.value === "selected" ? "selected" : "all";
                  })
                }
              >
                <option value="all">All items except exclusions</option>
                <option value="selected">Selected groups and items only</option>
              </select>
            </label>
            <details className="disclosure">
              <summary>
                Included groups and items{" "}
                <span className="summary-count">
                  {connection.selection.mode === "selected"
                    ? `${countOf(metadata.groups, connection.selection.groupIds, "group")}, ${countOf(metadata.items, connection.selection.itemIds, "item")} selected`
                    : "Not used: all items except exclusions"}
                </span>
              </summary>
              <fieldset
                className="selection"
                aria-label="Included groups and items"
                disabled={connection.selection.mode !== "selected"}
              >
                {metadata.groups.map((group) => (
                  <Checkbox
                    key={group.id}
                    label={`${metadata.label}: Include group ${group.label}`}
                    checked={connection.selection.groupIds.includes(group.id)}
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
                    label={`${metadata.label}: Include item ${item.label}`}
                    checked={connection.selection.itemIds.includes(item.id)}
                    onChange={(checked) =>
                      edit((value) => {
                        value.selection.itemIds = toggleId(
                          value.selection.itemIds,
                          item.id,
                          checked,
                        );
                      })
                    }
                  />
                ))}
              </fieldset>
            </details>
            <details className="disclosure">
              <summary>
                Item and field exclusions{" "}
                <span className="summary-count">{exclusionSummary(connection, metadata)}</span>
              </summary>
              {metadata.items.map((item) => {
                const excludedFields = item.fields.filter((field) =>
                  connection.excludedFields.some(
                    (ref) => ref.itemId === item.id && ref.fieldId === field.id,
                  ),
                ).length;
                return (
                  <details key={item.id} className="item-exclusions">
                    <summary>
                      {item.label}{" "}
                      <span className="summary-count">
                        {connection.excludedItemIds.includes(item.id)
                          ? "Item excluded"
                          : excludedFields
                            ? `${plural(excludedFields, "field")} excluded`
                            : "Nothing excluded"}
                      </span>
                    </summary>
                    <Checkbox
                      label={`${metadata.label}: Exclude item ${item.label}`}
                      checked={connection.excludedItemIds.includes(item.id)}
                      onChange={(checked) =>
                        edit((value) => {
                          value.excludedItemIds = toggleId(value.excludedItemIds, item.id, checked);
                        })
                      }
                    />
                    {item.fields.map((field) => (
                      <Checkbox
                        key={field.id}
                        label={`${metadata.label}: Exclude ${field.label} from ${item.label}`}
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
                  </details>
                );
              })}
            </details>
          </fieldset>
        );
      })}
    </div>
  );
}
