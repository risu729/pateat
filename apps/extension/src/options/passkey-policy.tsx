import type { LocalSettings } from "@pateat/contracts";
import { Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { INITIAL_PASSKEY_POLICY, type PasskeyPolicy } from "../passkeys/policy";
import { checkClass, Panel, StatusLines } from "./ui";

export const PASSKEYS_SECTION = "passkeys";

/**
 * Whether Pateat's passkey answers tell the site that the person was present and verified
 * (ADR 0007). Both are on by default: Pateat answers without a click or a check, which does
 * not follow the WebAuthn ceremony. Turned off, requests that need either go to the browser.
 * Synced with the profile; stored only while it differs from the default.
 */
export function PasskeyPolicyPanel({
  draft,
  edit,
}: {
  draft: LocalSettings;
  edit: (update: (value: LocalSettings) => void) => boolean;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const policy = draft.passkeyPolicy ?? INITIAL_PASSKEY_POLICY;
  const change = (next: PasskeyPolicy) =>
    edit((settings) => {
      if (next.presence === "always" && next.verification === "always")
        delete settings.passkeyPolicy;
      else settings.passkeyPolicy = { presence: next.presence, verification: next.verification };
    });
  return (
    <Panel id={PASSKEYS_SECTION} headingId="passkeys-heading" title={t("Passkeys")}>
      <label className={checkClass}>
        <input
          id="passkey-presence"
          type="checkbox"
          checked={policy.presence === "always"}
          onChange={(event) =>
            change({ ...policy, presence: event.target.checked ? "always" : "activation" })
          }
        />
        {t("Answer passkey requests without a click on the page")}
      </label>
      <label className={checkClass}>
        <input
          id="passkey-verification"
          type="checkbox"
          checked={policy.verification === "always"}
          onChange={(event) =>
            change({ ...policy, verification: event.target.checked ? "always" : "never" })
          }
        />
        {t("Tell sites that you were verified")}
      </label>
      <StatusLines
        id="passkey-policy-note"
        muted
        lines={[
          {
            tone: "idle",
            icon: Info,
            text: t(
              "Pateat does no check of its own: an unlocked vault and the account chosen for the site are all it asks. Off: a request made without a click, or one that requires verification, goes to the browser or another extension, so Pateat cannot log in with a passkey by itself there. Applies on all your devices.",
            ),
          },
        ]}
      />
    </Panel>
  );
}
