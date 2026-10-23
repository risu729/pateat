import type { SettingsConflictCause } from "@pateat/contracts";
import { formatLocale } from "../i18n";
import type { LocalizedMessage } from "./ui";

const reasons = {
  "settings-save": "settings were saved in another window or the toolbar popup",
  "vault-added": "a Bitwarden vault was added",
  "vault-sync": "a Bitwarden vault was synced after a sign-in or Sync",
  "automatic-vault-sync": "a Bitwarden vault was synced automatically",
  "field-review": "custom fields were reviewed",
  "service-sync": "settings were merged with the Pateat sync service",
  "account-choice": "an account used to log in on a site was saved for that site",
  "detail-link": "a vault field for a personal detail was linked or unlinked for a site",
  "passkey-browser-site": "a site was set to hand its passkey requests to the browser",
  unknown: "settings changed for a reason no longer recorded",
} as const satisfies Record<SettingsConflictCause, string>;

/**
 * The status line after a save met a revision conflict, naming what wrote the newer
 * revisions (ADR 0025).
 */
export function saveConflictMessage(
  causes: readonly SettingsConflictCause[] = [],
): LocalizedMessage {
  const distinct = [...new Set(causes.length ? causes : ["unknown" as const])];
  return (translate) =>
    translate(
      "The saved settings changed before this save: {{reasons}}. Your unsaved changes are kept. Reload saved settings to see the latest ones before you change anything else; reloading drops them.",
      {
        reasons: new Intl.ListFormat(formatLocale(), {
          style: "long",
          type: "conjunction",
        }).format(distinct.map((cause) => translate(reasons[cause]))),
      },
    );
}

/**
 * Whether only background work wrote the revisions a save did not expect, so the draft's
 * edits can be applied once to the newer revision (ADR 0025). A save from another page, or
 * a revision with no recorded cause, may hold edits the owner has not seen.
 */
export function backgroundOnlyConflict(causes: readonly SettingsConflictCause[] = []): boolean {
  return (
    causes.length > 0 && causes.every((cause) => cause !== "settings-save" && cause !== "unknown")
  );
}
