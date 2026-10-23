import { useTranslation } from "react-i18next";
import { i18n } from "../i18n";
import { useEffect, useState } from "react";
import {
  followThemePreference,
  parseThemePreference,
  readThemePreference,
  saveThemePreference,
} from "../theme";
import { controlClass, fieldClass } from "./ui";

/** The pages' color theme; Browser setting follows the browser. */
export function ThemeSelect() {
  const { t } = useTranslation(undefined, { i18n });
  const [preference, setPreference] = useState(readThemePreference);
  useEffect(() => followThemePreference(setPreference), []);
  return (
    <label className={fieldClass}>
      {t("Theme")}
      <select
        id="theme-preference"
        className={controlClass}
        value={preference}
        onChange={(event) => {
          const next = parseThemePreference(event.target.value);
          setPreference(next);
          saveThemePreference(next);
        }}
      >
        <option value="system">{t("Browser setting")}</option>
        <option value="light">{t("Light")}</option>
        <option value="dark">{t("Dark")}</option>
      </select>
    </label>
  );
}
