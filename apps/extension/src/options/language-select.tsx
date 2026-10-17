import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  followLanguagePreference,
  i18n,
  parseLanguagePreference,
  readLanguagePreference,
  saveLanguagePreference,
} from "../i18n";
import { controlClass, fieldClass } from "./ui";

export function LanguageSelect() {
  const { t } = useTranslation(undefined, { i18n });
  const [preference, setPreference] = useState(readLanguagePreference);
  useEffect(() => followLanguagePreference(setPreference), []);
  return (
    <label className={fieldClass}>
      {t("Language")}
      <select
        id="language-preference"
        className={controlClass}
        value={preference}
        onChange={(event) => {
          const next = parseLanguagePreference(event.target.value);
          setPreference(next);
          saveLanguagePreference(next);
        }}
      >
        <option value="system">{t("Browser setting")}</option>
        <option value="en">English</option>
        <option value="ja">日本語</option>
      </select>
    </label>
  );
}
