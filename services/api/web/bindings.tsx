import type { SavedLoginBinding } from "@pateat/contracts";
import { Button } from "./button";
import { vaultAccountLabel, type SettingsEdit } from "./settings";
import { Panel, ROW_CLASSES, RowList, RowMain } from "./ui";

type FieldReference = SavedLoginBinding["slots"][number]["field"];

function describeField(field: FieldReference): string {
  if (field === "username") return "the username";
  if (field === "password") return "the password";
  if (field === "totp") return "the TOTP";
  const position = field.position ? ` (${field.position} of ${field.count})` : "";
  return `custom field "${field.custom}"${position}`;
}

const bindingKey = (binding: SavedLoginBinding) =>
  JSON.stringify([
    binding.recipeId,
    binding.origin,
    binding.provider,
    binding.userId,
    binding.itemId,
  ]);

/**
 * Which vault field fills each part of a recipe for one item, on one site. Removing a
 * binding makes that item use only its username, password and TOTP.
 */
export function SiteBindings({
  bindings,
  busy,
  edit,
}: {
  bindings: SavedLoginBinding[];
  busy: boolean;
  edit: (change: SettingsEdit) => void;
}) {
  return (
    <Panel id="bindings-heading" title="Account bindings">
      {bindings.length === 0 ? (
        <p>No account bindings</p>
      ) : (
        <RowList id="bindings">
          {bindings.map((binding) => (
            <li key={bindingKey(binding)} className={ROW_CLASSES}>
              <RowMain
                title={binding.itemName}
                sub={
                  <>
                    {vaultAccountLabel(binding)}, recipe{" "}
                    <span className="font-mono">{binding.recipeId}</span>
                    <ul>
                      {binding.slots.map((entry) => (
                        <li key={entry.slot}>
                          {entry.slot} from {describeField(entry.field)}
                        </li>
                      ))}
                    </ul>
                  </>
                }
              />
              <Button
                variant="danger"
                aria-label={`Remove binding of ${binding.itemName} for ${binding.recipeId} on ${binding.origin}`}
                disabled={busy}
                onClick={() =>
                  edit({
                    apply: (value) => ({
                      ...value,
                      bindings: value.bindings.filter(
                        (saved) => bindingKey(saved) !== bindingKey(binding),
                      ),
                    }),
                    done: `Binding of ${binding.itemName} for ${binding.recipeId} removed`,
                  })
                }
              >
                Remove
              </Button>
            </li>
          ))}
        </RowList>
      )}
    </Panel>
  );
}
