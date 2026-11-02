import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { PASSKEY_POLICY_KEY, parsePasskeyPolicy, type PasskeyPolicy } from "../passkeys/policy";
import { trustedRecord } from "../storage";
import { checkClass, Panel, StatusLines } from "./ui";

/** Reads and writes this device's passkey presence and verification setting; never synced. */
export interface PasskeyPolicyClient {
  read(): Promise<PasskeyPolicy>;
  write(value: PasskeyPolicy): Promise<void>;
}

/** The settings page's own `storage.local` record; the service worker reads it per request. */
export function createPasskeyPolicyClient(): PasskeyPolicyClient {
  const record = trustedRecord<PasskeyPolicy>(PASSKEY_POLICY_KEY);
  return {
    read: async () => parsePasskeyPolicy(await record.read()),
    write: (value) => record.write(value),
  };
}

export const PASSKEYS_SECTION = "passkeys";
const QUERY_KEY = ["settings", "passkey-policy"] as const;

/**
 * Whether Pateat's passkey answers tell the site that the person was present and verified
 * (ADR 0007). Both are on by default: Pateat answers without a click or a check, which does
 * not follow the WebAuthn ceremony. Turned off, requests that need either go to the browser.
 */
export function PasskeyPolicyPanel({ client }: { client: PasskeyPolicyClient }) {
  const { t } = useTranslation(undefined, { i18n });
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  const setting = useQuery({ queryKey: QUERY_KEY, queryFn: () => client.read(), retry: false });
  const save = useMutation({
    mutationFn: (value: PasskeyPolicy) => client.write(value),
    onMutate: () => setMessage(t("Saving…")),
    onSuccess: (_result, value) => {
      queryClient.setQueryData(QUERY_KEY, value);
      setMessage(t("Saved on this device."));
    },
    onError: () => setMessage(t("The passkey setting could not be saved. Try again.")),
  });
  const value = setting.data;
  const disabled = !value || save.isPending;
  return (
    <Panel id={PASSKEYS_SECTION} headingId="passkeys-heading" title={t("Passkeys")}>
      <label className={checkClass}>
        <input
          id="passkey-presence"
          type="checkbox"
          checked={value?.presence === "always"}
          disabled={disabled}
          onChange={(event) => {
            if (value)
              save.mutate({ ...value, presence: event.target.checked ? "always" : "activation" });
          }}
        />
        {t("Answer passkey requests without a click on the page")}
      </label>
      <label className={checkClass}>
        <input
          id="passkey-verification"
          type="checkbox"
          checked={value?.verification === "always"}
          disabled={disabled}
          onChange={(event) => {
            if (value)
              save.mutate({ ...value, verification: event.target.checked ? "always" : "never" });
          }}
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
              "Pateat does no check of its own: an unlocked vault and the account chosen for the site are all it asks. Off: a request made without a click, or one that requires verification, goes to the browser or another extension, so Pateat cannot log in with a passkey by itself there. Applies on this device only.",
            ),
          },
        ]}
      />
      <output id="passkey-policy-status" className="text-sm leading-5" aria-live="polite">
        {setting.isError ? t("Unavailable") : message}
      </output>
    </Panel>
  );
}
