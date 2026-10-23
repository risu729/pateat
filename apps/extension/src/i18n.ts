import { createInstance } from "i18next";
import * as v from "valibot";
import { en } from "./locales/en";
import { ja } from "./locales/ja";

export const LANGUAGE_PREFERENCES = ["system", "en", "ja"] as const;
export type LanguagePreference = (typeof LANGUAGE_PREFERENCES)[number];
export type Language = Exclude<LanguagePreference, "system">;
export const LANGUAGE_STORAGE_KEY = "pateat.language";
const preferenceSchema = v.picklist(LANGUAGE_PREFERENCES);

/** A separate instance keeps the extension's resources independent of other programs. */
export const i18n = createInstance();
void i18n.init({
  resources: { en: { translation: en }, ja: { translation: ja } },
  lng: "en",
  fallbackLng: "en",
  supportedLngs: ["en", "ja"],
  // Resources are bundled; initialization completes before any component renders.
  initAsync: false,
  keySeparator: false,
  nsSeparator: false,
  // React inserts every translated string as text, including interpolated vault labels.
  interpolation: { escapeValue: false },
});

export function parseLanguagePreference(value: unknown): LanguagePreference {
  return v.is(preferenceSchema, value) ? value : "system";
}

export function readLanguagePreference(): LanguagePreference {
  try {
    return parseLanguagePreference(localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Follow the first supported browser language; regional variants use the base language. */
export function resolveLanguage(
  preference: LanguagePreference,
  languages: readonly string[] = navigator.languages,
): Language {
  if (preference !== "system") return preference;
  for (const language of languages) {
    const base = language.toLowerCase().split("-")[0];
    if (base === "en" || base === "ja") return base;
  }
  return "en";
}

/**
 * The locale for dates and lists in the UI language: the browser's own regional form of it
 * when the browser lists one (`en-GB` for English), else the language itself.
 */
export function formatLocale(
  language: string = i18n.resolvedLanguage ?? "en",
  languages: readonly string[] = navigator.languages,
): string {
  return languages.find((tag) => tag.toLowerCase().split("-")[0] === language) ?? language;
}

let activePreference: LanguagePreference = "system";

function applyLanguagePreference(preference: LanguagePreference): void {
  activePreference = preference;
  void i18n.changeLanguage(resolveLanguage(preference));
}

/** Retain the selected language on this page even if localStorage is unavailable. */
export function saveLanguagePreference(preference: LanguagePreference): void {
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // The applied choice lasts until the page closes.
  }
  applyLanguagePreference(preference);
}

/** Initialize a page and follow changes from other extension pages and the browser. */
export function followLanguagePreference(
  onChange?: (preference: LanguagePreference) => void,
): () => void {
  const update = () => {
    const preference = readLanguagePreference();
    applyLanguagePreference(preference);
    onChange?.(preference);
  };
  const storageChanged = (event: StorageEvent) => {
    if (event.key === null || event.key === LANGUAGE_STORAGE_KEY) update();
  };
  const browserChanged = () => {
    // An explicit choice still applies when localStorage rejected the write.
    applyLanguagePreference(activePreference);
    onChange?.(activePreference);
  };
  update();
  window.addEventListener("storage", storageChanged);
  window.addEventListener("languagechange", browserChanged);
  return () => {
    window.removeEventListener("storage", storageChanged);
    window.removeEventListener("languagechange", browserChanged);
  };
}

/** Set metadata only on pages whose content has been translated. */
export function followLanguageMetadata(title: string): () => void {
  const update = () => {
    document.documentElement.lang = i18n.resolvedLanguage ?? "en";
    document.title = i18n.t(title);
  };
  update();
  i18n.on("languageChanged", update);
  return () => i18n.off("languageChanged", update);
}
