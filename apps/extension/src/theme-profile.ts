import { profileSettingStore, type ProfileSettingStore } from "./profile-setting";
import { parseThemePreference, saveThemePreference, type ThemePreference } from "./theme";

/**
 * Follows the synced profile setting `theme` (ADR 0024): its value is applied and kept in
 * this origin's `localStorage`, which `followThemePreference` reads before the first render
 * so the page does not flash in the old theme. Absent means the browser setting. Returns a
 * function that stops following.
 */
export function followProfileTheme(
  store: ProfileSettingStore = profileSettingStore("theme"),
  onChange?: (preference: ThemePreference) => void,
): () => void {
  let changes = 0;
  const take = (value: unknown) => {
    const preference = parseThemePreference(value ?? "system");
    saveThemePreference(preference);
    onChange?.(preference);
  };
  let unwatch = () => {};
  try {
    // Watched before the read, so a change while it runs is not missed.
    unwatch = store.watch((value) => {
      changes += 1;
      take(value);
    });
  } catch {
    // A store that cannot be watched still gives its value at start.
  }
  const before = changes;
  void (async () => {
    let value: unknown;
    try {
      value = await store.get();
    } catch {
      return;
    }
    // A change seen while the read ran is newer than what was read.
    if (changes === before) take(value);
  })();
  return unwatch;
}
