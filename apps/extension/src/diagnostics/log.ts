// The local diagnostics log (ADR 0019). Only the service worker writes it, one IndexedDB
// transaction per entry, from decisions it already makes. Every event allowlists its
// fields by kind; identifiers become pseudonyms and unknown origins never appear in full.
import type { IDBPObjectStore } from "idb";
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
import {
  DEBUG_LOGGING_MS,
  DEBUG_RETENTION_MS,
  DEBUG_STAYS_ON,
  DEBUG_UNTIL_TURNED_OFF,
  HOUR_MS,
  LOG_ENTRY_LIMIT,
  LOG_EVENTS,
  LOG_LEVELS,
  LOG_PROBLEM_LIMIT,
  LOG_RETENTION_MS,
  MAX_FIELD_LENGTH,
  MINUTE_MS,
  PAGE_ATTEMPT_EVENTS_PER_MINUTE,
  PAGE_DEBUG_EVENTS_PER_MINUTE,
  PAGE_EVENTS_PER_MINUTE,
  PRUNE_EVERY_WRITES,
  TRUNCATED,
  type EventDefinition,
  type FieldKind,
  type FieldValue,
  type LogEventName,
  type LogFields,
  type LogLevel,
} from "./log-events";
import {
  KIND_SCHEMAS,
  entrySchema,
  integer,
  originValueSchema,
  rpIdValueSchema,
  type LogEntry,
} from "./log-fields";
import { pagePath, recentLog, sentToService, type RecentLog } from "./log-format";

export {
  LOG_LEVELS,
  type LogLevel,
  LOG_RETENTION_MS,
  DEBUG_RETENTION_MS,
  DEBUG_LOGGING_MS,
  DEBUG_STAYS_ON,
  DEBUG_UNTIL_TURNED_OFF,
  LOG_ENTRY_LIMIT,
  LOG_PROBLEM_LIMIT,
  PRUNE_EVERY_WRITES,
  PAGE_EVENTS_PER_MINUTE,
  PAGE_ATTEMPT_EVENTS_PER_MINUTE,
  PAGE_DEBUG_EVENTS_PER_MINUTE,
  MAX_FIELD_LENGTH,
  TRUNCATED,
  LOG_EVENTS,
  type LogEventName,
  type LogFields,
  KNOWN_ERROR_CODES,
} from "./log-events";
export { type LogEntry } from "./log-fields";
export {
  type ProblemLine,
  sentToService,
  problemLine,
  formatLogExport,
  RECENT_PROBLEMS,
  RECENT_WINDOW_MS,
  RECENT_LINE_LENGTH,
  RECENT_DELEGATION_REASONS,
  type RecentLog,
  recentLog,
} from "./log-format";

type EntriesStore = IDBPObjectStore<
  DiagnosticsSchema,
  [typeof ENTRIES_STORE],
  typeof ENTRIES_STORE,
  "readwrite"
>;

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
      /** The tab whose events were dropped; none for the window tabs share. */
      tab: number | undefined;
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
            window.tab,
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
        tab: overflow || !v.is(integer, source.tabId) ? undefined : source.tabId,
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
