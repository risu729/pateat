import type { ConnectionSettings, LocalSettings, VaultCatalog } from "@pateat/contracts";

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
            <fieldset className="selection" disabled={connection.selection.mode !== "selected"}>
              <legend>Included groups and items</legend>
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
                      value.selection.itemIds = toggleId(value.selection.itemIds, item.id, checked);
                    })
                  }
                />
              ))}
            </fieldset>
            <h3>Item and field exclusions</h3>
            {metadata.items.map((item) => (
              <fieldset key={item.id} className="item-exclusions">
                <legend>{item.label}</legend>
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
              </fieldset>
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}
