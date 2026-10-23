// The local diagnostics log (ADR 0019). Only the service worker writes it, one IndexedDB
// transaction per entry, from decisions it already makes. Every event allowlists its
// fields by kind; identifiers become pseudonyms and unknown origins never appear in full.
import {
  PROBLEM_EVENT_FIELDS,
  PROBLEM_PAGE_FIELDS,
  problemInfoLine,
  REDACTED_PATH_SEGMENT,
  type ProblemFieldKind,
} from "@pateat/contracts";
import type { IDBPObjectStore } from "idb";
import { observedPath } from "../observation/path";
import { isoMinute, isoTime } from "../time";
import * as v from "valibot";
import {
  DIAGNOSTICS_DATABASE_NAME,
  ENTRIES_STORE,
  LEVEL_INDEX,
  META_STORE,
  TIME_INDEX,
  openDiagnosticsDatabase,
  type DiagnosticsDatabase,
  type DiagnosticsSchema,
} from "./database";
import type { Pseudonyms } from "./pseudonym";

type EntriesStore = IDBPObjectStore<
  DiagnosticsSchema,
  [typeof ENTRIES_STORE],
  typeof ENTRIES_STORE,
  "readwrite"
>;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const LOG_RETENTION_MS = 14 * 24 * HOUR_MS;
export const DEBUG_RETENTION_MS = 24 * HOUR_MS;
export const DEBUG_LOGGING_MS = 24 * HOUR_MS;
/**
 * Until Pateat is published, debug logging once turned on stays on until it is turned off
 * rather than for {@link DEBUG_LOGGING_MS}, so the detail of a login that goes wrong is
 * there (owner, 2026-10-18). It is turned off, or removed, before publishing.
 */
export const DEBUG_STAYS_ON = true;
/** The stored deadline of debug logging that stays on until it is turned off. */
export const DEBUG_UNTIL_TURNED_OFF = 8_640_000_000_000_000;
/**
 * `debug` and `info` entries kept at most; the oldest `debug` entries go first. About 14
 * days at an estimated 1,000 a day on a testing day (ADR 0019).
 */
export const LOG_ENTRY_LIMIT = 14_000;
/** `warn` and `error` entries have their own allowance, so routine entries cannot evict them. */
export const LOG_PROBLEM_LIMIT = 1_000;
export const PRUNE_EVERY_WRITES = 500;
/**
 * Events other than `debug` and a login attempt's state changes caused by a web page, per
 * tab and origin; a login writes 6 to 8.
 */
export const PAGE_EVENTS_PER_MINUTE = 30;
/**
 * A login attempt's state changes (`login.attempt` other than `debug`) per tab and origin,
 * counted on their own so a long login still logs how it ended; one attempt writes a few.
 */
export const PAGE_ATTEMPT_EVENTS_PER_MINUTE = 60;
/** `debug` events caused by a web page, per tab and origin, counted on their own. */
export const PAGE_DEBUG_EVENTS_PER_MINUTE = 20;
export const MAX_FIELD_LENGTH = 512;
export const TRUNCATED = "[truncated]";

/**
 * How a field is checked and recorded:
 * - `code`: a Pateat state or reason code.
 * - `name`: an `Error` class name.
 * - `count`, `time`: non-negative integers.
 * - `flag`: a boolean.
 * - `revision`: a build revision or version.
 * - `recipe`: a recipe ID from the service.
 * - `origin`, `rpId`: recorded in full only for sites the settings or recipes name.
 * - `connection`, `item`: always pseudonyms.
 * - `stack`: extension script positions such as `background.js:12:345`.
 * - `url`: a page URL's path with its query's and fragment's parameter names but no values,
 *   kept only when the entry's `origin` is the URL's own and is recorded in full
 *   (ADR 0019); cut at the field length.
 */
type FieldKind =
  | "code"
  | "name"
  | "count"
  | "time"
  | "flag"
  | "revision"
  | "recipe"
  | "origin"
  | "rpId"
  | "connection"
  | "item"
  | "stack"
  | "url";

type EventDefinition = { level: LogLevel; fields: Readonly<Record<string, FieldKind>> };

/**
 * Fields every event a page caused records besides its own: the Chrome tab ID, so two tabs
 * of one site can be told apart (ADR 0019, amended 2026-10-19). Chrome numbers tabs within
 * a browser session; the number says nothing about the page.
 */
const PAGE_FIELDS: Readonly<Record<string, FieldKind>> = { tab: "count" };

export const LOG_EVENTS = {
  "runtime.started": { level: "debug", fields: { build: "revision" } },
  "runtime.updated": {
    level: "info",
    fields: { previousBuild: "revision", build: "revision", version: "revision" },
  },
  "vault.state": {
    level: "info",
    fields: {
      connection: "connection",
      state: "code",
      previous: "code",
      providerSession: "code",
      synced: "flag",
    },
  },
  "vault.sync": {
    level: "info",
    fields: { connection: "connection", outcome: "code", check: "code" },
  },
  "vault.sign-in": { level: "info", fields: { step: "code", outcome: "code" } },
  "vault.check": { level: "info", fields: { connection: "connection", outcome: "code" } },
  // The vault timeout locked or logged out the vaults (ADR 0075).
  "vault.timeout": { level: "info", fields: { trigger: "code", action: "code", outcome: "code" } },
  "vault.refresh": {
    level: "info",
    fields: { connection: "connection", outcome: "code", cause: "code", status: "count" },
  },
  "service.sync": {
    level: "info",
    fields: {
      outcome: "code",
      scope: "code",
      added: "count",
      updated: "count",
      removed: "count",
      // The run's requests added up (ADR 0019, amended 2026-10-18).
      roundTripMs: "count",
      serverMs: "count",
      networkMs: "count",
    },
  },
  // A first login's result code sent to the service (ADR 0019, amended 2026-10-18).
  "service.outcome": {
    level: "info",
    fields: { recipe: "recipe", recipeRevision: "count", branch: "code", result: "code" },
  },
  // A login's result and times sent to the service (ADR 0055).
  "service.login": {
    level: "info",
    fields: { recipe: "recipe", recipeRevision: "count", branch: "code", result: "code" },
  },
  // A login that started on a recipe revision, sent so the recipe is kept (ADR 0058).
  "service.use": {
    level: "info",
    fields: { recipe: "recipe", recipeRevision: "count", result: "code" },
  },
  // Warning and error lines sent to the service (ADR 0066). Never `warn`, so a
  // failed send is not itself a line to send.
  "service.problems": { level: "info", fields: { lines: "count", result: "code" } },
  "settings.changed": { level: "info", fields: { source: "code", revision: "count" } },
  "login.attempt": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      variant: "count",
      state: "code",
      step: "count",
      steps: "count",
      operation: "code",
      effect: "code",
      handler: "count",
      outcome: "code",
      cause: "code",
      reason: "code",
      settled: "flag",
      unconfirmed: "flag",
      routeChange: "code",
      stop: "code",
      // How long a login that ended took (ADR 0019, amended 2026-10-18).
      totalMs: "count",
      serviceMs: "count",
      networkMs: "count",
      personMs: "count",
      pageMs: "count",
      otherMs: "count",
      url: "url",
    },
  },
  "login.entry": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      outcome: "code",
      reason: "code",
      detail: "code",
      url: "url",
    },
  },
  "login.handler": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      handler: "count",
      kind: "code",
      outcome: "code",
      steps: "count",
      url: "url",
    },
  },
  "login.state": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      decision: "code",
      s1: "flag",
      s2: "flag",
      s3: "flag",
      s4: "flag",
      s5: "flag",
      f1: "flag",
      f2: "flag",
      e1: "flag",
      e2: "flag",
      e3: "flag",
      reshown: "flag",
      reshownMiss: "code",
      alertMiss: "code",
      advanceBefore: "code",
      advanceAfter: "code",
      advanceWhy: "code",
      advancePath: "code",
      settled: "flag",
      url: "url",
    },
  },
  "login.move": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      reason: "code",
      frame: "flag",
      kept: "flag",
      url: "url",
    },
  },
  "login.refused": {
    level: "info",
    fields: {
      origin: "origin",
      reason: "code",
      detail: "code",
      candidates: "count",
      // For `not-started` with `confirm-unsupported`: the recipe generated as a
      // verification that starts on the page, and its kind (ADR 0035).
      recipe: "recipe",
      recipeRevision: "count",
      pageKind: "code",
      // Also for `confirm-unsupported`, for the evaluation of page kinds: whether an amount
      // shows in the form, ADR 0029's E1 and E2, and the tab's previous page (ADR 0035).
      amount: "flag",
      e1: "flag",
      e2: "flag",
      previousUrl: "url",
      frame: "flag",
      url: "url",
    },
  },
  // The tab left a page logged `confirm-unsupported`: whether the person submitted its
  // form, and for a page without E1 or E2 whether the next page shows E1 (ADR 0035).
  "login.confirm-left": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      pageKind: "code",
      personSubmitted: "flag",
      nextE1: "flag",
      url: "url",
    },
  },
  "login.start": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      variant: "count",
      account: "code",
      candidates: "count",
      item: "item",
      fillOnly: "flag",
      startStep: "count",
      list: "code",
      listUsername: "code",
      listEntries: "count",
      listMasked: "count",
      listSameDomain: "count",
      listFits: "count",
      listEntryMiss: "code",
      listBeside: "count",
      listNamed: "count",
      listOther: "code",
      listContinue: "code",
      url: "url",
    },
  },
  "login.logout": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      rejected: "flag",
      clicked: "flag",
      url: "url",
    },
  },
  // A tab that asked after a logout closed; other tabs that asked only because of it stop
  // asking (ADR 0021 D).
  "login.ask-ended": {
    level: "info",
    fields: { origin: "origin", ask: "code", cause: "code", elsewhere: "flag" },
  },
  "login.choice": { level: "info", fields: { origin: "origin", outcome: "code", url: "url" } },
  "login.popup": {
    level: "info",
    fields: {
      origin: "origin",
      choice: "code",
      candidates: "count",
      logout: "code",
      held: "flag",
      rejectedElsewhere: "flag",
      recordState: "code",
      recordOutcome: "code",
      pageReason: "code",
      url: "url",
    },
  },
  "login.exception": {
    level: "warn",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      state: "code",
      step: "count",
      name: "name",
      message: "code",
      stack: "stack",
      url: "url",
    },
  },
  "recipe.generate": {
    level: "info",
    fields: {
      origin: "origin",
      outcome: "code",
      reason: "code",
      check: "code",
      detail: "code",
      path: "code",
      recipe: "recipe",
      baseRevision: "count",
      takenOver: "flag",
      // Why a returned recipe was not taken over (ADR 0027, amended 2026-10-19).
      notTakenOver: "code",
      // `accounts` for a list of accounts (ADR 0028), `entry` for a sign-in entry (ADR 0031),
      // `other` for a form on a chooser's path sent as its `other` branch (ADR 0028).
      page: "code",
      // A returned route recipe's page kind, and the `signedIn` hint a recipe's first page
      // was sent with (ADR 0035).
      pageKind: "code",
      signedIn: "flag",
      // How long the request took (ADR 0019, amended 2026-10-18).
      roundTripMs: "count",
      serverMs: "count",
      networkMs: "count",
      tokenMs: "count",
      modelMs: "count",
      url: "url",
    },
  },
  "recipe.judge": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      verdict: "code",
      reason: "code",
      takenOver: "flag",
      watched: "flag",
      completed: "flag",
      disabledLeftOut: "flag",
      notCompleted: "code",
      moved: "flag",
      // `password` for the page of a login's stop before its item's missing password (ADR 0036).
      stop: "code",
      // How long the request took (ADR 0019, amended 2026-10-18).
      roundTripMs: "count",
      serverMs: "count",
      networkMs: "count",
      tokenMs: "count",
      modelMs: "count",
      url: "url",
    },
  },
  // A recipe the chosen item cannot run, revoked so its page is generated again (ADR 0058 A).
  "recipe.revoke": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      outcome: "code",
      reason: "code",
      detail: "code",
      // How long the request took (ADR 0019, amended 2026-10-18).
      roundTripMs: "count",
      serverMs: "count",
      networkMs: "count",
      url: "url",
    },
  },
  // A repeat login's signed-in page sample (ADR 0029): codes only, never the page.
  "recipe.sample": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      recipeRevision: "count",
      route: "code",
      outcome: "code",
      reason: "code",
      url: "url",
    },
  },
  "passkey.request": {
    level: "info",
    fields: {
      origin: "origin",
      rpId: "rpId",
      outcome: "code",
      reason: "code",
      allowCredentials: "count",
      stored: "count",
      accepted: "count",
      siteDefault: "count",
      siteDefaultAccepted: "count",
      siteDefaultItem: "code",
      complete: "flag",
      chooser: "code",
      signedBefore: "flag",
      logoutClicked: "flag",
      mediation: "code",
      uiMode: "code",
      duringLogin: "flag",
      answerFailed: "code",
      cause: "code",
      invalid: "code",
      invalidLength: "count",
    },
  },
  // A checked `navigator.credentials.create` request (ADR 0007): never a credential ID.
  "passkey.create": {
    level: "info",
    fields: {
      origin: "origin",
      rpId: "rpId",
      outcome: "code",
      reason: "code",
      mediation: "code",
      excludeCredentials: "count",
      listed: "flag",
      sinceSignIn: "count",
    },
  },
  "error.unhandled": {
    level: "error",
    fields: { source: "code", name: "name", message: "code", stack: "stack" },
  },
  "log.dropped": {
    level: "warn",
    fields: { origin: "origin", dropped: "code", count: "count" },
  },
  "log.debug": { level: "info", fields: { enabled: "flag", until: "time" } },
} as const satisfies Record<string, EventDefinition>;
export type LogEventName = keyof typeof LOG_EVENTS;
type FieldValue = string | number | boolean;
export type LogFields<E extends LogEventName> = {
  [K in keyof (typeof LOG_EVENTS)[E]["fields"]]?: FieldValue | undefined;
};

/**
 * Error messages kept in `error.unhandled`. Any other message may quote input, such as
 * a page's text in a parse error, so only these codes thrown by Pateat itself are kept.
 */
export const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  "immutable-configuration",
  "invalid-configuration",
  "invalid-request",
  "passkey-stale",
  "passkey-unavailable",
  "revision-conflict",
  "storage-corrupt",
  "storage-failed",
  "vault-unavailable",
]);

/** A parameter name kept in a page URL: a name a site gives a parameter, not a value. */
const NAME = String.raw`[A-Za-z_][\w.\-[\]]{0,39}`;
const PARAMETER_NAME = new RegExp(`^${NAME}$`, "u");
const NAMES = `(?:${NAME}=(?:&${NAME}=)*)?`;

/** The only shape a stored page URL has: a path, then parameter names or a route. */
const STORED_PATH = new RegExp(
  String.raw`^/[^?#]*(?:\?${NAMES})?(?:#(?:${NAMES}|!?/[^=?#]*(?:\?${NAMES})?))?$`,
  "u",
);

const integer = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(Number.MAX_SAFE_INTEGER));
const KIND_SCHEMAS: Record<
  Exclude<FieldKind, "origin" | "rpId" | "connection" | "item" | "url">,
  v.GenericSchema<unknown, FieldValue>
> = {
  code: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9.:-]{0,63}$/u)),
  name: v.pipe(v.string(), v.regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/u)),
  count: integer,
  time: integer,
  flag: v.boolean(),
  revision: v.pipe(v.string(), v.regex(/^[0-9A-Za-z._-]{1,64}$/u)),
  recipe: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_.:-]{1,120}$/u)),
  stack: v.pipe(v.string(), v.regex(/^[\w.-]+\.js:\d+:\d+(?: [\w.-]+\.js:\d+:\d+){0,4}$/u)),
};
const pseudonymSchema = (prefix: string, length: number) =>
  v.pipe(v.string(), v.regex(new RegExp(`^${prefix}:[0-9a-f]{${length}}$`, "u")));
const originValueSchema = v.union([
  v.pipe(
    v.string(),
    v.url(),
    v.check((value) => new URL(value).origin === value),
  ),
  pseudonymSchema("origin", 8),
]);
const rpIdValueSchema = v.union([
  v.pipe(v.string(), v.regex(/^[a-z0-9.-]{1,253}$/u)),
  pseudonymSchema("rp", 8),
]);
/** What a stored value of each kind may look like after recording. */
const STORED_SCHEMAS: Record<FieldKind, v.GenericSchema<unknown, FieldValue>> = {
  ...KIND_SCHEMAS,
  origin: originValueSchema,
  rpId: rpIdValueSchema,
  connection: pseudonymSchema("bitwarden", 6),
  item: pseudonymSchema("item", 8),
  // A URL an older build stored with its parameters' values is left out, unless the value
  // was a single token ending in `=` and so has this shape too.
  url: v.pipe(v.string(), v.startsWith("/"), v.maxLength(MAX_FIELD_LENGTH), v.regex(STORED_PATH)),
};

const entrySchema = v.object({
  time: integer,
  level: v.picklist(LOG_LEVELS),
  event: v.picklist(Object.keys(LOG_EVENTS) as [LogEventName, ...LogEventName[]]),
  fields: v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
  /** The build revision that wrote the entry; entries of older builds have none. */
  build: v.optional(v.pipe(v.string(), v.maxLength(64))),
});
export type LogEntry = v.InferOutput<typeof entrySchema>;
/** An entry with its key in the `entries` store. */
export type KeyedEntry = { key: number; entry: LogEntry };
/**
 * Problem entries read after a key, the last key the read looked at, and whether it
 * stopped at its scan limit with entries left to look at.
 */
export type ProblemsRead = { entries: KeyedEntry[]; scanned: number; more: boolean };

/** Sites the user configured; only these appear by name in the log. */
export type KnownSites = {
  origins: ReadonlySet<string>;
  hosts: readonly { hostname: string; includeSubdomains: boolean }[];
};

export type LoggerDependencies = {
  pseudonym: Pseudonyms;
  knownSites(): Promise<KnownSites>;
  build: { version: string; revision: string };
  now?: () => number;
  databaseName?: string;
  console?: Pick<Console, "debug" | "info" | "warn" | "error">;
  /** Smaller limits for tests. */
  limits?: { entries: number; problems: number; pruneEvery: number };
  /** {@link DEBUG_STAYS_ON} unless a test says otherwise. */
  debugStaysOn?: boolean;
  /** Told after each entry is stored that goes to the service (ADR 0066). */
  onProblem?: () => void;
};

export type LogSummary = {
  entries: number;
  bytes: number;
  /** `error` entries in the last 24 hours. */
  recentErrors: number;
  /** `warn` entries in the last 24 hours, such as a login that did not finish. */
  recentWarnings: number;
  debugUntil?: number;
};

const KNOWN_SITES_TTL_MS = MINUTE_MS;
const MAX_WINDOWS = 500;
const OVERFLOW_WINDOW = "overflow";
const BUILD_KEY = "previous-build";
const DEBUG_KEY = "debug-until";
const PROBLEM_CURSOR_KEY = "problem-cursor";
const LOG_ID_KEY = "log-id";
const logIdSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{32}$/u));
/** Entries one read of problem entries looks at most, so a long log never holds the queue. */
const PROBLEM_SCAN_LIMIT = 2_000;

function hostMatches(hostname: string, sites: KnownSites): boolean {
  return sites.hosts.some(
    (site) =>
      site.hostname === hostname ||
      (site.includeSubdomains && hostname.endsWith(`.${site.hostname}`)),
  );
}

/** Script positions inside this extension, without its ID; anything else is left out. */
export function stackPositions(stack: unknown): string | undefined {
  if (typeof stack !== "string") return undefined;
  // Only V8 frame lines; the first line carries the message, which may quote input.
  const positions = stack
    .split("\n")
    .filter((line) => /^\s+at /u.test(line))
    .flatMap((line) => {
      const match =
        /chrome-extension:\/\/[a-p]{32}\/(?:[\w-]+\/)*([\w.-]+\.js):(\d+):(\d+)\)?$/u.exec(line);
      return match ? [`${match[1]}:${match[2]}:${match[3]}`] : [];
    })
    .slice(0, 5);
  return positions.length ? positions.join(" ") : undefined;
}

export function createLogger(deps: LoggerDependencies) {
  const now = deps.now ?? Date.now;
  const name = deps.databaseName ?? DIAGNOSTICS_DATABASE_NAME;
  const out = deps.console ?? console;
  const debugStaysOn = deps.debugStaysOn ?? DEBUG_STAYS_ON;
  const limits = deps.limits ?? {
    entries: LOG_ENTRY_LIMIT,
    problems: LOG_PROBLEM_LIMIT,
    pruneEvery: PRUNE_EVERY_WRITES,
  };
  let database: Promise<DiagnosticsDatabase> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  let writes = 0;
  let debugUntil: Promise<number> | undefined;
  let sites: { at: number; value: Promise<KnownSites> } | undefined;
  const windows = new Map<
    string,
    {
      start: number;
      count: number;
      limit: number;
      /** Events dropped and already logged as dropped, per event name. */
      dropped: Map<string, number>;
      reported: Map<string, number>;
      origin: string;
      debug: boolean;
    }
  >();
  // The debug deadline once read, so a debug event can be skipped without queueing.
  let knownDebugUntil: number | undefined;

  function open(): Promise<DiagnosticsDatabase> {
    // A closed connection, after a version change, is reopened on the next use.
    database ??= openDiagnosticsDatabase(name, () => (database = undefined));
    database.catch(() => (database = undefined));
    return database;
  }

  /** Runs storage work in call order; a failure never stops later work. */
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  }

  async function meta<T>(key: string, schema: v.GenericSchema<unknown, T>): Promise<T | undefined> {
    // The read waits for its transaction too, so an abort never goes unhandled.
    const transaction = (await open()).transaction(META_STORE);
    const [value] = await Promise.all([transaction.store.get(key), transaction.done]);
    const parsed = v.safeParse(schema, value);
    return parsed.success ? parsed.output : undefined;
  }

  async function putMeta(key: string, value: unknown): Promise<void> {
    // The shortcut resolves when the transaction commits.
    await (await open()).put(META_STORE, value, key);
  }

  /** Stores {@link DEBUG_UNTIL_TURNED_OFF} in place of `from` and returns what is stored. */
  async function keepDebugOn(from: number): Promise<number> {
    // One read-write transaction, so a turn-off written meanwhile is never overwritten.
    const transaction = (await open()).transaction(META_STORE, "readwrite");
    const stored = await transaction.store.get(DEBUG_KEY);
    if (stored === from) await transaction.store.put(DEBUG_UNTIL_TURNED_OFF, DEBUG_KEY);
    await transaction.done;
    return stored === from ? DEBUG_UNTIL_TURNED_OFF : v.is(integer, stored) ? stored : 0;
  }

  function debugDeadline(): Promise<number> {
    debugUntil ??= meta(DEBUG_KEY, integer)
      .then((value) => value ?? 0)
      .catch(() => 0)
      .then(async (value) => {
        if (!debugStaysOn) return value === DEBUG_UNTIL_TURNED_OFF ? 0 : value;
        if (value <= now() || value === DEBUG_UNTIL_TURNED_OFF) return value;
        // A 24-hour window still open now stays on until it is turned off, unless it was
        // turned off or on meanwhile.
        return keepDebugOn(value).catch(() => DEBUG_UNTIL_TURNED_OFF);
      })
      .then((value) => (knownDebugUntil = value));
    return debugUntil;
  }

  function knownSites(): Promise<KnownSites> {
    const at = now();
    if (!sites || at - sites.at > KNOWN_SITES_TTL_MS) {
      const value = deps.knownSites().catch((): KnownSites => ({ origins: new Set(), hosts: [] }));
      sites = { at, value };
    }
    return sites.value;
  }

  async function recordValue(kind: FieldKind, raw: FieldValue): Promise<FieldValue | undefined> {
    if (typeof raw === "string" && raw.length > MAX_FIELD_LENGTH) return TRUNCATED;
    switch (kind) {
      case "origin": {
        if (typeof raw !== "string" || !v.is(originValueSchema, raw)) return undefined;
        if (raw.startsWith("origin:")) return raw;
        const known = await knownSites();
        return known.origins.has(raw) || hostMatches(new URL(raw).hostname, known)
          ? raw
          : `origin:${await deps.pseudonym("origin", raw, 8)}`;
      }
      case "rpId": {
        if (typeof raw !== "string" || !v.is(rpIdValueSchema, raw) || raw.startsWith("rp:"))
          return undefined;
        const known = await knownSites();
        const named =
          hostMatches(raw, known) ||
          [...known.origins].some((origin) => {
            const { hostname } = new URL(origin);
            return hostname === raw || hostname.endsWith(`.${raw}`);
          });
        return named ? raw : `rp:${await deps.pseudonym("rp", raw, 8)}`;
      }
      case "connection":
        return typeof raw === "string"
          ? `bitwarden:${await deps.pseudonym("connection", raw, 6)}`
          : undefined;
      case "item":
        return typeof raw === "string" ? `item:${await deps.pseudonym("item", raw, 8)}` : undefined;
      case "url":
        // Recorded after the entry's origin, by `pagePath`.
        return undefined;
      default: {
        const parsed = v.safeParse(KIND_SCHEMAS[kind], raw);
        return parsed.success ? parsed.output : undefined;
      }
    }
  }

  async function write(entry: LogEntry): Promise<void> {
    await (await open()).add(ENTRIES_STORE, entry);
    writes += 1;
    if (writes % limits.pruneEvery === 0) await prune();
  }

  async function record<E extends LogEventName>(
    event: E,
    fields: LogFields<E>,
    level: LogLevel,
    tab?: number,
  ): Promise<void> {
    if (level === "debug" && now() >= (await debugDeadline())) return;
    const definition: EventDefinition = LOG_EVENTS[event];
    const recorded: Record<string, FieldValue> = {};
    const raws = fields as Record<string, FieldValue | undefined>;
    for (const [key, kind] of Object.entries(definition.fields)) {
      const raw = raws[key];
      if (raw === undefined) continue;
      const value =
        kind === "url"
          ? // Every event lists `origin` before `url`, so the origin is already recorded.
            pagePath(raw, recorded["origin"])
          : // oxlint-disable-next-line no-await-in-loop -- fields are few; pseudonyms are cached keys
            await recordValue(kind, raw);
      if (value !== undefined) recorded[key] = value;
    }
    if (tab !== undefined) recorded["tab"] = tab;
    const entry: LogEntry = {
      time: now(),
      level,
      event,
      fields: recorded,
      build: deps.build.revision,
    };
    out[level]("Pateat", event, recorded);
    await write(entry);
    if (sentToService(entry))
      try {
        deps.onProblem?.();
      } catch {
        // Whoever listens never changes the log.
      }
  }

  /** Logs drops not yet counted: for windows that have ended, or for all with `all`. */
  function flushDrops(all = false): void {
    const at = now();
    for (const [key, window] of windows) {
      const ended = at - window.start >= MINUTE_MS;
      if (!ended && !all) continue;
      for (const [event, dropped] of window.dropped) {
        const pending = dropped - (window.reported.get(event) ?? 0);
        if (pending <= 0) continue;
        window.reported.set(event, dropped);
        // Losing debug detail is itself debug detail; losing more is a problem.
        void serial(() =>
          record(
            "log.dropped",
            { origin: window.origin, dropped: event, count: pending },
            window.debug ? "debug" : "warn",
          ),
        ).catch(() => undefined);
      }
      if (ended) windows.delete(key);
    }
  }

  /**
   * Counts a page-caused event against its tab and origin; false when over the limit.
   * `debug` events and a login attempt's state changes have allowances of their own, so
   * they never crowd out the rest or are crowded out by it. The first drop of each event in
   * a window is logged at once, since a stopped worker loses the rest. `perMinute` replaces
   * the allowance of the other events.
   */
  function admit(
    source: { tabId: number; origin: string; perMinute?: number },
    band: "debug" | "attempt" | "rest",
    event: string,
  ): boolean {
    flushDrops();
    const at = now();
    let key = `${source.tabId}\u0000${source.origin}\u0000${band}`;
    // Pages that open many tabs or origins share one window once too many are open.
    const overflow = !windows.has(key) && windows.size >= MAX_WINDOWS;
    if (overflow) key = `${OVERFLOW_WINDOW}\u0000${band}`;
    let window = windows.get(key);
    if (!window) {
      window = {
        start: at,
        count: 0,
        // The shared overflow window keeps the page allowance, whoever opened it.
        limit:
          band === "debug"
            ? PAGE_DEBUG_EVENTS_PER_MINUTE
            : band === "attempt"
              ? PAGE_ATTEMPT_EVENTS_PER_MINUTE
              : overflow
                ? PAGE_EVENTS_PER_MINUTE
                : (source.perMinute ?? PAGE_EVENTS_PER_MINUTE),
        dropped: new Map(),
        reported: new Map(),
        origin: overflow ? "" : source.origin,
        debug: band === "debug",
      };
      windows.set(key, window);
    }
    if (window.count < window.limit) {
      window.count += 1;
      return true;
    }
    const dropped = (window.dropped.get(event) ?? 0) + 1;
    window.dropped.set(event, dropped);
    if (dropped === 1) flushDrops(true);
    return false;
  }

  /**
   * Records one event. Fields outside the event's allowlist are ignored; a field that
   * fails its kind's check is left out. `source` marks an event a web page caused.
   */
  function log<E extends LogEventName>(
    event: E,
    fields: LogFields<E>,
    options: {
      level?: LogLevel;
      source?: { tabId: number; origin: string; perMinute?: number };
    } = {},
  ): Promise<void> {
    const level = options.level ?? LOG_EVENTS[event].level;
    // Checked before queueing, so a stalled database cannot collect page events.
    if (level === "debug" && knownDebugUntil !== undefined && now() >= knownDebugUntil)
      return Promise.resolve();
    // A login attempt's state changes are what its log is read for, so other page events
    // never crowd them out; its step-by-step detail is debug like any other.
    const band = level === "debug" ? "debug" : event === "login.attempt" ? "attempt" : "rest";
    if (options.source && !admit(options.source, band, event)) return Promise.resolve();
    // A log failure never changes what the caller does.
    // Errors outside a page come with tab -1, which names no tab.
    const tab =
      options.source && v.is(integer, options.source.tabId) ? options.source.tabId : undefined;
    return serial(() => record(event, fields, level, tab)).catch(() => undefined);
  }

  async function deleteOldest(
    store: EntriesStore,
    range: IDBKeyRange,
    index: typeof TIME_INDEX | typeof LEVEL_INDEX,
    limit: number,
    keep?: (entry: unknown) => boolean,
  ): Promise<number> {
    if (limit <= 0) return 0;
    let deleted = 0;
    let cursor = await store.index(index).openCursor(range);
    while (cursor && deleted < limit) {
      if (!keep?.(cursor.value)) {
        // oxlint-disable-next-line no-await-in-loop -- one cursor, one entry at a time
        await cursor.delete();
        deleted += 1;
      }
      // oxlint-disable-next-line no-await-in-loop -- one cursor, one entry at a time
      cursor = await cursor.continue();
    }
    return deleted;
  }

  const levelRange = (level: LogLevel, upper = Number.MAX_SAFE_INTEGER) =>
    IDBKeyRange.bound([level, 0], [level, upper]);

  /** Applies the retention rules: age first, then the per-allowance entry limits. */
  async function prune(): Promise<void> {
    flushDrops();
    const at = now();
    const transaction = (await open()).transaction(ENTRIES_STORE, "readwrite");
    await Promise.all([pruneEntries(transaction.store, at), transaction.done]);
  }

  async function pruneEntries(store: EntriesStore, at: number): Promise<void> {
    await deleteOldest(
      store,
      IDBKeyRange.upperBound(at - LOG_RETENTION_MS, true),
      TIME_INDEX,
      Number.MAX_SAFE_INTEGER,
    );
    await deleteOldest(
      store,
      levelRange("debug", at - DEBUG_RETENTION_MS - 1),
      LEVEL_INDEX,
      Number.MAX_SAFE_INTEGER,
    );
    const counts = Object.fromEntries(
      await Promise.all(
        LOG_LEVELS.map(
          async (level) =>
            [level, await store.index(LEVEL_INDEX).count(levelRange(level))] as const,
        ),
      ),
    ) as Record<LogLevel, number>;
    let excess = counts.debug + counts.info - limits.entries;
    excess -= await deleteOldest(store, levelRange("debug"), LEVEL_INDEX, excess);
    await deleteOldest(store, levelRange("info"), LEVEL_INDEX, excess);
    await deleteOldest(
      store,
      IDBKeyRange.lowerBound(0),
      TIME_INDEX,
      counts.warn + counts.error - limits.problems,
      (entry) => !v.is(v.object({ level: v.picklist(["warn", "error"]) }), entry),
    );
  }

  async function entries(): Promise<LogEntry[]> {
    const transaction = (await open()).transaction(ENTRIES_STORE);
    const [values] = await Promise.all([
      transaction.store.index(TIME_INDEX).getAll(),
      transaction.done,
    ]);
    return values.flatMap((value) => {
      const parsed = v.safeParse(entrySchema, value);
      return parsed.success ? [parsed.output] : [];
    });
  }

  /**
   * Up to `limit` entries that go to the service ({@link sentToService}) stored after the
   * key `after`, oldest first,
   * with their keys, looking at no more than {@link PROBLEM_SCAN_LIMIT} entries; `scanned`
   * is the last key looked at, or `after` when there was none, so the next read starts
   * past the `debug` and `info` entries already passed over. Keys count up from the
   * database's creation, also across a clear.
   */
  async function problemsAfter(after: number, limit: number): Promise<ProblemsRead> {
    const transaction = (await open()).transaction(ENTRIES_STORE);
    const found: KeyedEntry[] = [];
    let scanned = after;
    let cursor = await transaction.store.openCursor(IDBKeyRange.lowerBound(after, true));
    for (let looked = 0; cursor && found.length < limit && looked < PROBLEM_SCAN_LIMIT;) {
      looked += 1;
      scanned = cursor.key;
      const parsed = v.safeParse(entrySchema, cursor.value);
      if (parsed.success && sentToService(parsed.output))
        found.push({ key: cursor.key, entry: parsed.output });
      // oxlint-disable-next-line no-await-in-loop -- one cursor, one entry at a time
      cursor = found.length < limit ? await cursor.continue() : null;
    }
    await transaction.done;
    // The cursor is left on an entry only when the read stopped at its scan limit.
    return { entries: found, scanned, more: cursor !== null };
  }

  /** This log's random ID, made once per database, so its keys are told from a new log's. */
  async function logId(): Promise<string> {
    const stored = await meta(LOG_ID_KEY, logIdSchema);
    if (stored) return stored;
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const created = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    await putMeta(LOG_ID_KEY, created);
    return created;
  }

  /** The newest entry's key, or 0 when there is none. */
  async function lastKey(): Promise<number> {
    const transaction = (await open()).transaction(ENTRIES_STORE);
    const [cursor] = await Promise.all([
      transaction.store.openCursor(null, "prev"),
      transaction.done,
    ]);
    return cursor?.key ?? 0;
  }

  /** Records the worker start, and an update when the build revision changed. */
  async function started(): Promise<void> {
    await serial(async () => {
      const revision = deps.build.revision;
      const previous = await meta(BUILD_KEY, KIND_SCHEMAS.revision).catch(() => undefined);
      if (previous !== undefined && previous !== revision)
        await record(
          "runtime.updated",
          { previousBuild: previous, build: revision, version: deps.build.version },
          "info",
        );
      if (previous !== revision) await putMeta(BUILD_KEY, revision);
      await record("runtime.started", { build: revision }, "debug");
      await prune();
    }).catch(() => undefined);
  }

  return {
    log,
    started,
    prune: () => serial(prune),
    entries: () => serial(entries),
    /** Problem entries to send to the service (ADR 0066). */
    problemsAfter: (after: number, limit: number) => serial(() => problemsAfter(after, limit)),
    lastKey: () => serial(lastKey),
    /** The log's ID, sent with its problem entries so a recreated log's keys are new. */
    logId: () => serial(logId),
    /** Where sending problem entries got to; kept in `meta`, so a log clear keeps it. */
    problemCursor: () => serial(() => meta(PROBLEM_CURSOR_KEY, v.unknown())),
    setProblemCursor: (cursor: unknown) => serial(() => putMeta(PROBLEM_CURSOR_KEY, cursor)),
    /** The log's lines for a bug report. */
    async recent(): Promise<RecentLog> {
      return recentLog(await serial(entries), now());
    },
    async summary(): Promise<LogSummary> {
      const [all, until] = await Promise.all([serial(entries), debugDeadline()]);
      const since = now() - 24 * HOUR_MS;
      return {
        entries: all.length,
        bytes: all.reduce(
          (total, entry) => total + new TextEncoder().encode(JSON.stringify(entry)).byteLength,
          0,
        ),
        recentErrors: all.filter((entry) => entry.level === "error" && entry.time >= since).length,
        recentWarnings: all.filter((entry) => entry.level === "warn" && entry.time >= since).length,
        ...(until > now() ? { debugUntil: until } : {}),
      };
    },
    /** Deletes every entry and starts a new pseudonym key. */
    clear: () =>
      serial(async () => {
        await (await open()).clear(ENTRIES_STORE);
        sites = undefined;
        windows.clear();
        await deps.pseudonym.rotate();
      }),
    /** Records `debug` entries for the next 24 hours, or until turned off while they stay on. */
    enableDebug: () =>
      serial(async () => {
        const until = debugStaysOn ? DEBUG_UNTIL_TURNED_OFF : now() + DEBUG_LOGGING_MS;
        await putMeta(DEBUG_KEY, until);
        debugUntil = Promise.resolve(until);
        knownDebugUntil = until;
        await record("log.debug", { enabled: true, until }, "info");
        return until;
      }),
    /** Stops recording `debug` entries before the 24 hours end; those written are kept. */
    disableDebug: () =>
      serial(async () => {
        await putMeta(DEBUG_KEY, 0);
        debugUntil = Promise.resolve(0);
        knownDebugUntil = 0;
        await record("log.debug", { enabled: false }, "info");
      }),
  };
}

export type Logger = ReturnType<typeof createLogger>;

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
function pagePath(raw: FieldValue, origin: FieldValue | undefined): string | undefined {
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
 * `info` entry that says why Pateat did nothing on a page (`PROBLEM_INFO_LINES`).
 */
export function sentToService(entry: Pick<LogEntry, "level" | "event" | "fields">): boolean {
  if (entry.level === "warn" || entry.level === "error") return true;
  return entry.level === "info" && problemInfoLine(entry.event, entry.fields);
}

/**
 * Blocked outcomes of a login that filled and clicked nothing at its step (`login.attempt`):
 * a wrong account, a value that does not fit, a fill the page refused, an account its list
 * does not show. Every other outcome may follow a submit, such as a challenge, a watch that
 * ended, a cancel or a move to another origin.
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
  "logged-out",
  "logout-clicked",
  "press-limit",
  "settings-unavailable",
  "site-excluded",
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
    // A login's start, and a recipe revoked for a new login on its first page (ADR 0058 A).
    case "login.start":
    case "recipe.revoke":
      return true;
    // A login that stopped at a step it neither filled nor clicked, outside a handler (as a
    // code page after the password) and before any result was watched or settled.
    case "login.attempt":
      return (
        fields["state"] === "blocked" &&
        PRE_SUBMIT_BLOCKS.has(fields["outcome"]) &&
        fields["handler"] === undefined &&
        fields["settled"] === undefined
      );
    // An exception before the login's first step ran.
    case "login.exception":
      return (
        fields["state"] === "detected" || (fields["state"] === "ready" && fields["step"] === 0)
      );
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
  const kinds: Readonly<Record<string, ProblemFieldKind>> = {
    ...PROBLEM_PAGE_FIELDS,
    ...(Object.hasOwn(PROBLEM_EVENT_FIELDS, entry.event) ? PROBLEM_EVENT_FIELDS[entry.event] : {}),
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
