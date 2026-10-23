import type { LocalSettings } from "@pateat/contracts";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Pause, Play } from "lucide-react";
import { i18n } from "../i18n";
import { Button } from "../options/button";
import type { PauseLength, StatusResponse } from "../login/choice-wire";
import { pauseSite } from "../login/pause";
import { localClock } from "../time";

type Status = Extract<StatusResponse, { ok: true }>;
type ExcludedSite = LocalSettings["excludedSites"][number];

/** The popup's line while automatic login of the tab's site is paused (ADR 0062). */
export function pauseLine(
  until: number | "rule" | "private",
  t: TFunction,
  timeZone?: string,
): string {
  if (until === "private") return t("Automatic login is off in private windows");
  return until === "rule"
    ? t("Paused until turned back on")
    : t("Paused until {{time}}", { time: localClock(until, timeZone) });
}

/** The options page section that holds automatic login in private windows (ADR 0062). */
export const PRIVATE_WINDOWS_SECTION = "private-windows";

/**
 * Whether the tab's page is paused because automatic login is off in private windows, the
 * default (ADR 0062).
 */
export function privatePaused(
  settings: Pick<LocalSettings, "loginInPrivateWindows">,
  incognito: boolean | undefined,
): boolean {
  return incognito === true && settings.loginInPrivateWindows !== true;
}

/**
 * Whether the popup offers to pause automatic login of the tab's site (ADR 0062): on an
 * HTTP(S) page Pateat runs on, once the worker answered for it, when a vault item matches
 * the site or the site has a recipe, as only then can Pateat log in there by itself. A
 * running pause, an exclusion rule covering the site, or automatic login being off in a
 * private window, always shows, so it can be resumed or followed to the settings.
 */
export function pauseShown(status: Status | undefined, matched: boolean, ruled = false): boolean {
  if (ruled) return true;
  if (!status) return false;
  return status.pause !== undefined || matched || status.recipe !== "none";
}

/**
 * The exclusion rules that pause the tab's site until turned back on (ADR 0062). The pause
 * covers the registrable site, so the popup adds one rule for it with its subdomains, and
 * Resume removes the covering rules that name the site or a host in it. A rule for a parent
 * of the site, such as a public suffix, covers other sites too, so only the settings page
 * changes it.
 */
export function siteRules(settings: Pick<LocalSettings, "excludedSites">, origin: string) {
  const url = new URL(origin);
  const hostname = url.hostname.replace(/\.$/u, "");
  const site = pauseSite(url) ?? hostname;
  const covers = (rule: ExcludedSite) =>
    hostname === rule.hostname ||
    (rule.includeSubdomains && hostname.endsWith(`.${rule.hostname}`));
  const within = (rule: ExcludedSite) =>
    rule.hostname === site || rule.hostname.endsWith(`.${site}`);
  const rules = settings.excludedSites.filter(covers);
  return {
    /** The rules that cover the tab's hostname. */
    rules,
    /** The covering rules that also cover other sites; each includes subdomains. */
    shared: rules.filter((rule) => !within(rule)),
    /** Pauses the site until turned back on, in a copy of the settings. */
    pause(value: LocalSettings) {
      value.excludedSites = value.excludedSites.filter((rule) => rule.hostname !== site);
      value.excludedSites.push({ hostname: site, includeSubdomains: true });
    },
    /** Removes the site's own covering rules, in a copy of the settings. */
    resume(value: LocalSettings) {
      value.excludedSites = value.excludedSites.filter((rule) => !(covers(rule) && within(rule)));
    },
  };
}

/**
 * What the popup offers, shortest first (ADR 0062); `rule` pauses until turned back on.
 * `label` names the button and `done` is the notice once paused, both translated.
 */
export const PAUSE_CHOICES: readonly {
  length: PauseLength | "rule";
  label: (t: TFunction) => string;
  done: (t: TFunction) => string;
}[] = [
  {
    length: "10m",
    label: (t) => t("10 minutes"),
    done: (t) => t("Automatic login on this site is paused for 10 minutes"),
  },
  {
    length: "1h",
    label: (t) => t("1 hour"),
    done: (t) => t("Automatic login on this site is paused for an hour"),
  },
  {
    length: "rule",
    label: (t) => t("Until turned back on"),
    done: (t) => t("Automatic login on this site is paused until turned back on"),
  },
];

/** The state of the tab's site the pause row shows. */
export type SitePause =
  | { readonly kind: "running" }
  | { readonly kind: "until"; readonly until: number }
  /** The site's own rule: paused until turned back on, and Resume removes it. */
  | { readonly kind: "rule" }
  /** A rule for other sites too covers the site; it is changed in settings. */
  | { readonly kind: "shared"; readonly rules: readonly ExcludedSite[] }
  /** The tab is in a private window, where automatic login is off; changed in settings. */
  | { readonly kind: "private" };

/**
 * The pause row at the top of the popup (ADR 0062): "Pause automatic login" for 10
 * minutes, an hour or until turned back on, and while paused the end and Resume.
 */
export function PauseControl({
  pause,
  incognito = false,
  busy,
  onPause,
  onResume,
  onOpenSettings,
}: {
  pause: SitePause;
  /**
   * The tab is in a private window. Pausing until turned back on saves a rule to the synced
   * settings, which pauses the site in normal windows too, so only a length is offered.
   */
  incognito?: boolean;
  busy: boolean;
  onPause: (length: PauseLength | "rule") => void;
  onResume: () => void;
  /** Opens the settings page, at `section` when given. */
  onOpenSettings: (section?: string) => void;
}) {
  const { t } = useTranslation(undefined, { i18n });
  if (pause.kind === "running")
    return (
      <fieldset className="popup-pause popup-fieldset" aria-labelledby="popup-pause-label">
        <p id="popup-pause-label" className="popup-muted popup-status">
          <Pause size={16} strokeWidth={2} aria-hidden="true" />
          {t("Pause automatic login")}
        </p>
        <div className="popup-pause-choices">
          {PAUSE_CHOICES.filter((choice) => !incognito || choice.length !== "rule").map(
            (choice) => (
              <Button
                key={choice.length}
                id={`popup-pause-${choice.length}`}
                type="button"
                variant="outline"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (!busy) onPause(choice.length);
                }}
              >
                {choice.label(t)}
              </Button>
            ),
          )}
        </div>
      </fieldset>
    );
  if (pause.kind === "private")
    return (
      <div className="popup-pause">
        <p id="popup-paused" className="popup-muted popup-status">
          <Pause size={16} strokeWidth={2} aria-hidden="true" />
          {pauseLine("private", t)}
        </p>
        <a
          id="popup-private-settings"
          href={`options.html#${PRIVATE_WINDOWS_SECTION}`}
          className="popup-link"
          aria-label={t("Change automatic login in private windows in settings")}
          onClick={(event) => {
            event.preventDefault();
            onOpenSettings(PRIVATE_WINDOWS_SECTION);
          }}
        >
          {t("Change in settings")}
        </a>
      </div>
    );
  return (
    <div className="popup-pause">
      <p id="popup-paused" className="popup-muted popup-status">
        <Pause size={16} strokeWidth={2} aria-hidden="true" />
        {pauseLine(pause.kind === "until" ? pause.until : "rule", t)}
      </p>
      {pause.kind === "shared" ? (
        <div className="popup-pause-shared">
          <p id="popup-site-shared" className="popup-muted">
            {t("Paused by a rule for other sites too")}
          </p>
          <ul className="popup-rules">
            {pause.rules.map((rule) => (
              <li key={`${rule.hostname} ${rule.includeSubdomains}`}>
                <span className="popup-choice-main">
                  <span className="popup-choice-title">{rule.hostname}</span>
                  <span className="popup-choice-sub">{t("and its subdomains")}</span>
                </span>
                <a
                  href="options.html"
                  className="popup-link"
                  aria-label={t("Change in settings for {{hostname}}", {
                    hostname: rule.hostname,
                  })}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenSettings();
                  }}
                >
                  {t("Change in settings")}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <Button
          id="popup-resume"
          type="button"
          variant="outline"
          className="gap-2"
          aria-disabled={busy || undefined}
          onClick={() => {
            if (!busy) onResume();
          }}
        >
          <Play size={16} strokeWidth={2} aria-hidden="true" />
          {t("Resume")}
        </Button>
      )}
    </div>
  );
}
