import type { LocalSettings } from "@pateat/contracts";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { Info, Lock, RotateCcw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  MAX_CUSTOM_MINUTES,
  parseVaultTimeout,
  VAULT_TIMEOUT_MINUTES,
  type VaultTimeoutSetting,
} from "../vault/timeout";
import { controlClass, fieldClass, Panel, StatusLines } from "./ui";

type Choice = Exclude<VaultTimeoutSetting["timeout"], number> | `${number}` | "custom";

function choiceOf(timeout: VaultTimeoutSetting["timeout"]): Choice {
  if (typeof timeout !== "number") return timeout;
  return (VAULT_TIMEOUT_MINUTES as readonly number[]).includes(timeout) ? `${timeout}` : "custom";
}

/**
 * The vault timeout and its action (ADR 0075), as the official Bitwarden extension offers
 * them: the profile setting `vaultTimeout`, synced like the others (ADR 0024).
 */
export function VaultTimeoutPanel({
  draft,
  edit,
}: {
  draft: LocalSettings;
  edit: (update: (value: LocalSettings) => void) => boolean;
}) {
  const { t } = useTranslation(undefined, { i18n });
  const [message, setMessage] = useState("");
  // The custom minutes as typed; saved once they are a whole number in range.
  const [custom, setCustom] = useState<string>();
  const value = parseVaultTimeout(draft.vaultTimeout);
  const choice = custom !== undefined ? "custom" : choiceOf(value.timeout);
  /** Stored only when it differs from the default, as in the synced document. */
  function save(next: VaultTimeoutSetting) {
    setMessage("");
    edit((settings) => {
      if (next.timeout === "never" && next.action === "lock") delete settings.vaultTimeout;
      else settings.vaultTimeout = next;
    });
  }
  const minuteLabel = (minutes: number) =>
    minutes < 60
      ? t("{{count}} minute", { count: minutes })
      : t("{{count}} hour", { count: minutes / 60 });
  function saveCustom(text: string) {
    const minutes = Number(text);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_CUSTOM_MINUTES) {
      setMessage(
        t("Enter whole minutes from 1 to {{max}}.", { max: MAX_CUSTOM_MINUTES.toLocaleString() }),
      );
      return;
    }
    if (minutes !== value.timeout) save({ ...value, timeout: minutes });
  }
  return (
    <Panel id="vault-timeout" headingId="vault-timeout-heading" title={t("Vault timeout")}>
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
        <label className={fieldClass}>
          {t("Vault timeout")}
          <select
            id="vault-timeout-select"
            className={controlClass}
            value={choice}
            aria-describedby="vault-timeout-note"
            onChange={(event) => {
              const next = event.target.value as Choice;
              if (next === "custom") {
                // The prefilled minutes count at once; editing them saves again.
                const minutes = typeof value.timeout === "number" ? value.timeout : 60;
                setCustom(String(minutes));
                if (minutes !== value.timeout) save({ ...value, timeout: minutes });
                return;
              }
              setCustom(undefined);
              const minutes = Number(next);
              save({
                ...value,
                timeout: Number.isInteger(minutes)
                  ? minutes
                  : (next as Exclude<Choice, `${number}` | "custom">),
              });
            }}
          >
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
              value={custom ?? (typeof value.timeout === "number" ? String(value.timeout) : "")}
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
            value={value.action}
            onChange={(event) =>
              save({ ...value, action: event.target.value === "log-out" ? "log-out" : "lock" })
            }
          >
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
          ...(value.timeout === "never"
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
              value.action === "log-out"
                ? t("Log out also forgets the sync sign-in; sign in again to use the vault.")
                : t(
                    "Lock keeps the sync sign-in; unlock with the master password, without the server.",
                  ),
          },
          {
            tone: "idle",
            icon: Info,
            text: t(
              "Time counts from the last login filled, passkey signed, unlock or sign-in, on each device by itself. Applies on all your devices.",
            ),
          },
        ]}
      />
    </Panel>
  );
}
