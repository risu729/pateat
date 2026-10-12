import type { SavedLoginBinding } from "@pateat/contracts";
import { describeError, type ManageClient } from "./api";
import { Button } from "./button";
import { useSettings, useSettingsEdit, vaultAccountLabel } from "./settings";

type FieldReference = SavedLoginBinding["slots"][number]["field"];

function describeField(field: FieldReference): string {
  if (field === "username") return "Username";
  if (field === "password") return "Password";
  if (field === "totp") return "TOTP";
  const position = field.position ? ` (${field.position} of ${field.count})` : "";
  return `Custom field "${field.custom}"${position}`;
}

const bindingKey = (binding: SavedLoginBinding) =>
  JSON.stringify([
    binding.recipeId,
    binding.origin,
    binding.provider,
    binding.userId,
    binding.itemId,
  ]);

export function BindingsPage({ client }: { client: ManageClient }) {
  const settings = useSettings(client);
  const edit = useSettingsEdit(client);

  if (settings.isPending)
    return (
      <output id="settings-status" className="block">
        Loading settings…
      </output>
    );
  if (settings.isError)
    return (
      <p role="alert" id="settings-status" className="text-danger">
        {describeError(settings.error)}
      </p>
    );
  const bindings = settings.data.settings?.bindings ?? [];

  return (
    <section aria-labelledby="bindings-heading" className="space-y-4">
      <h2 id="bindings-heading" className="text-xl font-semibold">
        Account bindings
      </h2>
      <p className="text-ink-muted">
        Which vault field fills each part of a recipe for one item. Removing a binding makes that
        item use only its username, password and TOTP; a recipe that needs other fields then stops
        until a new binding is made.
      </p>
      <output id="settings-saved" className="block text-ink-muted">
        {edit.isSuccess && edit.variables.done}
      </output>
      {edit.isError && (
        <p role="alert" id="settings-error" className="text-danger">
          {describeError(edit.error)}
        </p>
      )}
      {bindings.length === 0 ? (
        <p>No account bindings are saved.</p>
      ) : (
        <table id="bindings" className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-border-strong">
              <th scope="col" className="py-2 pr-4">
                Recipe
              </th>
              <th scope="col" className="py-2 pr-4">
                Item
              </th>
              <th scope="col" className="py-2 pr-4">
                Fields
              </th>
              <th scope="col" className="py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {bindings.map((binding) => (
              <tr key={bindingKey(binding)} className="border-b border-border align-top">
                <td className="py-2 pr-4">
                  {binding.recipeId}
                  <br />
                  <span className="text-ink-muted">{binding.origin}</span>
                </td>
                <td className="py-2 pr-4">
                  {binding.itemName}
                  <br />
                  <span className="text-ink-muted">{vaultAccountLabel(binding)}</span>
                </td>
                <td className="py-2 pr-4">
                  <ul>
                    {binding.slots.map((entry) => (
                      <li key={entry.slot}>
                        {entry.slot}: {describeField(entry.field)}
                      </li>
                    ))}
                  </ul>
                </td>
                <td className="py-2">
                  <Button
                    variant="outline"
                    aria-label={`Remove binding of ${binding.itemName} for ${binding.recipeId} on ${binding.origin}`}
                    disabled={edit.isPending}
                    onClick={() =>
                      edit.mutate({
                        apply: (value) => ({
                          ...value,
                          bindings: value.bindings.filter(
                            (saved) => bindingKey(saved) !== bindingKey(binding),
                          ),
                        }),
                        done: `Removed the binding of ${binding.itemName} for ${binding.recipeId}.`,
                      })
                    }
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
