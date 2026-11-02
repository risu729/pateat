import type { LocalSettings } from "@pateat/contracts";
import { useTranslation } from "react-i18next";
import { i18n, parseLanguagePreference, saveLanguagePreference } from "../i18n";
import { controlClass, fieldClass } from "./ui";

/** The pages' language, a profile setting synced with the others (ADR 0024, ADR 0043). */
export function LanguageSelect({
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
      {t("Language")}
      <select
        id="language-preference"
        className={controlClass}
        value={draft.language ?? "system"}
        disabled={disabled}
        onChange={(event) => {
          const preference = parseLanguagePreference(event.target.value);
          // Stored only when chosen, as in the synced document.
          const saved = edit((value) => {
            if (preference === "system") delete value.language;
            else value.language = preference;
          });
          // This page switches at once, before the save comes back.
          if (saved) saveLanguagePreference(preference);
        }}
      >
        <option value="system">{t("Browser setting")}</option>
        <option value="en">English</option>
        <option value="ja">日本語</option>
      </select>
    </label>
  );
}
