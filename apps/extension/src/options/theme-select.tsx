import { useEffect, useState } from "react";
import {
  followThemePreference,
  parseThemePreference,
  readThemePreference,
  saveThemePreference,
} from "../theme";

/** The pages' color theme; System follows the browser. */
export function ThemeSelect() {
  const [preference, setPreference] = useState(readThemePreference);
  useEffect(() => followThemePreference(setPreference), []);
  return (
    <label className="max-w-xs">
      Theme
      <select
        id="theme-preference"
        value={preference}
        onChange={(event) => {
          const next = parseThemePreference(event.target.value);
          setPreference(next);
          saveThemePreference(next);
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
