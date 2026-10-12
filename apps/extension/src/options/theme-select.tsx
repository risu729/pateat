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
  const [preference, setPreference] = useState(readThemePreference);
  useEffect(() => followThemePreference(setPreference), []);
  return (
    <label className={fieldClass}>
      Theme
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
        <option value="system">Browser setting</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  );
}
