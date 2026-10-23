import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Lock, RotateCcw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { trustedRecord } from "../storage";
import {
  MAX_CUSTOM_MINUTES,
  parseVaultTimeout,
  VAULT_TIMEOUT_KEY,
  VAULT_TIMEOUT_MINUTES,
  type VaultTimeoutSetting,
} from "../vault/timeout";
import { controlClass, fieldClass, Panel, StatusLines } from "./ui";

/** Reads and writes this device's vault timeout (ADR 0075); it is never synced. */
export interface VaultTimeoutClient {
  read(): Promise<VaultTimeoutSetting>;
  write(value: VaultTimeoutSetting): Promise<void>;
}

/** The settings page's own `storage.local` record; the service worker follows its changes. */
export function createVaultTimeoutClient(): VaultTimeoutClient {
  const record = trustedRecord<VaultTimeoutSetting>(VAULT_TIMEOUT_KEY);
  return {
    read: async () => parseVaultTimeout(await record.read()),
    write: (value) => record.write(value),
  };
}

const QUERY_KEY = ["settings", "vault-timeout"] as const;
type Choice = Exclude<VaultTimeoutSetting["timeout"], number> | `${number}` | "custom";

function choiceOf(timeout: VaultTimeoutSetting["timeout"]): Choice {
  if (typeof timeout !== "number") return timeout;
  return (VAULT_TIMEOUT_MINUTES as readonly number[]).includes(timeout) ? `${timeout}` : "custom";
}

/** The vault timeout and its action, as the official Bitwarden extension offers them. */
export function VaultTimeoutPanel({ client }: { client: VaultTimeoutClient }) {
  const { t } = useTranslation(undefined, { i18n });
  const queryClient = useQueryClient();
  const [message, setMessage] = useState("");
  // The custom minutes as typed; saved once they are a whole number in range.
  const [custom, setCustom] = useState<string>();
  const setting = useQuery({ queryKey: QUERY_KEY, queryFn: () => client.read(), retry: false });
  const save = useMutation({
    mutationFn: (value: VaultTimeoutSetting) => client.write(value),
    onMutate: () => setMessage(t("Saving…")),
    onSuccess: (_result, value) => {
      queryClient.setQueryData(QUERY_KEY, value);
      setMessage(t("Saved on this device."));
    },
    onError: () => setMessage(t("The vault timeout could not be saved. Try again.")),
  });
  const value = setting.data;
  const choice = custom !== undefined ? "custom" : value ? choiceOf(value.timeout) : undefined;
  const disabled = !value || save.isPending;
  const minuteLabel = (minutes: number) =>
    minutes < 60
      ? t("{{count}} minute", { count: minutes })
      : t("{{count}} hour", { count: minutes / 60 });
  function saveCustom(text: string) {
    const minutes = Number(text);
    if (!value || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CUSTOM_MINUTES) {
      setMessage(
        t("Enter whole minutes from 1 to {{max}}.", { max: MAX_CUSTOM_MINUTES.toLocaleString() }),
      );
      return;
    }
    if (minutes !== value.timeout) save.mutate({ ...value, timeout: minutes });
  }
  return (
    <Panel id="vault-timeout" headingId="vault-timeout-heading" title={t("Vault timeout")}>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <label className={fieldClass}>
          {t("Vault timeout")}
          <select
            id="vault-timeout-select"
            className={controlClass}
            disabled={disabled}
            value={choice ?? ""}
            aria-describedby="vault-timeout-note"
            onChange={(event) => {
              if (!value) return;
              const next = event.target.value as Choice;
              if (next === "custom") {
                // The prefilled minutes count at once; editing them saves again.
                const minutes = typeof value.timeout === "number" ? value.timeout : 60;
                setCustom(String(minutes));
                if (minutes !== value.timeout) save.mutate({ ...value, timeout: minutes });
                return;
              }
              setCustom(undefined);
              const minutes = Number(next);
              save.mutate({
                ...value,
                timeout: Number.isInteger(minutes)
                  ? minutes
                  : (next as Exclude<Choice, `${number}` | "custom">),
              });
            }}
          >
            {!value && (
              <option value="">{setting.isError ? t("Unavailable") : t("Loading…")}</option>
            )}
            {VAULT_TIMEOUT_MINUTES.map((minutes) => (
              <option key={minutes} value={String(minutes)}>
                {minuteLabel(minutes)}
              </option>
            ))}
            <option value="system-idle">{t("On system idle")}</option>
            <option value="system-lock">{t("On system lock")}</option>
            <option value="restart">{t("On browser restart")}</option>
            <option value="never">{t("Never")}</option>
            <option value="custom">{t("Custom")}</option>
          </select>
        </label>
        {choice === "custom" && (
          <label className={fieldClass}>
            {t("Minutes")}
            <input
              id="vault-timeout-minutes"
              className={controlClass}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_CUSTOM_MINUTES}
              step={1}
              disabled={disabled}
              value={custom ?? (typeof value?.timeout === "number" ? String(value.timeout) : "")}
              onChange={(event) => setCustom(event.target.value)}
              onBlur={(event) => saveCustom(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveCustom(event.currentTarget.value);
              }}
            />
          </label>
        )}
        <label className={fieldClass}>
          {t("Timeout action")}
          <select
            id="vault-timeout-action"
            className={controlClass}
            disabled={disabled}
            value={value?.action ?? ""}
            onChange={(event) => {
              if (value)
                save.mutate({
                  ...value,
                  action: event.target.value === "log-out" ? "log-out" : "lock",
                });
            }}
          >
            {!value && (
              <option value="">{setting.isError ? t("Unavailable") : t("Loading…")}</option>
            )}
            <option value="lock">{t("Lock")}</option>
            <option value="log-out">{t("Log out")}</option>
          </select>
        </label>
      </div>
      <output id="vault-timeout-message" className="text-sm" aria-live="polite">
        {message}
      </output>
      <StatusLines
        id="vault-timeout-note"
        muted
        lines={[
          ...(value?.timeout === "never"
            ? [
                {
                  tone: "warn" as const,
                  icon: TriangleAlert,
                  text: t(
                    "Never keeps the unlock key on this device, so the vaults unlock by themselves after a browser restart and stay open to anyone who can use this browser profile.",
                  ),
                },
              ]
            : [
                {
                  tone: "idle" as const,
                  icon: RotateCcw,
                  text: t(
                    "The unlock key stays in memory only, so a browser restart also locks the vaults.",
                  ),
                },
              ]),
          {
            tone: "idle",
            icon: Lock,
            text:
              value?.action === "log-out"
                ? t("Log out also forgets the sync sign-in; sign in again to use the vault.")
                : t(
                    "Lock keeps the sync sign-in; unlock with the master password, without the server.",
                  ),
          },
          {
            tone: "idle",
            icon: Info,
            text: t(
              "Time counts from the last login filled, passkey signed, unlock or sign-in; this setting stays on this device.",
            ),
          },
        ]}
      />
    </Panel>
  );
}
