import { problemEntrySchema, type ProblemEntry } from "@pateat/contracts";
import * as v from "valibot";
import { problemLine, type KeyedEntry, type ProblemsRead } from "../diagnostics/log";
import type { ServiceConnection } from "./runtime";
import type { OutcomeResult, ServiceTransport } from "./transport";

// The local log's `warn` and `error` lines go to the paired service (ADR 0066),
// so Claude can find failures without the owner reporting each one. Only what
// `problemLine` lets leave is sent: codes, counts, flags, recipe IDs, origins of sites set
// up, redacted paths, error names and script positions. Sending is best-effort and never
// touches a login or the log itself.

/** Lines in one request. */
export const MAX_PROBLEM_BATCH = 50;
/** The JSON body of one request stays under this, well within the service's 64 KiB. */
export const MAX_PROBLEM_BATCH_BYTES = 32 * 1024;
/** Requests in one run; a longer backlog waits for the next problem, worker start or sync. */
export const MAX_PROBLEM_REQUESTS = 4;
/** A run starts this long after the problem that asked for it, so a burst goes in one request. */
export const PROBLEM_DELAY_MS = 5_000;
/** The first wait after a failed request; each failure in a row doubles it. */
export const PROBLEM_RETRY_MS = 60_000;
/** The longest wait after failures. */
export const PROBLEM_RETRY_MAX_MS = 60 * 60_000;

/** An identical line within this time of the last one sent is not sent again. */
export const PROBLEM_REPEAT_MS = 60 * 60_000;

/** One request that left the device, for the local log (ADR 0019): a count and a code. */
export type ProblemsSent = {
  lines: number;
  /** `kept`, `refused`, `rejected`, or `failed:<code>`. */
  result: string;
};

/** The log reads and the cursor `createLogger` offers. */
export interface ProblemLog {
  problemsAfter(after: number, limit: number): Promise<ProblemsRead>;
  lastKey(): Promise<number>;
  problemCursor(): Promise<unknown>;
  setProblemCursor(cursor: Cursor): Promise<void>;
}

const count = v.pipe(v.number(), v.integer(), v.minValue(0));
/**
 * Where sending got to for a service and device, kept in the log's `meta` store so a
 * worker restart keeps it: the last entry key sent or passed over, the failures in a row
 * and when the next run may send, and the last line sent, to leave out a repeat of it.
 */
const cursorSchema = v.strictObject({
  service: v.pipe(v.string(), v.maxLength(2048)),
  deviceId: v.pipe(v.string(), v.maxLength(200)),
  after: count,
  failures: v.optional(count, 0),
  retryAt: v.optional(count, 0),
  last: v.optional(
    v.strictObject({ line: v.pipe(v.string(), v.maxLength(64 * 1024)), time: count }),
  ),
});
type Cursor = v.InferOutput<typeof cursorSchema>;

/** A line as the contract takes it, or nothing when it does not pass. */
function problemEntry({ key, entry }: KeyedEntry): ProblemEntry | undefined {
  const line = problemLine(entry);
  if (!line) return undefined;
  const parsed = v.safeParse(problemEntrySchema, { seq: key, ...line });
  return parsed.success ? parsed.output : undefined;
}

/** What makes two lines the same: all but their key and time. */
const sameness = (entry: ProblemEntry) => JSON.stringify([entry.level, entry.event, entry.fields]);

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/**
 * Sends the local log's `warn` and `error` lines to the paired service, oldest first, each
 * once (ADR 0066). A pairing starts after the newest entry, so no backlog from
 * before it is sent. A line the contract refuses is skipped, and so is one identical to the
 * last line sent less than {@link PROBLEM_REPEAT_MS} before it, as a vault state a new
 * worker logs again. A failed request keeps the lines for a later run and holds off runs, 1
 * minute after the first failure, doubling up to an hour, or longer when the service asks
 * by `Retry-After`; this survives a worker restart. A credential the service rejected
 * sends nothing. Nothing here throws.
 */
export function createProblemReports(options: {
  service: { connection(): Promise<ServiceConnection | undefined> };
  transport: Pick<ServiceTransport, "reportProblems">;
  log: ProblemLog;
  /** The extension's build, `PATEAT_BUILD_REVISION`. */
  build: string;
  /** Told of each request sent, for the local log; never changes the sending. */
  report?: (sent: ProblemsSent) => void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => void;
}) {
  const { service, transport, log } = options;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((run, ms) => void setTimeout(run, ms));
  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = (work: () => Promise<unknown>) => {
    const next = queue.then(work).catch(() => undefined);
    queue = next;
    return next.then(() => undefined);
  };
  let scheduled = false;

  const tell = (sent: ProblemsSent) => {
    try {
      options.report?.(sent);
    } catch {
      // The log never changes the sending.
    }
  };

  /** A cursor for a new pairing: after the newest entry, with nothing held off. */
  async function start(connection: { origin: string; deviceId: string }): Promise<Cursor> {
    const cursor: Cursor = {
      service: connection.origin,
      deviceId: connection.deviceId,
      after: await log.lastKey(),
      failures: 0,
      retryAt: 0,
    };
    await log.setProblemCursor(cursor);
    return cursor;
  }

  /** Where this service and device got to; one not seen yet starts as a new pairing. */
  async function cursorFor(connection: ServiceConnection): Promise<Cursor> {
    const parsed = v.safeParse(cursorSchema, await log.problemCursor());
    return parsed.success &&
      parsed.output.service === connection.origin &&
      parsed.output.deviceId === connection.deviceId
      ? parsed.output
      : start(connection);
  }

  async function send(): Promise<void> {
    const connection = await service.connection().catch(() => undefined);
    if (!connection || connection.rejected) return;
    let cursor = await cursorFor(connection);
    if (now() < cursor.retryAt) return;
    for (let request = 0; request < MAX_PROBLEM_REQUESTS; request += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time, each after the last
      const { entries: found, scanned } = await log.problemsAfter(cursor.after, MAX_PROBLEM_BATCH);
      const entries: ProblemEntry[] = [];
      let last = cursor.after;
      let lastSent = cursor.last;
      let cut = false;
      for (const keyed of found) {
        const entry = problemEntry(keyed);
        // A line too long to go with others waits for the next request; one too long on its
        // own is skipped.
        if (entry && bytes([...entries, entry]) > MAX_PROBLEM_BATCH_BYTES && entries.length > 0) {
          cut = true;
          break;
        }
        last = keyed.key;
        if (!entry || bytes([entry]) > MAX_PROBLEM_BATCH_BYTES) continue;
        const line = sameness(entry);
        if (lastSent?.line === line && entry.time - lastSent.time < PROBLEM_REPEAT_MS) continue;
        entries.push(entry);
        lastSent = { line, time: entry.time };
      }
      // Every entry read went: the next read starts past the ones it passed over too.
      if (!cut) last = Math.max(last, scanned);
      let result: OutcomeResult | undefined = { kind: "kept" };
      if (entries.length > 0) {
        try {
          // oxlint-disable-next-line no-await-in-loop -- one request at a time, stopping at a failure
          result = await transport.reportProblems(connection.origin, connection.credential, {
            version: 1,
            extensionBuild: options.build,
            entries,
          });
        } catch {
          result = undefined;
        }
        tell({
          lines: entries.length,
          result: !result
            ? "failed:threw"
            : result.kind === "failed"
              ? `failed:${result.error}`
              : result.kind,
        });
      }
      if (result?.kind === "rejected") return;
      if (result?.kind !== "kept" && result?.kind !== "refused") {
        const failures = cursor.failures + 1;
        const backoff = Math.min(PROBLEM_RETRY_MAX_MS, PROBLEM_RETRY_MS * 2 ** (failures - 1));
        const asked = Math.min(PROBLEM_RETRY_MAX_MS, result?.retryAfterMs ?? 0);
        cursor = { ...cursor, failures, retryAt: now() + Math.max(backoff, asked) };
        // oxlint-disable-next-line no-await-in-loop -- recorded before giving up this run
        await log.setProblemCursor(cursor);
        return;
      }
      // A refused batch is skipped: the service will never take it.
      const moved = last !== cursor.after || entries.length > 0;
      cursor = {
        ...cursor,
        after: last,
        ...(entries.length > 0 ? { failures: 0, retryAt: 0 } : {}),
        ...(lastSent ? { last: lastSent } : {}),
      };
      // oxlint-disable-next-line no-await-in-loop -- recorded before the next request
      if (moved) await log.setProblemCursor(cursor);
      if (!cut && found.length < MAX_PROBLEM_BATCH) return;
    }
  }

  return {
    /** A `warn` or `error` entry was stored: sends it, with any others, shortly. */
    schedule(): void {
      if (scheduled) return;
      scheduled = true;
      try {
        setTimer(() => {
          scheduled = false;
          void enqueue(send);
        }, PROBLEM_DELAY_MS);
      } catch {
        scheduled = false;
      }
    },
    /** Sends what is still unsent, as at worker start or after a recipe sync. */
    flush(): Promise<void> {
      return enqueue(send);
    },
    /** A device was paired: lines from now on go to it, none from before. */
    paired(connection: { origin: string; deviceId: string }): Promise<void> {
      return enqueue(() => start(connection));
    },
  };
}
