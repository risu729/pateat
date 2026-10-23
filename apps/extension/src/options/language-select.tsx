import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  currentLanguagePreference,
  i18n,
  parseLanguagePreference,
  saveLanguagePreference,
  watchLanguagePreference,
} from "../i18n";
import { controlClass, fieldClass } from "./ui";

export function LanguageSelect() {
  const { t } = useTranslation(undefined, { i18n });
  const [preference, setPreference] = useState(currentLanguagePreference);
  // The page read the stored choice before rendering; this follows changes made elsewhere.
  useEffect(() => watchLanguagePreference(setPreference), []);
  return (
    <label className={fieldClass}>
      {t("Language")}
      <select
        id="language-preference"
        className={controlClass}
        value={preference}
        onChange={(event) => saveLanguagePreference(parseLanguagePreference(event.target.value))}
      >
        <option value="system">{t("Browser setting")}</option>
        <option value="en">English</option>
        <option value="ja">日本語</option>
      </select>
    </label>
  );
}
