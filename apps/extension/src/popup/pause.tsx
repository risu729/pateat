import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pause, Play } from "lucide-react";
import { i18n } from "../i18n";
import { Button } from "../options/button";
import type { StatusResponse } from "../login/choice-wire";
import { localClock } from "../time";

type Status = Extract<StatusResponse, { ok: true }>;

/** The popup's line while automatic login of the tab's site is paused (ADR 0062). */
export function pauseLine(until: number, t: TFunction, timeZone?: string): string {
  return t("Paused until {{time}}", { time: localClock(until, timeZone) });
}

/**
 * Whether the popup offers to pause automatic login of the tab's site (ADR 0062): on an
 * HTTP(S) page Pateat runs on, once the worker answered for it, when a vault item matches
 * the site or the site has a recipe, as only then can Pateat log in there by itself. A
 * running pause always shows, so it can be resumed.
 */
export function pauseShown(status: Status | undefined, matched: boolean): boolean {
  if (!status) return false;
  return status.pause !== undefined || matched || status.recipe !== "none";
}

/** The pause row under the "Pateat on this site" switch (ADR 0062). */
export function PauseControl({
  until,
  busy,
  onChange,
}: {
  /** While paused: when the pause ends, in epoch milliseconds. */
  until: number | undefined;
  busy: boolean;
  onChange: (paused: boolean) => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  if (until === undefined)
    return (
      <div className="popup-pause">
        <Button
          id="popup-pause"
          type="button"
          variant="outline"
          className="gap-2"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onChange(true);
          }}
        >
          <Pause size={16} strokeWidth={2} aria-hidden="true" />
          {t("Pause automatic login")}
        </Button>
      </div>
    );
  return (
    <div className="popup-pause">
      <p id="popup-paused" className="popup-muted popup-status">
        <Pause size={16} strokeWidth={2} aria-hidden="true" />
        {pauseLine(until, t)}
      </p>
      <Button
        id="popup-resume"
        type="button"
        variant="outline"
        className="gap-2"
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) onChange(false);
        }}
      >
        <Play size={16} strokeWidth={2} aria-hidden="true" />
        {t("Resume")}
      </Button>
    </div>
  );
}
