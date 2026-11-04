import {
  PROBLEM_EVENT_FIELDS,
  PROBLEM_PAGE_FIELDS,
  problemInfoLine,
  problemLocalOnly,
  REDACTED_PATH_SEGMENT,
  type ProblemFieldKind,
} from "@pateat/contracts";
import * as v from "valibot";
import { observedPath } from "../observation/path";
import { isoMinute, isoTime } from "../time";
import {
  HOUR_MS,
  LOG_EVENTS,
  MAX_FIELD_LENGTH,
  PAGE_FIELDS,
  TRUNCATED,
  type FieldKind,
  type FieldValue,
} from "./log-events";
import { KIND_SCHEMAS, PARAMETER_NAME, STORED_SCHEMAS, type LogEntry } from "./log-fields";
import type { LogEventName } from "./log-events";

type Substitute = (kind: "origin" | "rpId" | "recipe", value: string) => string;

/** Numbers sites as `site-N` and recipes as `recipe-N`, in order of first appearance. */
function siteSubstitution(): Substitute {
  const sites = new Map<string, string>();
  const recipes = new Map<string, string>();
  const replace = (names: Map<string, string>, prefix: string, value: string) => {
    let replaced = names.get(value);
    if (!replaced) {
      replaced = `${prefix}-${names.size + 1}`;
      names.set(value, replaced);
    }
    return replaced;
  };
  return (kind, value) => {
    if (kind === "origin") return replace(sites, "site", value);
    if (kind === "recipe") return replace(recipes, "recipe", value);
    // An RP ID shares its number with the origin of the same host.
    const origin = `https://${value}`;
    return replace(sites, "site", sites.has(origin) ? origin : value);
  };
}

/**
 * A query's or fragment's `name=value` parameters with their values left out, as
 * `code=&state=`. A part without `=` or with an empty value, which may be a token itself
 * (`?<token>` or a base64 token's `=` padding), and a name that does not look like one
 * are left out too (owner decision, 2026-10-13).
 */
function parameterNames(parameters: string): string {
  return parameters
    .split("&")
    .flatMap((part) => {
      const at = part.indexOf("=");
      if (at < 0) return [];
      const name = part.slice(0, at);
      const value = part.slice(at + 1);
      return PARAMETER_NAME.test(name) && value !== "" && !/^=+$/u.test(value) ? [`${name}=`] : [];
    })
    .join("&");
}

/**
 * A fragment as the log keeps it: a route the page shows (`#/signin`) with its own
 * query's parameter names, parameters by name only (`#access_token=&state=`), and an
 * anchor (`#top`) as `#` alone, since a fragment may be a token.
 */
function fragmentShape(hash: string): string {
  if (hash === "") return "";
  // A second `#` is part of the fragment; what follows it is left out.
  const fragment = hash.slice(1).split("#")[0]!;
  const query = fragment.indexOf("?");
  const route = query < 0 ? fragment : fragment.slice(0, query);
  if (/^!?\//u.test(route) && !route.includes("=")) {
    return query < 0 ? `#${route}` : `#${route}?${parameterNames(fragment.slice(query + 1))}`;
  }
  return fragment.includes("=") ? `#${parameterNames(fragment)}` : "#";
}

/**
 * A page URL's path, with the names of its query's and fragment's parameters but none of
 * their values, when `origin` is the URL's own as recorded in full; a pseudonymized origin
 * gets none (ADR 0019). A query or fragment can carry an authorization code, a token or an
 * email address, so `/callback?code=abc&state=xyz` is kept as `/callback?code=&state=`.
 */
export function pagePath(raw: FieldValue, origin: FieldValue | undefined): string | undefined {
  if (typeof raw !== "string" || typeof origin !== "string") return undefined;
  const url = URL.parse(raw);
  if (!url) return undefined;
  // A `blob:` or similar URL reports its inner origin but no path of its own.
  if (url.origin !== origin || !url.pathname.startsWith("/")) return undefined;
  const query = url.search === "" ? "" : `?${parameterNames(url.search.slice(1))}`;
  const shaped = `${url.pathname}${query}${fragmentShape(url.hash)}`;
  // A cut would leave a part of a name; a long one keeps its path alone.
  return shaped.length <= MAX_FIELD_LENGTH ? shaped : url.pathname.slice(0, MAX_FIELD_LENGTH);
}

/** Only allowlisted fields that still pass their stored-value check leave the page. */
function exportedFields(entry: LogEntry, substitute?: Substitute): Record<string, FieldValue> {
  const kinds: Readonly<Record<string, FieldKind>> = LOG_EVENTS[entry.event].fields;
  const fields: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(entry.fields)) {
    const kind = kinds[key] ?? PAGE_FIELDS[key];
    if (!kind || (value !== TRUNCATED && !v.is(STORED_SCHEMAS[kind], value))) continue;
    // Hiding sites leaves page URLs out, and the bug report never carries them.
    if (substitute && kind === "url") continue;
    fields[key] =
      substitute &&
      typeof value === "string" &&
      value !== TRUNCATED &&
      (kind === "origin" || kind === "rpId" || kind === "recipe")
        ? substitute(kind, value)
        : value;
  }
  return fields;
}

export type ProblemLine = {
  level: "info" | "warn" | "error";
  event: LogEventName;
  time: number;
  fields: Record<string, FieldValue>;
};

/**
 * True for a path segment that holds `@`, as it is or percent-decoded up to three times
 * as `tokenSegment` decodes: it may be an email address.
 */
function emailSegment(segment: string): boolean {
  let form = segment;
  for (let round = 0; round < 4; round += 1) {
    if (form.includes("@")) return true;
    try {
      const decoded = decodeURIComponent(form);
      if (decoded === form) return false;
      form = decoded;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Whether an entry goes to the service (ADR 0066): every `warn` and `error` entry, and an
 * `info` entry that says why Pateat did nothing on a page (`PROBLEM_INFO_LINES`), except a
 * passkey report or a fill-only login's line, which stay local (`problemLocalOnly`).
 */
export function sentToService(entry: Pick<LogEntry, "level" | "event" | "fields">): boolean {
  if (problemLocalOnly(entry.event, entry.fields)) return false;
  if (entry.level === "warn" || entry.level === "error") return true;
  return entry.level === "info" && problemInfoLine(entry.event, entry.fields);
}

/**
 * Blocked outcomes of a login that filled and clicked nothing at its step (`login.attempt`):
 * a wrong account, a value that does not fit, a fill the page refused, an account its list
 * does not show. Every other outcome may follow a submit, such as a challenge, a watch that
 * ended, a cancel or a move to another origin. These may too at a later step, as a wrong
 * account on the password page after Next, so the line must also be `unsubmitted`.
 */
const PRE_SUBMIT_BLOCKS: ReadonlySet<unknown> = new Set([
  "wrong-account",
  "account-switched",
  "value-mismatch",
  "fill-rejected",
  "account-not-listed",
]);
/**
 * Refusals of a sign-in entry press (`login.entry`, ADR 0031) checked before the press, on
 * the page at the entry recipe's own path. `unconfirmed`, `exception` and `page-changed`
 * are not: the press may have happened, or the page moved.
 */
const PRE_PRESS_ENTRY_REFUSALS: ReadonlySet<unknown> = new Set([
  "blocked",
  "recipe-changed",
  "no-return-target",
  "no-site",
  "site-record",
  "site-held",
  "paused",
  "press-limit",
  "settings-unavailable",
  "no-vault-match",
  "storage-unavailable",
  "in-progress",
  "no-answer",
  "target-missing",
  "target-ambiguous",
  "not-link",
  "script-link",
  "hidden",
  "no-text",
  "new-window",
  "download",
  "link-off-site",
  "link-not-https",
  "link-query-off-site",
  "link-same-page",
  "destination-excluded",
  "destination-not-allowed",
  "target-changed",
  "cancelled",
]);
/** Generation outcomes of a page that went out after its usernames were hidden (ADR 0039). */
const SENT_GENERATIONS: ReadonlySet<unknown> = new Set(["abstained", "unavailable", "failed"]);
/** Generation skips of a page already sent, so it passed the same checks. */
const SENT_SKIPS: ReadonlySet<unknown> = new Set(["sending", "sent"]);

/**
 * Whether a line may carry its page's path (ADR 0066): only a combination of event and
 * state, outcome or reason known to come before a login's submit, where the page's path is
 * a recipe's own or one already sent for generation. A page after a submit is likely signed
 * in and its path may hold the account's identifier, which the log cannot read the vault
 * to hide. Every other line, and every event or reason added to the log later, sends no
 * path until it is listed here.
 */
function pathAllowed(entry: LogEntry): boolean {
  const { fields } = entry;
  switch (entry.event) {
    // A login's start, and a recipe the chosen item cannot run, on a new login's first page
    // (ADR 0058 A).
    case "login.start":
    case "recipe.unfit":
      return true;
    // A login that stopped at a step it neither filled nor clicked, before it submitted
    // anything and in the document it began in (`unsubmitted`), outside a handler (as a code
    // page) and before any result was watched or settled.
    case "login.attempt":
      return (
        fields["unsubmitted"] === true &&
        fields["state"] === "blocked" &&
        PRE_SUBMIT_BLOCKS.has(fields["outcome"]) &&
        fields["handler"] === undefined &&
        fields["settled"] === undefined
      );
    // An exception before the login submitted anything, in the document it began in.
    case "login.exception":
      return fields["unsubmitted"] === true;
    case "login.entry":
      return fields["outcome"] === "refused" && PRE_PRESS_ENTRY_REFUSALS.has(fields["reason"]);
    // A new login's page where a recipe starts but its first step is not found. Other
    // refusals may come from a resumed login's later page, after a submit.
    case "login.refused":
      return fields["reason"] === "not-started" && fields["detail"] === "first-step-missing";
    // A page sent for generation and not read as signed in (ADR 0035).
    case "recipe.generate":
      return (
        fields["signedIn"] !== true &&
        (SENT_GENERATIONS.has(fields["outcome"]) ||
          (fields["outcome"] === "skipped" && SENT_SKIPS.has(fields["reason"])))
      );
    default:
      return false;
  }
}

/**
 * A stored page path as it leaves in a problem line: without its query's and fragment's
 * parameter names, each segment that may carry a token or an email address replaced by
 * `[id]` as in an observation (ADR 0039), and a last segment that a cut at the field limit
 * may have left partial replaced too.
 */
function problemPath(stored: string): string {
  const path = stored.split(/[?#]/u, 1)[0]!;
  const segments = observedPath(path).split("/");
  if (path === stored && stored.length >= MAX_FIELD_LENGTH)
    segments[segments.length - 1] = REDACTED_PATH_SEGMENT;
  return segments
    .map((segment) => (emailSegment(segment) ? REDACTED_PATH_SEGMENT : segment))
    .join("/");
}

/**
 * An entry as it is sent to the service (ADR 0066), or nothing for one that does not go
 * ({@link sentToService}): the fields a download carries with sites shown that the contract
 * lets the event carry (`PROBLEM_EVENT_FIELDS`, which leaves out the item and connection
 * pseudonyms), with the line's own page (`url`) as {@link problemPath} only where
 * {@link pathAllowed} and no other page's, such as the tab's previous one, and no value the
 * log cut. Origins of sites not set up stay pseudonyms.
 */
export function problemLine(entry: LogEntry): ProblemLine | undefined {
  if (!sentToService(entry) || entry.level === "debug") return undefined;
  const events: Readonly<Record<string, Readonly<Record<string, ProblemFieldKind>>>> =
    PROBLEM_EVENT_FIELDS;
  const kinds: Readonly<Record<string, ProblemFieldKind>> = {
    ...PROBLEM_PAGE_FIELDS,
    ...(Object.hasOwn(events, entry.event) ? events[entry.event] : {}),
  };
  const fields: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(exportedFields(entry))) {
    const kind = Object.hasOwn(kinds, key) ? kinds[key] : undefined;
    if (!kind || value === TRUNCATED) continue;
    // Only the line's own page may leave, never another, such as the tab's previous page.
    if (kind === "path") {
      if (key === "url" && typeof value === "string" && pathAllowed(entry))
        fields[key] = problemPath(value);
    } else fields[key] = value;
  }
  return { level: entry.level, event: entry.event, time: entry.time, fields };
}

/**
 * The text that leaves the page on "Download logs". Unless `includeSites`, every origin
 * and RP ID becomes `site-N` and every recipe ID `recipe-N`, numbered within this export.
 */
export function formatLogExport(
  entries: readonly LogEntry[],
  context: { version: string; revision: string; exportedAt: number; includeSites: boolean },
): string {
  const substitute = context.includeSites ? undefined : siteSubstitution();
  const lines = entries.map((entry) =>
    JSON.stringify({
      time: isoTime(entry.time),
      level: entry.level,
      event: entry.event,
      ...exportedFields(entry, substitute),
    }),
  );
  const header = JSON.stringify({
    pateat: context.version,
    revision: context.revision,
    exportedAt: isoTime(context.exportedAt),
    sites: context.includeSites ? "included" : "replaced",
    entries: entries.length,
  });
  return [header, ...lines].join("\n") + "\n";
}

export const RECENT_PROBLEMS = 10;
export const RECENT_WINDOW_MS = 24 * HOUR_MS;
export const RECENT_LINE_LENGTH = 2048;
export const RECENT_DELEGATION_REASONS = 32;

/** The log's part of "Copy for bug report"; sites are always numbered. */
export type RecentLog = {
  /** Warnings and errors from the last 24 hours, newest first. */
  problems: string[];
  /** The last update this log saw, from any time it still holds. */
  updated?: { time: number; from: string };
  /** Passkey requests left to the browser in the last 24 hours, by reason. */
  passkeyDelegations: { reason: string; count: number }[];
  /**
   * Pages that looked like a verification but were not sent for generation in the last 24
   * hours, by reason: a secret answer of `type="text"` or a frame (ADR 0035).
   */
  unsentVerifications: { reason: string; count: number }[];
};
/** The `recipe.generate` skip reasons of a page that looks like a verification (ADR 0035). */
const UNSENT_VERIFICATION_REASONS: ReadonlySet<string> = new Set(["text-answer", "frame"]);

export function recentLog(entries: readonly LogEntry[], now: number): RecentLog {
  const since = now - RECENT_WINDOW_MS;
  const substitute = siteSubstitution();
  const newest = [...entries].sort((a, b) => b.time - a.time);
  const problems = newest
    // A far-future time (a wrong clock) is left out rather than listed first.
    .filter(
      (entry) =>
        (entry.level === "warn" || entry.level === "error") &&
        entry.time >= since &&
        entry.time <= now + RECENT_WINDOW_MS,
    )
    .slice(0, RECENT_PROBLEMS)
    .map((entry) =>
      [
        isoMinute(entry.time),
        entry.level,
        entry.event,
        ...Object.values(exportedFields(entry, substitute)).map(String),
      ]
        .join(" ")
        .slice(0, RECENT_LINE_LENGTH),
    );
  const update = newest.find((entry) => entry.event === "runtime.updated");
  const from = update?.fields["previousBuild"];
  const delegations = new Map<string, number>();
  const unsent = new Map<string, number>();
  for (const entry of entries) {
    const reason = entry.fields["reason"];
    if (entry.time < since || typeof reason !== "string" || !v.is(KIND_SCHEMAS.code, reason))
      continue;
    if (entry.event === "passkey.request" && entry.fields["outcome"] === "delegate")
      delegations.set(reason, (delegations.get(reason) ?? 0) + 1);
    if (
      entry.event === "recipe.generate" &&
      entry.fields["outcome"] === "skipped" &&
      UNSENT_VERIFICATION_REASONS.has(reason)
    )
      unsent.set(reason, (unsent.get(reason) ?? 0) + 1);
  }
  const byCount = (counts: Map<string, number>) =>
    [...counts]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, RECENT_DELEGATION_REASONS)
      .map(([reason, count]) => ({ reason, count }));
  return {
    problems,
    ...(update && typeof from === "string" && v.is(KIND_SCHEMAS.revision, from)
      ? { updated: { time: update.time, from } }
      : {}),
    passkeyDelegations: byCount(delegations),
    unsentVerifications: byCount(unsent),
  };
}
