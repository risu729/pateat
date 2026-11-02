import type { LocalSettings } from "@pateat/contracts";
import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { parseThemePreference, saveThemePreference } from "../theme";
import { noteOwnThemeChoice } from "../theme-profile";
import { controlClass, fieldClass } from "./ui";

/** The pages' color theme, a profile setting synced with the others (ADR 0024). */
export function ThemeSelect({
  draft,
  edit,
  disabled,
}: {
  draft: LocalSettings;
  edit: (update: (value: LocalSettings) => void) => boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation(undefined, { i18n });
  return (
    <label className={fieldClass}>
      {t("Theme")}
      <select
        id="theme-preference"
        className={controlClass}
        value={draft.theme ?? "system"}
        disabled={disabled}
        onChange={(event) => {
          const preference = parseThemePreference(event.target.value);
          // Stored only when chosen, as in the synced document.
          const saved = edit((value) => {
            if (preference === "system") delete value.theme;
            else value.theme = preference;
          });
          // This page switches at once, before the save comes back.
          if (saved) {
            saveThemePreference(preference);
            noteOwnThemeChoice(preference);
          }
        }}
      >
        <option value="system">{t("Browser setting")}</option>
        <option value="light">{t("Light")}</option>
        <option value="dark">{t("Dark")}</option>
      </select>
    </label>
  );
}
