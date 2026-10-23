import { Pause, Play } from "lucide-react";
import { Button } from "../options/button";
import type { PauseLength, StatusResponse } from "../login/choice-wire";
import { localClock } from "../time";

type Status = Extract<StatusResponse, { ok: true }>;

/** The popup's line while automatic login of the tab's site is paused (ADR 0062). */
export function pauseLine(until: number, timeZone?: string): string {
  return `Paused until ${localClock(until, timeZone)}`;
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

/** The lengths the popup offers, shortest first (ADR 0062). */
export const PAUSE_CHOICES: readonly { length: PauseLength; label: string; done: string }[] = [
  { length: "10m", label: "10 minutes", done: "for 10 minutes" },
  { length: "1h", label: "1 hour", done: "for an hour" },
];

/** The pause row under the "Pateat on this site" switch (ADR 0062). */
export function PauseControl({
  until,
  busy,
  onChange,
}: {
  /** While paused: when the pause ends, in epoch milliseconds. */
  until: number | undefined;
  busy: boolean;
  /** A length pauses; `undefined` resumes. */
  onChange: (length: PauseLength | undefined) => void;
}) {
  if (until === undefined)
    return (
      <div className="popup-pause" role="group" aria-labelledby="popup-pause-label">
        <p id="popup-pause-label" className="popup-muted popup-status">
          <Pause size={16} strokeWidth={2} aria-hidden="true" />
          Pause automatic login
        </p>
        <div className="popup-pause-choices">
          {PAUSE_CHOICES.map((choice) => (
            <Button
              key={choice.length}
              id={`popup-pause-${choice.length}`}
              type="button"
              variant="outline"
              aria-disabled={busy || undefined}
              onClick={() => {
                if (!busy) onChange(choice.length);
              }}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      </div>
    );
  return (
    <div className="popup-pause">
      <p id="popup-paused" className="popup-muted popup-status">
        <Pause size={16} strokeWidth={2} aria-hidden="true" />
        {pauseLine(until)}
      </p>
      <Button
        id="popup-resume"
        type="button"
        variant="outline"
        className="gap-2"
        aria-disabled={busy || undefined}
        onClick={() => {
          if (!busy) onChange(undefined);
        }}
      >
        <Play size={16} strokeWidth={2} aria-hidden="true" />
        Resume
      </Button>
    </div>
  );
}
