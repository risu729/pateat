import { profileSettingStore, type ProfileSettingStore } from "./profile-setting";
import { parseThemePreference, saveThemePreference, type ThemePreference } from "./theme";

/**
 * Follows the synced profile setting `theme` (ADR 0024): its value is applied and kept in
 * this origin's `localStorage`, which `followThemePreference` reads before the first render
 * so the page does not flash in the old theme. Absent means the browser setting. Returns a
 * function that stops following.
 */
// Choices this page saved whose change event may still arrive. Its own events are not
// applied again: after a quick dark then light, the late dark event would flip it back.
let ownChoices: ThemePreference[] = [];

/** This page saved the choice as the profile setting, and applied it already. */
export function noteOwnThemeChoice(preference: ThemePreference): void {
  ownChoices.push(preference);
}

export function followProfileTheme(
  store: ProfileSettingStore = profileSettingStore("theme"),
  onChange?: (preference: ThemePreference) => void,
): () => void {
  let changes = 0;
  ownChoices = [];
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
      const own = ownChoices.indexOf(parseThemePreference(value ?? "system"));
      if (own !== -1) {
        ownChoices = ownChoices.slice(own + 1);
        return;
      }
      ownChoices = [];
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
