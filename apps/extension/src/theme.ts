// Kept identical to services/api/web/theme.ts apart from this comment.
import * as v from "valibot";

/** The pages' color theme: follow the browser, or always light or dark. Presentation only. */
export const THEME_PREFERENCES = ["system", "light", "dark"] as const;
export type ThemePreference = (typeof THEME_PREFERENCES)[number];
export const THEME_STORAGE_KEY = "pateat.theme";
const themePreferenceSchema = v.picklist(THEME_PREFERENCES);

export function parseThemePreference(value: unknown): ThemePreference {
  return v.is(themePreferenceSchema, value) ? value : "system";
}

/** The stored choice; "system" when nothing valid is stored or storage is unavailable. */
export function readThemePreference(): ThemePreference {
  try {
    return parseThemePreference(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Sets the stylesheet's `data-theme`; "system" removes it so the browser's scheme applies. */
export function applyThemePreference(
  preference: ThemePreference,
  root: HTMLElement = document.documentElement,
): void {
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
}

/** Stores and applies a choice; other open pages follow through the `storage` event. */
export function saveThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Without storage the choice lasts until this page closes.
  }
  applyThemePreference(preference);
}

/**
 * Applies the stored choice now and again whenever another page of this origin changes
 * it. Returns a function that stops following.
 */
export function followThemePreference(
  onChange?: (preference: ThemePreference) => void,
): () => void {
  applyThemePreference(readThemePreference());
  const listener = (event: StorageEvent) => {
    // A null key means the whole storage was cleared.
    if (event.key !== null && event.key !== THEME_STORAGE_KEY) return;
    const preference = readThemePreference();
    applyThemePreference(preference);
    onChange?.(preference);
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}
