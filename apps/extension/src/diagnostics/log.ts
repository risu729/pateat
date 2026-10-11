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
/** `debug` and `info` entries kept at most; the oldest `debug` entries go first. */
export const LOG_ENTRY_LIMIT = 5_000;
/** `warn` and `error` entries have their own allowance, so routine entries cannot evict them. */
export const LOG_PROBLEM_LIMIT = 1_000;
export const PRUNE_EVERY_WRITES = 500;
/** Events caused by a web page, per tab and origin. */
export const PAGE_EVENTS_PER_MINUTE = 20;
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
  | "stack";

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
  "service.sync": { level: "info", fields: { outcome: "code" } },
  "login.attempt": {
    level: "info",
    fields: {
      origin: "origin",
      recipe: "recipe",
      state: "code",
      step: "count",
      steps: "count",
      outcome: "code",
    },
  },
  "login.refused": { level: "info", fields: { origin: "origin", reason: "code" } },
  "recipe.generate": { level: "info", fields: { origin: "origin", outcome: "code" } },
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
    },
  },
  "error.unhandled": {
    level: "error",
    fields: { source: "code", name: "name", message: "code", stack: "stack" },
  },
  "log.dropped": { level: "warn", fields: { origin: "origin", count: "count" } },
  "log.debug": { level: "info", fields: { until: "time" } },
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
  Exclude<FieldKind, "origin" | "rpId" | "connection" | "item">,
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
    { start: number; count: number; dropped: number; reported: number; origin: string }
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
    for (const [key, kind] of Object.entries(definition.fields)) {
      const raw = (fields as Record<string, FieldValue | undefined>)[key];
      if (raw === undefined) continue;
      // oxlint-disable-next-line no-await-in-loop -- fields are few; pseudonyms are cached keys
      const value = await recordValue(kind, raw);
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
      const pending = window.dropped - window.reported;
      if (pending > 0) {
        window.reported = window.dropped;
        void serial(() =>
          record("log.dropped", { origin: window.origin, count: pending }, "warn"),
        ).catch(() => undefined);
      }
      if (ended) windows.delete(key);
    }
  }

  /**
   * Counts a page-caused event against its tab and origin; false when over the limit.
   * The first drop in a window is logged at once, since a stopped worker loses the rest.
   */
  function admit(source: { tabId: number; origin: string }): boolean {
    flushDrops();
    const at = now();
    let key = `${source.tabId}\u0000${source.origin}`;
    // Pages that open many tabs or origins share one window once too many are open.
    if (!windows.has(key) && windows.size >= MAX_WINDOWS) key = OVERFLOW_WINDOW;
    let window = windows.get(key);
    if (!window) {
      window = {
        start: at,
        count: 0,
        dropped: 0,
        reported: 0,
        origin: key === OVERFLOW_WINDOW ? "" : source.origin,
      };
      windows.set(key, window);
    }
    if (window.count < PAGE_EVENTS_PER_MINUTE) {
      window.count += 1;
      return true;
    }
    window.dropped += 1;
    if (window.dropped === 1) flushDrops(true);
    return false;
  }

  /**
   * Records one event. Fields outside the event's allowlist are ignored; a field that
   * fails its kind's check is left out. `source` marks an event a web page caused.
   */
  function log<E extends LogEventName>(
    event: E,
    fields: LogFields<E>,
    options: { level?: LogLevel; source?: { tabId: number; origin: string } } = {},
  ): Promise<void> {
    const level = options.level ?? LOG_EVENTS[event].level;
    // Checked before queueing, so a stalled database cannot collect page events.
    if (level === "debug" && knownDebugUntil !== undefined && now() >= knownDebugUntil)
      return Promise.resolve();
    if (options.source && !admit(options.source)) return Promise.resolve();
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
        await record("log.debug", { until }, "info");
        return until;
      }),
  };
}

export type Logger = ReturnType<typeof createLogger>;

/**
 * The text that leaves the page on "Download logs". Unless `includeSites`, every origin
 * and RP ID becomes `site-N` and every recipe ID `recipe-N`, numbered within this export.
 */
export function formatLogExport(
  entries: readonly LogEntry[],
  context: { version: string; revision: string; exportedAt: number; includeSites: boolean },
): string {
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
  const lines = entries.map((entry) => {
    const kinds: Readonly<Record<string, FieldKind>> = LOG_EVENTS[entry.event].fields;
    const fields: Record<string, FieldValue> = {};
    for (const [key, value] of Object.entries(entry.fields)) {
      const kind = kinds[key];
      // Only allowlisted fields that still pass their stored-value check leave the page.
      if (!kind || (value !== TRUNCATED && !v.is(STORED_SCHEMAS[kind], value))) continue;
      if (context.includeSites || typeof value !== "string" || value === TRUNCATED)
        fields[key] = value;
      else if (kind === "origin") fields[key] = replace(sites, "site", value);
      else if (kind === "rpId") {
        // An RP ID shares its number with the origin of the same host.
        const origin = `https://${value}`;
        fields[key] = replace(sites, "site", sites.has(origin) ? origin : value);
      } else if (kind === "recipe") fields[key] = replace(recipes, "recipe", value);
      else fields[key] = value;
    }
    return JSON.stringify({
      time: new Date(entry.time).toISOString(),
      level: entry.level,
      event: entry.event,
      ...fields,
    });
  });
  const header = JSON.stringify({
    pateat: context.version,
    revision: context.revision,
    exportedAt: new Date(context.exportedAt).toISOString(),
    sites: context.includeSites ? "included" : "replaced",
    entries: entries.length,
  });
  return [header, ...lines].join("\n") + "\n";
}
