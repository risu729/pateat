// The toolbar badge tells, per tab, what Pateat is doing or just did there (ADR 0038): a
// waiting account choice, a model request in flight, and how the last login ended; below
// them, how many vault items match the site (ADR 0021). It also keeps the tab's last login
// and model request for the popup's page section.
import type { TFunction } from "i18next";
import * as v from "valibot";
import { browser } from "wxt/browser";
import { localClock } from "../time";
import { pauseSite, type PauseState } from "./pause";
import { i18n } from "../i18n";
import type { AskReason } from "./choice-wire";
import type { LoginReport } from "./runtime";
import type { SiteCount, SiteCountState, UncheckedReason } from "./site-count";

export const LOGIN_BADGE_KEY = "session:pateat.login-badge.v1";

/** A braille spinner; each frame shows for `BUSY_FRAME_MS`. */
export const BUSY_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const BUSY_FRAME_MS = 100;
/**
 * A spin ends on its own after this long: longer than the transport's 90-second inference
 * timeout, so a stop that never arrives cannot leave the badge spinning.
 */
export const BUSY_LIMIT_MS = 2 * 60 * 1000;
/** How long a success or an unsettled result shows before the badge clears. */
export const NOTICE_MS = 4000;

/** Outcomes that ended a login in a failure the person should see (ADR 0038). */
const FAILED = new Set([
  "credential-rejected",
  "structural-mismatch",
  "timeout",
  "retry-limit",
  "submission-limit",
  "value-mismatch",
  "fill-rejected",
  "wrong-account",
  "account-not-listed",
]);
/**
 * Refusals that stop a page's login before it starts: the vault item cannot be used with
 * the recipe (`no-route`, `field-unavailable`), or Pateat cannot keep the login's state
 * (`storage-unavailable`, `attempt-limit`). The owner asked
 * on 2026-10-13 at 20:42 UTC for a failure badge when a login fails after the AI was
 * asked, as on a site whose only item has neither a password nor a passkey.
 */
const FAILED_REFUSALS = new Set([
  "no-route",
  "field-unavailable",
  "storage-unavailable",
  "attempt-limit",
]);
/** Outcomes that ended a login without a known result: shown briefly, as a warning. */
const UNSETTLED = new Set([
  "challenge",
  "unknown-submit",
  "challenge-abandoned",
  "watch-abandoned",
  "left-origin",
]);

export type BadgeResult = {
  kind: "failed" | "succeeded" | "unsettled";
  /**
   * The tab's top page origin when the result was set, else the reporting document's; a
   * later top page of another origin clears it, also after a worker restart.
   */
  origin: string;
  /** The outcome or reason, as the log names it. */
  reason: string;
  /** When a brief result stops showing. */
  until?: number;
};

export type BadgeDetails = {
  tabId: number;
  text?: string;
  color?: string;
  textColor?: string;
  title?: string;
};

/**
 * A tab's last login and last model request, as the log names them, for the popup's page
 * section (ADR 0038). They go with the badge's result: a top page of another origin, or
 * the tab's closing, drops them.
 */
export type PageStatus = {
  /** The tab's top page origin when they were recorded, else the reporting document's. */
  origin: string;
  /**
   * `started` until the login's first state change, then its state and outcome. `fillOnly`
   * for a login that only fills the form while its tab asks for an account and never
   * presses anything (ADR 0021 D).
   */
  login?: {
    state: string;
    outcome?: string;
    cause?: string;
    unconfirmed?: true;
    fillOnly?: true;
  };
  /** A refusal that shows a failure badge, until a login of the tab moves on. */
  refused?: { reason: string; detail?: string };
  /**
   * `sent` while a page is out, then what came back; `page` tells a list of accounts, a
   * sign-in entry or a continuation from a plain sign-in page.
   */
  generation?: {
    outcome: string;
    reason?: string;
    page?: "accounts" | "entry" | "continuation" | "repair";
  };
};

type Shown = Required<Omit<BadgeDetails, "tabId">>;
/**
 * A waiting account choice: how many accounts match, why the tab asks (ADR 0021 D, ADR
 * 0062, ADR 0063), and whether its site is paused (ADR 0062).
 */
type Choice = { count: number; ask?: AskReason; paused?: true };
type Stored = v.InferOutput<typeof storedSchema>;

const STYLES = {
  choice: { color: "#8a5a00", textColor: "#ffffff" },
  busy: { color: "#4f46e5", textColor: "#ffffff" },
  failed: { color: "#b91c1c", textColor: "#ffffff" },
  succeeded: { color: "#15803d", textColor: "#ffffff" },
  unsettled: { color: "#facc15", textColor: "#1e293b" },
  paused: { color: "#6b7280", textColor: "#ffffff" },
  usable: { color: "#115e59", textColor: "#ffffff" },
  excluded: { color: "#cbd5e1", textColor: "#1e293b" },
} as const;
/** The badge text of a tab whose site has automatic login paused (ADR 0062). */
export const PAUSED_TEXT = "II";

const RESULT_TEXT = { failed: "!", succeeded: "✓", unsettled: "!" } as const;

function resultTitle(result: BadgeResult, t: TFunction): string {
  if (result.kind === "succeeded") return t("Pateat: logged in.");
  if (result.kind === "unsettled")
    return t("Pateat: the result of the login is not known ({{reason}}). Click for details.", {
      reason: result.reason,
    });
  return t("Pateat: the login did not succeed ({{reason}}). Click for details.", {
    reason: result.reason,
  });
}

/**
 * The tooltip of a tab whose login waits for an account choice (ADR 0021): the popup's
 * reason line (`choiceReason`), then what a click does. The badge never knows whether
 * another tab's login was rejected, so `other-tab` keeps the sentence that covers both.
 */
function choiceTitle(
  { count, ask, paused }: Choice,
  pause: PauseState | undefined,
  t: TFunction,
): string {
  // In a private window the pause is the private-window setting, not the site's (ADR 0062).
  if (paused && pause && "private" in pause)
    return t("Pateat: automatic login is off in private windows. Click to choose an account.");
  if (paused)
    return t("Pateat: automatic login is paused on this site. Click to choose an account.");
  return ask
    ? t(
        {
          rejected:
            "Pateat: the site did not accept the last login in this tab. Click to choose an account.",
          "rejected-elsewhere":
            "Pateat: the site did not accept a login in another tab. Click to choose an account.",
          "stopped-login":
            "Pateat: the last login on this site stopped in this tab. Click to choose an account.",
          "relogin-limit":
            "Pateat logged in to this site twice in 10 minutes. Click to choose an account.",
          "one-time-pick":
            "Pateat: you chose an account here without making it the default, so Pateat asks until an account is made the default. Click to choose an account.",
        }[ask],
      )
    : t("Pateat: {{count}} accounts match this page. Click to choose one.", { count });
}

// Tooltip keys with `count`; `_one` and `_other` forms in the catalogs.
const EXCLUDED_TITLES = {
  site: "badgeExcludedSite",
  items: "badgeExcludedItems",
  review: "badgeExcludedReview",
  "items-review": "badgeExcludedItemsReview",
} as const;
const MORE_TITLES = {
  site: "badgeMoreExcluded",
  items: "badgeMoreExcluded",
  review: "badgeMoreReview",
  "items-review": "badgeMoreItemsReview",
} as const;
const UNCHECKED_TITLES = {
  locked: "Pateat: the vault is locked, so this site's accounts were not counted.",
  "not-opened":
    "Pateat: the vault has not been opened since Pateat restarted, so this site's accounts were not counted.",
  unreadable: "Pateat: the vault could not be read, so this site's accounts were not counted.",
  updating: "Pateat: the vault is being updated, so this site's accounts were not counted.",
  busy: "Pateat: a login or a page check was using the vault, so this site's accounts were not counted yet.",
  "settings-sync":
    "Pateat: this device has not finished its first settings sync with the sync service, so this site's accounts were not counted.",
  "account-ambiguous":
    "Pateat: saved settings name a vault's account on another server, so this site's accounts were not counted.",
} as const satisfies Record<UncheckedReason, string>;

/** The badge text, colours and title of a site count (ADR 0021); no text for none. */
export function countBadge(
  state: SiteCountState,
  t: TFunction = i18n.t.bind(i18n),
): Partial<Shown> & { title: string } {
  if (state.kind === "unchecked") return { title: t(UNCHECKED_TITLES[state.reason]) };
  const { usable, matching, unevaluated, excluded }: SiteCount = state.count;
  // Sentences follow one another as the language writes them (a space in English).
  const then = (first: string, next: string | false) =>
    next ? t("{{first}} {{next}}", { first, next }) : first;
  const unknown = unevaluated > 0 && t("badgeUnknown", { count: unevaluated });
  const text = (count: number) => (count > 99 ? "99+" : String(count));
  if (usable > 0) {
    const more = matching - usable;
    return {
      text: text(usable),
      ...STYLES.usable,
      title: then(
        then(
          t("badgeUsable", { count: usable }),
          more > 0 && t(MORE_TITLES[excluded ?? "items"], { count: more }),
        ),
        unknown,
      ),
    };
  }
  if (matching > 0)
    return {
      text: text(matching),
      ...STYLES.excluded,
      title: then(t(EXCLUDED_TITLES[excluded ?? "items"], { count: matching }), unknown),
    };
  return { title: then(t("Pateat: no account for this site."), unknown) };
}

/**
 * What a log report means for the badge: a result to show, `clear` for a login that just
 * started or ended in a way that needs no notice, or nothing.
 */
export function badgeResult(
  report: LoginReport,
  now: number,
): Omit<BadgeResult, "origin"> | "clear" | undefined {
  if (report.type === "start") return "clear";
  if (report.type === "refused")
    return FAILED_REFUSALS.has(report.reason) && !report.repeat && !report.unrelated
      ? {
          kind: "failed",
          reason: report.detail ? `${report.reason}: ${report.detail}` : report.reason,
        }
      : undefined;
  if (report.type === "generation")
    return report.outcome === "failed" || report.outcome === "unavailable"
      ? {
          kind: "failed",
          reason: `generation ${report.outcome}${report.reason ? `: ${report.reason}` : ""}`,
        }
      : undefined;
  if (report.type !== "attempt" || report.repeat) return undefined;
  const until = now + NOTICE_MS;
  if (report.state === "authenticated")
    return report.unconfirmed
      ? { kind: "unsettled", reason: "unconfirmed", until }
      : { kind: "succeeded", reason: "authenticated", until };
  const outcome = report.outcome ?? "";
  if (report.state === "blocked") {
    if (FAILED.has(outcome))
      return { kind: "failed", reason: report.cause ? `${outcome}: ${report.cause}` : outcome };
    if (UNSETTLED.has(outcome)) return { kind: "unsettled", reason: outcome, until };
    return "clear";
  }
  // A submission whose result just settled as unknown, or a second factor the page asks
  // for: the login goes on watching later pages (ADR 0027).
  if ((report.settled && outcome === "unknown-submit") || outcome === "challenge")
    return { kind: "unsettled", reason: outcome, until };
  return undefined;
}

/** Writes the given fields of a tab's badge and tooltip with `chrome.action`. */
export function setActionBadge(details: BadgeDetails): Promise<void> {
  const { tabId, text, color, textColor, title } = details;
  return Promise.all([
    text === undefined ? undefined : browser.action.setBadgeText({ tabId, text }),
    color === undefined ? undefined : browser.action.setBadgeBackgroundColor({ tabId, color }),
    textColor === undefined
      ? undefined
      : browser.action.setBadgeTextColor({ tabId, color: textColor }),
    title === undefined ? undefined : browser.action.setTitle({ tabId, title }),
  ]).then(() => undefined);
}

/** A badge that keeps nothing across worker restarts, for a runtime given none. */
export function memoryBadgeStorage() {
  let value: unknown;
  return {
    getValue: async () => value,
    setValue: async (next: unknown) => {
      value = next;
    },
  };
}

export type LoginBadge = ReturnType<typeof createLoginBadge>;

export function createLoginBadge(deps: {
  setBadge: (details: BadgeDetails) => Promise<void>;
  storage: { getValue(): Promise<unknown>; setValue(value: unknown): Promise<void> };
  now?: () => number;
  /** Translates the tooltips into the extension's language, read at each draw. */
  t?: TFunction;
}) {
  const now = deps.now ?? Date.now;
  const t: TFunction = deps.t ?? i18n.t.bind(i18n);
  const choices = new Map<number, Choice>();
  // Each tab's tooltip key, translated when drawn.
  const notes = new Map<number, string>();
  // The pause of each tab's site (ADR 0062), and the timers that redraw when one ends.
  const pauses = new Map<number, PauseState>();
  const pauseTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const results = new Map<number, BadgeResult>();
  // Each tab's site count, for the origin it was counted for (ADR 0021).
  const counts = new Map<number, { origin: string; state: SiteCountState }>();
  // Spins in flight; a tab spins while one names it. A replaced tab's spins move with it.
  const spins = new Set<{ tabId: number }>();
  // Each tab's last attempt state and outcome, so a report that changes neither is ignored.
  const lastAttempt = new Map<number, string>();
  // What each tab shows, as written; only changed fields are written again.
  const shown = new Map<number, Shown>();
  // Each tab's last write, so writes for one tab land in order, and the tabs whose next
  // write has not started.
  const writes = new Map<number, Promise<void>>();
  const waiting = new Set<number>();
  const expiries = new Map<number, ReturnType<typeof setTimeout>>();
  // Each tab's top page origin at its last load.
  const tops = new Map<number, string>();
  // Tabs whose result changed since the worker started, which a restore leaves alone.
  const touched = new Set<number>();
  const statuses = new Map<number, PageStatus>();
  // Tabs whose page status changed since the worker started, which a restore leaves alone.
  const recorded = new Set<number>();
  let frame = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let saved: Promise<void> = Promise.resolve();

  const spinning = (tabId: number) => [...spins].some((spin) => spin.tabId === tabId);
  function wanted(tabId: number): Shown {
    const choice = choices.get(tabId);
    if (choice)
      return {
        text: String(choice.count),
        ...STYLES.choice,
        title: choiceTitle(choice, pauses.get(tabId), t),
      };
    if (spinning(tabId))
      return { text: BUSY_FRAMES[frame] ?? "", ...STYLES.busy, title: t("Pateat: asking the AI…") };
    // A waiting choice and a running model request show over a pause (ADR 0062).
    const paused = pauses.get(tabId);
    if (paused && (!("until" in paused) || paused.until > now()))
      return {
        text: PAUSED_TEXT,
        ...STYLES.paused,
        title:
          "private" in paused
            ? t("Pateat: automatic login is off in private windows.")
            : "unreadable" in paused
              ? t("Pateat: the paused sites could not be read, so automatic login is paused.")
              : "until" in paused
                ? t("Pateat: automatic login is paused on this site until {{time}}.", {
                    time: localClock(paused.until),
                  })
                : t("Pateat: automatic login is paused on this site until turned back on."),
      };
    const result = results.get(tabId);
    if (result && (result.until === undefined || result.until > now()))
      return {
        text: RESULT_TEXT[result.kind],
        ...STYLES[result.kind],
        title: resultTitle(result, t),
      };
    const note = notes.get(tabId);
    const count = counts.get(tabId);
    const counted = count && countBadge(count.state, t);
    if (counted?.text !== undefined && counted.color && counted.textColor)
      return {
        text: counted.text,
        color: counted.color,
        textColor: counted.textColor,
        title: note ? t(note) : counted.title,
      };
    // Colours stay as they were; Chrome shows none without text.
    const last = shown.get(tabId);
    return {
      text: "",
      color: last?.color ?? STYLES.choice.color,
      textColor: last?.textColor ?? STYLES.choice.textColor,
      title: note ? t(note) : (counted?.title ?? t("Pateat")),
    };
  }
  function draw(tabId: number): void {
    // A write still waiting reads the tab's state when it runs, so it covers this one.
    if (waiting.has(tabId)) return;
    waiting.add(tabId);
    const write = (writes.get(tabId) ?? Promise.resolve())
      .then(() => land(tabId))
      .finally(() => {
        if (writes.get(tabId) === write) writes.delete(tabId);
      });
    writes.set(tabId, write);
  }
  async function land(tabId: number): Promise<void> {
    waiting.delete(tabId);
    // Compared with what landed, so a failed write's fields are sent again.
    const next = wanted(tabId);
    const last = shown.get(tabId);
    const details: BadgeDetails = { tabId };
    for (const key of ["text", "color", "textColor", "title"] as const)
      if (last?.[key] !== next[key]) details[key] = next[key];
    if (Object.keys(details).length === 1) return;
    shown.set(tabId, next);
    try {
      await deps.setBadge(details);
    } catch {
      // A closed tab refuses; Chrome drops its badge with it.
      if (shown.get(tabId) === next) shown.delete(tabId);
    }
  }
  function save(): void {
    const value: Stored = {
      results: [...results],
      busy: [...new Set([...spins].map((spin) => spin.tabId))],
      statuses: [...statuses],
    };
    saved = saved.then(() => deps.storage.setValue(value)).catch(() => undefined);
  }
  function expire(tabId: number): void {
    clearTimeout(expiries.get(tabId));
    expiries.delete(tabId);
    const until = results.get(tabId)?.until;
    if (until === undefined) return;
    expiries.set(
      tabId,
      setTimeout(
        () => {
          expiries.delete(tabId);
          if (results.get(tabId)?.until !== until) return;
          results.delete(tabId);
          save();
          draw(tabId);
        },
        Math.max(0, until - now()),
      ),
    );
  }
  /** Sets or clears the tab's result; true when that saved. */
  function setResult(tabId: number, result: BadgeResult | undefined): boolean {
    touched.add(tabId);
    if (result) results.set(tabId, result);
    else if (!results.delete(tabId)) return false;
    expire(tabId);
    save();
    draw(tabId);
    return true;
  }
  /**
   * Keeps what a report tells the popup about the tab's login or model request; true when
   * that changed, for the caller to save.
   */
  function record(report: LoginReport): boolean {
    let change: Partial<Omit<PageStatus, "origin">> | undefined;
    if (report.type === "start") change = { login: { state: "started" } };
    else if (
      report.type === "refused" &&
      !report.repeat &&
      !report.unrelated &&
      FAILED_REFUSALS.has(report.reason)
    )
      change = {
        refused: { reason: report.reason, ...(report.detail ? { detail: report.detail } : {}) },
      };
    else if (report.type === "attempt" && !report.repeat)
      change = {
        login: {
          state: report.state,
          ...(report.outcome ? { outcome: report.outcome } : {}),
          ...(report.cause ? { cause: report.cause } : {}),
          ...(report.unconfirmed ? { unconfirmed: true as const } : {}),
          ...(report.reason === "fill-only" ? { fillOnly: true as const } : {}),
        },
      };
    else if (report.type === "generation" && report.outcome !== "skipped") {
      // A chooser's `other` branch page goes on from its list, as a continuation does.
      const page =
        report.page === "other"
          ? "continuation"
          : (report.page ?? (report.recipeId ? "continuation" : undefined));
      change = {
        generation: {
          outcome: report.outcome,
          ...(report.reason ? { reason: report.reason } : {}),
          ...(page ? { page } : {}),
        },
      };
    }
    if (!change) return false;
    const origin = tops.get(report.tabId) ?? report.origin;
    const before = statuses.get(report.tabId);
    // A status of the page before this one does not carry over.
    const next: PageStatus = { ...(before?.origin === origin ? before : {}), ...change, origin };
    // A login that starts or moves on replaces the refusal before it. The badge keeps its
    // `!` until that login ends, while the popup already says the login runs.
    if (report.type === "start" || report.type === "attempt") delete next.refused;
    recorded.add(report.tabId);
    if (JSON.stringify(next) === JSON.stringify(before)) return false;
    statuses.set(report.tabId, next);
    return true;
  }
  /** Drops the tab's result and page status; true when either was there. */
  function dropResult(tabId: number): boolean {
    recorded.add(tabId);
    clearTimeout(expiries.get(tabId));
    expiries.delete(tabId);
    const status = statuses.delete(tabId);
    return results.delete(tabId) || status;
  }
  function tick(): void {
    if (!spins.size) {
      clearInterval(timer);
      timer = undefined;
      return;
    }
    frame = (frame + 1) % BUSY_FRAMES.length;
    // A tab whose last frame has not landed skips this one rather than queueing it.
    for (const tabId of new Set([...spins].map((spin) => spin.tabId)))
      if (!writes.has(tabId)) draw(tabId);
  }
  function setPause(tabId: number, pause: PauseState | undefined): boolean {
    clearTimeout(pauseTimers.get(tabId));
    pauseTimers.delete(tabId);
    const until = pause && "until" in pause ? pause.until : undefined;
    const live = pause !== undefined && (until === undefined || until > now());
    const before = pauses.get(tabId);
    const changed = live ? JSON.stringify(before) !== JSON.stringify(pause) : before !== undefined;
    if (live) {
      pauses.set(tabId, pause);
      // A pause of a chosen length ends by itself; the badge is drawn again then.
      if (until !== undefined)
        pauseTimers.set(
          tabId,
          setTimeout(() => {
            pauseTimers.delete(tabId);
            if (pauses.get(tabId) !== pause) return;
            pauses.delete(tabId);
            draw(tabId);
          }, until - now()),
        );
    } else pauses.delete(tabId);
    return changed;
  }
  function forget(tabId: number): void {
    touched.add(tabId);
    tops.delete(tabId);
    setPause(tabId, undefined);
    choices.delete(tabId);
    notes.delete(tabId);
    counts.delete(tabId);
    lastAttempt.delete(tabId);
    shown.delete(tabId);
    for (const spin of spins) if (spin.tabId === tabId) spins.delete(spin);
    if (dropResult(tabId)) save();
  }

  return {
    /** The account choice a tab waits on (ADR 0021), or none. */
    choice(tabId: number, choice: Choice | undefined): void {
      if (choice) choices.set(tabId, choice);
      else if (!choices.delete(tabId)) return;
      draw(tabId);
    },
    /**
     * The pause of the tab's site (ADR 0062), or undefined when its site is not paused; the
     * badge shows a gray `II` while it runs.
     */
    paused(tabId: number, pause: PauseState | undefined): void {
      // A tab not drawn since the worker started may still show the `II` of a pause that
      // ended while the worker was stopped, so it is drawn whatever changed.
      if (setPause(tabId, pause) || !shown.has(tabId)) draw(tabId);
    },
    /**
     * A tooltip for a tab that shows no badge, such as why its login is held, as a catalog
     * key that is translated when drawn.
     */
    note(tabId: number, title: string | undefined): void {
      if (title) notes.set(tabId, title);
      else if (!notes.delete(tabId)) return;
      draw(tabId);
    },
    /**
     * The site count of the tab's page (ADR 0021), shown when nothing above it is. A count
     * for another origin than the tab's last loaded page is dropped.
     */
    count(tabId: number, origin: string, state: SiteCountState | undefined): void {
      const top = tops.get(tabId);
      if (top !== undefined && top !== origin) return;
      const before = counts.get(tabId);
      if (state) counts.set(tabId, { origin, state });
      else if (!counts.delete(tabId)) return;
      if (JSON.stringify(before) === JSON.stringify(counts.get(tabId))) return;
      draw(tabId);
    },
    /**
     * Spins the tab's badge until the returned stop is called, or for `BUSY_LIMIT_MS`;
     * overlapping spins of one tab end with the last.
     */
    spin(tabId: number): () => void {
      const spin = { tabId };
      const first = !spinning(tabId);
      spins.add(spin);
      if (first) {
        save();
        draw(tabId);
      }
      timer ??= setInterval(tick, BUSY_FRAME_MS);
      const limit = setTimeout(stop, BUSY_LIMIT_MS);
      function stop(): void {
        if (!spins.delete(spin)) return;
        clearTimeout(limit);
        if (spinning(spin.tabId)) return;
        save();
        draw(spin.tabId);
      }
      return stop;
    },
    /** Reads a log report for how a login ended (ADR 0038). */
    observe(report: LoginReport): void {
      if (report.type === "attempt" && !report.repeat) {
        const key = `${report.state} ${report.outcome ?? ""} ${report.settled ?? ""} ${report.unconfirmed ?? ""}`;
        if (lastAttempt.get(report.tabId) === key) return;
        lastAttempt.set(report.tabId, key);
      }
      if (report.type === "start") lastAttempt.delete(report.tabId);
      const recordedNow = record(report);
      const result = badgeResult(report, now());
      let savedNow = false;
      if (result === "clear") savedNow = setResult(report.tabId, undefined);
      else if (result)
        savedNow = setResult(report.tabId, {
          ...result,
          origin: tops.get(report.tabId) ?? report.origin,
        });
      if (recordedNow && !savedNow) save();
    },
    /**
     * A page or frame of the tab loaded or committed: Chrome may have reset the tab's
     * badge, so it is written again. When the top page's origin changed since the last
     * load, the result, tooltip and choice of the page before no longer apply, and its
     * pause once the site changed. `url` is the top page's, absent for a page Pateat cannot
     * read, which counts as another origin.
     */
    loaded(tabId: number, url?: string): void {
      const origin = (url ? URL.parse(url)?.origin : undefined) ?? "unreadable";
      const before = tops.get(tabId);
      tops.set(tabId, origin);
      if (counts.get(tabId)?.origin !== origin) counts.delete(tabId);
      if (before !== undefined && before !== origin) {
        choices.delete(tabId);
        notes.delete(tabId);
        // A pause covers the whole site (ADR 0062); another site's pause, if any, is set
        // again once the runtime reads it.
        if (pauseSite(before) !== pauseSite(origin)) setPause(tabId, undefined);
        // A restore still reading the stored results must not bring back this tab's.
        touched.add(tabId);
        if (dropResult(tabId)) save();
      }
      shown.delete(tabId);
      // A tab with nothing to show keeps the empty badge Chrome reset it to, unless a write
      // still in flight could land on the new page after that reset.
      if (
        choices.has(tabId) ||
        pauses.has(tabId) ||
        notes.has(tabId) ||
        counts.has(tabId) ||
        results.has(tabId) ||
        spinning(tabId) ||
        writes.has(tabId)
      )
        draw(tabId);
    },
    removed(tabId: number): void {
      forget(tabId);
    },
    /** The extension's language changed: every tab's tooltip is written again. */
    relabel(): void {
      for (const tabId of shown.keys()) draw(tabId);
    },
    /** The tab's last login and model request, for the popup's page section. */
    status(tabId: number): PageStatus | undefined {
      return statuses.get(tabId);
    },
    /** Whether a model request for the tab's page is in flight, as its spin shows. */
    asking(tabId: number): boolean {
      return spinning(tabId);
    },
    /** Chrome gave a tab a new ID (`tabs.onReplaced`); its badge moves with it. */
    replaced(added: number, removed: number): void {
      if (added === removed) return;
      const choice = choices.get(removed);
      const paused = pauses.get(removed);
      const note = notes.get(removed);
      const count = counts.get(removed);
      const result = results.get(removed);
      const status = statuses.get(removed);
      const top = tops.get(removed);
      const moved = [...spins].filter((spin) => spin.tabId === removed);
      forget(removed);
      touched.add(added);
      recorded.add(added);
      if (top !== undefined) tops.set(added, top);
      if (status) statuses.set(added, status);
      if (choice) choices.set(added, choice);
      setPause(added, paused);
      if (note) notes.set(added, note);
      if (count) counts.set(added, count);
      for (const spin of moved) {
        spin.tabId = added;
        spins.add(spin);
      }
      if (result) {
        results.set(added, result);
        expire(added);
      }
      save();
      draw(added);
    },
    /**
     * Rewrites the badges a stopped worker left: results still due, and spins that died
     * with it. Run once at worker start.
     */
    async restore(): Promise<void> {
      let stored: unknown;
      try {
        stored = await deps.storage.getValue();
      } catch {
        return;
      }
      const value = parseStored(stored);
      if (!value) return;
      for (const [tabId, result] of value.results) {
        // A tab that already loaded a page of another origin since the start has moved on.
        const top = tops.get(tabId);
        if (touched.has(tabId) || (top !== undefined && top !== result.origin)) continue;
        if (result.until !== undefined && result.until <= now()) continue;
        results.set(tabId, result);
        // The next load compares with the page the result was set on.
        tops.set(tabId, result.origin);
        expire(tabId);
      }
      for (const [tabId, status] of value.statuses) {
        const top = tops.get(tabId);
        if (recorded.has(tabId) || (top !== undefined && top !== status.origin)) continue;
        statuses.set(tabId, status);
        tops.set(tabId, status.origin);
      }
      for (const tabId of new Set([...value.busy, ...value.results.map(([id]) => id)])) draw(tabId);
      save();
    },
  };
}

const storedSchema = v.object({
  results: v.array(
    v.tuple([
      v.pipe(v.number(), v.integer()),
      v.object({
        kind: v.picklist(["failed", "succeeded", "unsettled"]),
        origin: v.string(),
        reason: v.string(),
        until: v.exactOptional(v.number()),
      }),
    ]),
  ),
  busy: v.array(v.pipe(v.number(), v.integer())),
  statuses: v.array(
    v.tuple([
      v.pipe(v.number(), v.integer()),
      v.object({
        origin: v.string(),
        login: v.exactOptional(
          v.object({
            state: v.string(),
            outcome: v.exactOptional(v.string()),
            cause: v.exactOptional(v.string()),
            unconfirmed: v.exactOptional(v.literal(true)),
            fillOnly: v.exactOptional(v.literal(true)),
          }),
        ),
        refused: v.exactOptional(
          v.object({ reason: v.string(), detail: v.exactOptional(v.string()) }),
        ),
        generation: v.exactOptional(
          v.object({
            outcome: v.string(),
            reason: v.exactOptional(v.string()),
            page: v.exactOptional(v.picklist(["accounts", "entry", "continuation", "repair"])),
          }),
        ),
      }),
    ]),
  ),
});

function parseStored(value: unknown): Stored | undefined {
  const parsed = v.safeParse(storedSchema, value);
  return parsed.success ? parsed.output : undefined;
}
