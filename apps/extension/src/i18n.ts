import { createInstance } from "i18next";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";
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

/**
 * Where the preference is kept. Extension pages and the service worker share
 * `chrome.storage.local` (`extensionLanguageStore`), so the worker's toolbar titles follow
 * it too; tests and pages without one use memory.
 */
export type LanguageStore = {
  get(): Promise<unknown>;
  set(preference: LanguagePreference): Promise<void>;
  /** Calls back with each stored value written elsewhere; returns the unwatch. */
  watch(changed: (value: unknown) => void): () => void;
};

/** The extension's store: `local:pateat.language` through WXT's storage wrapper. */
export function extensionLanguageStore(): LanguageStore {
  const item = storage.defineItem<unknown>(`local:${LANGUAGE_STORAGE_KEY}`);
  return {
    get: () => item.getValue(),
    set: (preference) => item.setValue(preference),
    watch: (changed) => item.watch(changed),
  };
}

export function memoryLanguageStore(initial?: unknown): LanguageStore {
  let value = initial;
  const watchers = new Set<(value: unknown) => void>();
  return {
    get: async () => value,
    set: async (preference) => {
      value = preference;
      for (const watcher of watchers) watcher(preference);
    },
    watch(changed) {
      watchers.add(changed);
      return () => watchers.delete(changed);
    },
  };
}

let store = memoryLanguageStore();
let activePreference: LanguagePreference = "system";
// Counts applied preferences, so a read that finishes after a newer choice is dropped.
let applied = 0;
const preferenceWatchers = new Set<(preference: LanguagePreference) => void>();

function applyLanguagePreference(preference: LanguagePreference): void {
  applied += 1;
  activePreference = preference;
  void i18n.changeLanguage(resolveLanguage(preference));
  for (const watcher of preferenceWatchers) watcher(preference);
}

/** The preference this program applies now. */
export function currentLanguagePreference(): LanguagePreference {
  return activePreference;
}

/** Calls back with each later preference this program applies; returns the unwatch. */
export function watchLanguagePreference(
  changed: (preference: LanguagePreference) => void,
): () => void {
  preferenceWatchers.add(changed);
  return () => preferenceWatchers.delete(changed);
}

// Values this program wrote whose change event may still arrive. Its own events are not
// applied again: after a quick ja then en, the late ja event would flip the page back.
let ownWrites: unknown[] = [];

/** Apply the choice at once; it lasts until the program ends if the store rejects it. */
export function saveLanguagePreference(preference: LanguagePreference): void {
  applyLanguagePreference(preference);
  ownWrites.push(preference);
  void store.set(preference).catch(() => undefined);
}

function storedChanged(value: unknown): void {
  const own = ownWrites.indexOf(value);
  if (own !== -1) {
    ownWrites = ownWrites.slice(own + 1);
    return;
  }
  ownWrites = [];
  applyLanguagePreference(parseLanguagePreference(value));
}

/**
 * Read the stored preference before the first render, then follow changes made on other
 * extension pages and the browser's own language list. An unreadable store is the
 * browser setting.
 */
export async function followLanguagePreference(
  next: LanguageStore = extensionLanguageStore(),
): Promise<() => void> {
  store = next;
  ownWrites = [];
  const before = applied;
  // Watched before the read, so a write elsewhere while it runs is not missed.
  let unwatch = () => {};
  try {
    unwatch = store.watch(storedChanged);
  } catch {
    // A store that cannot be watched still gives its value at start.
  }
  let stored: unknown;
  try {
    stored = await store.get();
  } catch {
    stored = undefined;
  }
  // A choice made here, or a change seen, while the read ran is newer than what was read.
  if (applied === before) applyLanguagePreference(parseLanguagePreference(stored));
  // Pages and the service worker both see `languagechange` when the browser's list changes.
  const browserChanged = () => applyLanguagePreference(activePreference);
  globalThis.addEventListener("languagechange", browserChanged);
  return () => {
    unwatch();
    globalThis.removeEventListener("languagechange", browserChanged);
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
