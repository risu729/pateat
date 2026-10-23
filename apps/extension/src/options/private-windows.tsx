import type { LocalSettings } from "@pateat/contracts";
import { Info, Pause } from "lucide-react";
import { useEffect, useRef } from "react";
import { PRIVATE_WINDOWS_SECTION } from "../popup/pause";
import { checkClass, Panel, StatusLines } from "./ui";

/**
 * Automatic login in private (incognito) windows, off by default (ADR 0062). While off,
 * every site in a private window is paused, as the popup's pause pauses a site. The
 * popup's link opens the page at this section.
 */
export function PrivateWindows({
  draft,
  edit,
}: {
  draft: LocalSettings;
  edit: (update: (value: LocalSettings) => void) => boolean;
}) {
  const toggle = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (window.location.hash !== `#${PRIVATE_WINDOWS_SECTION}`) return;
    document.getElementById(PRIVATE_WINDOWS_SECTION)?.scrollIntoView();
    toggle.current?.focus();
  }, []);
  const on = draft.loginInPrivateWindows === true;
  return (
    <Panel id={PRIVATE_WINDOWS_SECTION} headingId="private-windows-heading" title="Private windows">
      <label className={checkClass}>
        <input
          ref={toggle}
          id="login-in-private-windows"
          type="checkbox"
          checked={on}
          onChange={(event) => {
            const next = event.target.checked;
            edit((settings) => {
              // Off is the absent field, the default.
              if (next) settings.loginInPrivateWindows = true;
              else delete settings.loginInPrivateWindows;
            });
          }}
        />
        Log in automatically in private windows
      </label>
      <StatusLines
        muted
        lines={[
          {
            tone: "idle",
            icon: Pause,
            text: on
              ? "Pateat logs in by itself in private windows as in other windows"
              : "Off: every site in a private window is paused, so Pateat logs in there only with an account picked in the toolbar popup",
          },
          {
            tone: "idle",
            icon: Info,
            text: "Applies on all your devices; other windows are not affected",
          },
        ]}
      />
    </Panel>
  );
}
