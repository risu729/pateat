import type { SettingsConflictCause } from "@pateat/contracts";

const reasons: Record<SettingsConflictCause, string> = {
  "settings-save": "settings were saved in another window or the toolbar popup",
  "vault-added": "a Bitwarden vault was added",
  "vault-sync": "a Bitwarden vault was synced after a sign-in or Sync",
  "automatic-vault-sync": "a Bitwarden vault was synced automatically",
  "field-review": "custom fields were reviewed",
  "service-sync": "settings were merged with the Pateat sync service",
  "account-choice": "an account used to sign in on a site was saved for that site",
  unknown: "settings changed for a reason no longer recorded",
};

/**
 * The status line after a save met a revision conflict, naming what wrote the newer
 * revisions (ADR 0025).
 */
export function saveConflictMessage(causes: readonly SettingsConflictCause[] = []): string {
  const listed = [...new Set(causes.length ? causes : ["unknown" as const])].map(
    (cause) => reasons[cause],
  );
  const last = listed.pop();
  const why = listed.length ? `${listed.join(", ")} and ${last}` : last;
  return `Saved settings changed before this save: ${why}. Your unsaved draft has been preserved. Reload saved settings to review the latest version before saving. Reloading discards the draft.`;
}
