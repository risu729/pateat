// The local diagnostics log (ADR 0019). Only the service worker writes it, one IndexedDB
// transaction per entry, from decisions it already makes. Every event allowlists its
// fields by kind; identifiers become pseudonyms and unknown origins never appear in full.
import * as v from "valibot";
import {
  DIAGNOSTICS_DATABASE_NAME,
  ENTRIES_STORE,
  LEVEL_INDEX,
  META_STORE,
  TIME_INDEX,
  completion,
  openDiagnosticsDatabase,
  request,
} from "./database";
import type { Pseudonyms } from "./pseudonym";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
export const LOG_RETENTION_MS = 14 * 24 * HOUR_MS;
export const DEBUG_RETENTION_MS = 24 * HOUR_MS;
export const DEBUG_LOGGING_MS = 24 * HOUR_MS;
/**
 * `debug` and `info` entries kept at most; the oldest `debug` entries go first. About 14
 * days at an estimated 1,000 a day on a testing day (ADR 0019).
 */
export const LOG_ENTRY_LIMIT = 14_000;
/** `warn` and `error` entries have their own allowance, so routine entries cannot evict them. */
export const LOG_PROBLEM_LIMIT = 1_000;
export const PRUNE_EVERY_WRITES = 500;
/** Events other than `debug` caused by a web page, per tab and origin; a login writes 6 to 8. */
export const PAGE_EVENTS_PER_MINUTE = 30;
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
 * - `url`: a page URL's path, query and fragment, kept only when the entry's `origin` is
 *   the URL's own and is recorded in full (ADR 0019); cut at the field length.
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
  "vault.check": { level: "info", fields: { connection: "connection", outcome: "code" } },
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
    },
  },
  "settings.changed": { level: "info", fields: { source: "code", revision: "count" } },
  "login.attempt": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
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
      url: "url",
    },
  },
  "login.entry": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      revision: "count",
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
      settled: "flag",
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
      frame: "flag",
      url: "url",
    },
  },
  "login.start": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      route: "code",
      variant: "count",
      account: "code",
      candidates: "count",
      item: "item",
      fillOnly: "flag",
      list: "code",
      url: "url",
    },
  },
  "login.logout": {
    level: "info",
    fields: { origin: "origin", recipe: "recipe", watched: "flag", url: "url" },
  },
  "login.choice": { level: "info", fields: { origin: "origin", outcome: "code", url: "url" } },
  "login.exception": {
    level: "warn",
    fields: {
      origin: "origin",
      recipe: "recipe",
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
      // `accounts` for a list of accounts (ADR 0028), `entry` for a sign-in entry (ADR 0031).
      page: "code",
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
      mediation: "code",
      duringLogin: "flag",
      cause: "code",
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
  url: v.pipe(v.string(), v.startsWith("/"), v.maxLength(MAX_FIELD_LENGTH)),
};

const entrySchema = v.object({
  time: integer,
  level: v.picklist(LOG_LEVELS),
  event: v.picklist(Object.keys(LOG_EVENTS) as [LogEventName, ...LogEventName[]]),
  fields: v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
});
export type LogEntry = v.InferOutput<typeof entrySchema>;

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
  indexedDB?: IDBFactory;
  databaseName?: string;
  console?: Pick<Console, "debug" | "info" | "warn" | "error">;
  /** Smaller limits for tests. */
  limits?: { entries: number; problems: number; pruneEvery: number };
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
  const factory = deps.indexedDB ?? globalThis.indexedDB;
  const name = deps.databaseName ?? DIAGNOSTICS_DATABASE_NAME;
  const out = deps.console ?? console;
  const limits = deps.limits ?? {
    entries: LOG_ENTRY_LIMIT,
    problems: LOG_PROBLEM_LIMIT,
    pruneEvery: PRUNE_EVERY_WRITES,
  };
  let database: Promise<IDBDatabase> | undefined;
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

  function open(): Promise<IDBDatabase> {
    database ??= openDiagnosticsDatabase(factory, name).then((opened) => {
      // A closed connection, after a version change, is reopened on the next use.
      opened.addEventListener("close", () => (database = undefined));
      const onVersionChange = opened.onversionchange;
      opened.onversionchange = (event) => {
        database = undefined;
        onVersionChange?.call(opened, event);
      };
      return opened;
    });
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
    const opened = await open();
    const value = await request(() =>
      opened.transaction(META_STORE, "readonly").objectStore(META_STORE).get(key),
    );
    const parsed = v.safeParse(schema, value);
    return parsed.success ? parsed.output : undefined;
  }

  async function putMeta(key: string, value: unknown): Promise<void> {
    const opened = await open();
    const transaction = opened.transaction(META_STORE, "readwrite");
    const done = completion(transaction);
    transaction.objectStore(META_STORE).put(value, key);
    await done;
  }

  function debugDeadline(): Promise<number> {
    debugUntil ??= meta(DEBUG_KEY, integer)
      .then((value) => value ?? 0)
      .catch(() => 0)
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
    const opened = await open();
    const transaction = opened.transaction(ENTRIES_STORE, "readwrite");
    const done = completion(transaction);
    transaction.objectStore(ENTRIES_STORE).add(entry);
    await done;
    writes += 1;
    if (writes % limits.pruneEvery === 0) await prune();
  }

  async function record<E extends LogEventName>(
    event: E,
    fields: LogFields<E>,
    level: LogLevel,
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
    const entry: LogEntry = { time: now(), level, event, fields: recorded };
    out[level]("Pateat", event, recorded);
    await write(entry);
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
   * `debug` events have an allowance of their own, so they never crowd out the rest.
   * The first drop of each event in a window is logged at once, since a stopped worker
   * loses the rest. `perMinute` replaces the allowance of events other than `debug`.
   */
  function admit(
    source: { tabId: number; origin: string; perMinute?: number },
    debug: boolean,
    event: string,
  ): boolean {
    flushDrops();
    const at = now();
    const band = debug ? "debug" : "rest";
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
        limit: debug
          ? PAGE_DEBUG_EVENTS_PER_MINUTE
          : overflow
            ? PAGE_EVENTS_PER_MINUTE
            : (source.perMinute ?? PAGE_EVENTS_PER_MINUTE),
        dropped: new Map(),
        reported: new Map(),
        origin: overflow ? "" : source.origin,
        debug,
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
    if (options.source && !admit(options.source, level === "debug", event))
      return Promise.resolve();
    // A log failure never changes what the caller does.
    return serial(() => record(event, fields, level)).catch(() => undefined);
  }

  async function deleteOldest(
    store: IDBObjectStore,
    range: IDBKeyRange,
    index: string,
    limit: number,
    keep?: (entry: unknown) => boolean,
  ): Promise<number> {
    if (limit <= 0) return 0;
    let deleted = 0;
    await new Promise<void>((resolve, reject) => {
      const cursor = store.index(index).openCursor(range);
      cursor.onerror = () => reject(new Error("storage-failed"));
      cursor.onsuccess = () => {
        const current = cursor.result;
        if (!current || deleted >= limit) return resolve();
        if (!keep?.(current.value)) {
          current.delete();
          deleted += 1;
        }
        current.continue();
      };
    });
    return deleted;
  }

  const levelRange = (level: LogLevel, upper = Number.MAX_SAFE_INTEGER) =>
    IDBKeyRange.bound([level, 0], [level, upper]);

  /** Applies the retention rules: age first, then the per-allowance entry limits. */
  async function prune(): Promise<void> {
    flushDrops();
    const at = now();
    const opened = await open();
    const transaction = opened.transaction(ENTRIES_STORE, "readwrite");
    const done = completion(transaction);
    const store = transaction.objectStore(ENTRIES_STORE);
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
            [
              level,
              await request(() => store.index(LEVEL_INDEX).count(levelRange(level))),
            ] as const,
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
    await done;
  }

  async function entries(): Promise<LogEntry[]> {
    const opened = await open();
    const values = await request(() =>
      opened
        .transaction(ENTRIES_STORE, "readonly")
        .objectStore(ENTRIES_STORE)
        .index(TIME_INDEX)
        .getAll(),
    );
    return values.flatMap((value) => {
      const parsed = v.safeParse(entrySchema, value);
      return parsed.success ? [parsed.output] : [];
    });
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
        const opened = await open();
        const transaction = opened.transaction(ENTRIES_STORE, "readwrite");
        const done = completion(transaction);
        transaction.objectStore(ENTRIES_STORE).clear();
        await done;
        sites = undefined;
        windows.clear();
        await deps.pseudonym.rotate();
      }),
    /** Records `debug` entries for the next 24 hours. */
    enableDebug: () =>
      serial(async () => {
        const until = now() + DEBUG_LOGGING_MS;
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
 * A page URL's path, query and fragment, when `origin` is the URL's own as recorded in full;
 * a pseudonymized origin gets none (ADR 0019).
 */
function pagePath(raw: FieldValue, origin: FieldValue | undefined): string | undefined {
  if (typeof raw !== "string" || typeof origin !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // A `blob:` or similar URL reports its inner origin but no path of its own.
  if (url.origin !== origin || !url.pathname.startsWith("/")) return undefined;
  return `${url.pathname}${url.search}${url.hash}`.slice(0, MAX_FIELD_LENGTH);
}

/** Only allowlisted fields that still pass their stored-value check leave the page. */
function exportedFields(entry: LogEntry, substitute?: Substitute): Record<string, FieldValue> {
  const kinds: Readonly<Record<string, FieldKind>> = LOG_EVENTS[entry.event].fields;
  const fields: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(entry.fields)) {
    const kind = kinds[key];
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
      time: new Date(entry.time).toISOString(),
      level: entry.level,
      event: entry.event,
      ...exportedFields(entry, substitute),
    }),
  );
  const header = JSON.stringify({
    pateat: context.version,
    revision: context.revision,
    exportedAt: new Date(context.exportedAt).toISOString(),
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
};

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
        `${new Date(entry.time).toISOString().slice(0, 16)}Z`,
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
  for (const entry of entries) {
    const reason = entry.fields["reason"];
    if (
      entry.event === "passkey.request" &&
      entry.time >= since &&
      entry.fields["outcome"] === "delegate" &&
      typeof reason === "string" &&
      v.is(KIND_SCHEMAS.code, reason)
    )
      delegations.set(reason, (delegations.get(reason) ?? 0) + 1);
  }
  return {
    problems,
    ...(update && typeof from === "string" && v.is(KIND_SCHEMAS.revision, from)
      ? { updated: { time: update.time, from } }
      : {}),
    passkeyDelegations: [...delegations]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, RECENT_DELEGATION_REASONS)
      .map(([reason, count]) => ({ reason, count })),
  };
}
