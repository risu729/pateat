import { useEffect, useState } from "react";
import {
  followThemePreference,
  parseThemePreference,
  readThemePreference,
  saveThemePreference,
} from "./theme";

/** The pages' color theme; System follows the browser. */
export function ThemeSelect() {
  const [preference, setPreference] = useState(readThemePreference);
  useEffect(() => followThemePreference(setPreference), []);
  return (
    <label className="flex items-center gap-2">
      Theme
      <select
        id="theme-preference"
        value={preference}
        onChange={(event) => {
          const next = parseThemePreference(event.target.value);
          setPreference(next);
          saveThemePreference(next);
        }}
        className="min-h-10 rounded-lg border border-border-strong bg-surface px-3"
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
