import type { ProblemReport } from "@pateat/contracts";
import { describe, expect, it, vi } from "vitest";
import { sentToService, type KeyedEntry, type LogEntry } from "../diagnostics/log";
import {
  createProblemReports,
  MAX_PROBLEM_BATCH,
  MAX_PROBLEM_REQUESTS,
  PROBLEM_DELAY_MS,
  PROBLEM_REPEAT_MS,
  PROBLEM_RETRY_MAX_MS,
  PROBLEM_RETRY_MS,
  type ProblemLog,
  type ProblemsSent,
} from "./problems";
import type { ServiceConnection } from "./runtime";
import type { OutcomeResult, ServiceTransport } from "./transport";

// Synthetic log entries and service only; nothing leaves the test.

const CONNECTION: ServiceConnection = {
  origin: "https://pateat.example.com",
  deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
  credential: `pateat_device_${"C".repeat(43)}`,
  rejected: false,
};
const TIME = Date.UTC(2026, 9, 23, 1, 2, 3);

const blocked = (fields: LogEntry["fields"] = {}): LogEntry => ({
  time: TIME,
  level: "warn",
  event: "login.attempt",
  fields: {
    origin: "https://bank.example",
    recipe: "gen-0123456789abcdef0123456789abcdef",
    recipeRevision: 4,
    state: "blocked",
    outcome: "wrong-account",
    cause: "step-timeout",
    unsubmitted: true,
    url: "/login?user=",
    tab: 12,
    ...fields,
  },
});
/** An `info` entry that does not say why Pateat did nothing, so it is never sent. */
const info: LogEntry = {
  time: TIME,
  level: "info",
  event: "login.start",
  fields: { origin: "https://bank.example", route: "password" },
};
const LOG_ID = "0123456789abcdef0123456789abcdef";

function setup(
  options: {
    entries?: KeyedEntry[];
    cursor?: unknown;
    connection?: ServiceConnection | undefined;
    answer?: (report: ProblemReport) => Promise<OutcomeResult>;
    /** Entries one read looks at most, as the log's scan limit. */
    scanLimit?: number;
  } = {},
) {
  const state = {
    entries: options.entries ?? [],
    cursor: options.cursor,
    connection: "connection" in options ? options.connection : CONNECTION,
    now: 1_000,
  };
  const log: ProblemLog = {
    problemsAfter: vi.fn(async (after: number, limit: number) => {
      const looked = state.entries
        .filter(({ key }) => key > after)
        .slice(0, options.scanLimit ?? Infinity);
      const more = looked.length < state.entries.filter(({ key }) => key > after).length;
      const entries = looked.filter(({ entry }) => sentToService(entry)).slice(0, limit);
      const scanned =
        entries.length === limit ? entries.at(-1)!.key : (looked.at(-1)?.key ?? after);
      return { entries, scanned: Math.max(after, scanned), more: entries.length < limit && more };
    }),
    lastKey: vi.fn(async () => state.entries.at(-1)?.key ?? 0),
    logId: vi.fn(async () => LOG_ID),
    problemCursor: vi.fn(async () => structuredClone(state.cursor)),
    setProblemCursor: vi.fn(async (cursor) => {
      state.cursor = structuredClone(cursor);
    }),
  };
  const answer = options.answer ?? (async (): Promise<OutcomeResult> => ({ kind: "kept" }));
  const reportProblems = vi.fn<ServiceTransport["reportProblems"]>((_origin, _credential, report) =>
    answer(report),
  );
  const timers: { run: () => void; ms: number }[] = [];
  const logged: ProblemsSent[] = [];
  // A new worker: the same log and service, nothing kept in memory.
  const create = () =>
    createProblemReports({
      service: { connection: async () => state.connection },
      transport: { reportProblems },
      log,
      build: "1c42ad3",
      report: (sent) => logged.push(sent),
      now: () => state.now,
      setTimer: (run, ms) => timers.push({ run, ms }),
    });
  const problems = create();
  const cursorAt = (after: number, more: Record<string, unknown> = {}) => ({
    service: CONNECTION.origin,
    deviceId: CONNECTION.deviceId,
    after,
    failures: 0,
    retryAt: 0,
    ...more,
  });
  return { problems, create, log, reportProblems, timers, logged, state, cursorAt };
}

const keyed = (...entries: LogEntry[]): KeyedEntry[] =>
  entries.map((entry, at) => ({ key: at + 1, entry }));
/** Lines that differ by their step, so none repeats the last one sent. */
const distinct = (length: number, fields: LogEntry["fields"] = {}) =>
  Array.from({ length }, (_, at) => blocked({ step: at, ...fields }));

describe("problem reports (ADR 0066)", () => {
  it("starts after the newest entry for a new pairing, so no earlier line is sent", async () => {
    const { problems, reportProblems, state, cursorAt } = setup({
      entries: keyed(blocked(), blocked()),
    });
    await problems.flush();
    expect(reportProblems).not.toHaveBeenCalled();
    expect(state.cursor).toEqual(cursorAt(2));
    // So does a pairing with another device or service.
    state.cursor = { ...cursorAt(0), deviceId: "another-device" };
    await problems.flush();
    expect(reportProblems).not.toHaveBeenCalled();
    expect(state.cursor).toEqual(cursorAt(2));
  });

  it("sends warnings and errors after the cursor once, with the build and only what may leave", async () => {
    const { problems, reportProblems, state, logged } = setup({
      entries: keyed(
        blocked(),
        info,
        blocked({
          item: "item:3f9a0c1e",
          url: "/oauth2/aus1a2b3c4d5e6f7g8h9/v1/authorize?client_id=&state=#/signin",
        }),
        {
          time: TIME,
          level: "error",
          event: "error.unhandled",
          fields: { source: "rejection", name: "TypeError", stack: "background.js:1:2" },
        },
      ),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 1 },
    });
    await problems.flush();
    expect(reportProblems).toHaveBeenCalledTimes(1);
    expect(reportProblems).toHaveBeenCalledWith(CONNECTION.origin, CONNECTION.credential, {
      version: 1,
      extensionBuild: "1c42ad3",
      logId: LOG_ID,
      entries: [
        {
          seq: 3,
          time: TIME,
          level: "warn",
          event: "login.attempt",
          fields: {
            origin: "https://bank.example",
            recipe: "gen-0123456789abcdef0123456789abcdef",
            recipeRevision: 4,
            state: "blocked",
            outcome: "wrong-account",
            cause: "step-timeout",
            unsubmitted: true,
            // The path alone, its token-like segment redacted as in an observation.
            url: "/oauth2/[id]/v1/authorize",
            tab: 12,
          },
        },
        {
          seq: 4,
          time: TIME,
          level: "error",
          event: "error.unhandled",
          fields: { source: "rejection", name: "TypeError", stack: "background.js:1:2" },
        },
      ],
    });
    expect(state.cursor).toMatchObject({ after: 4 });
    expect(logged).toEqual([{ lines: 2, result: "kept" }]);
    await problems.flush();
    expect(reportProblems).toHaveBeenCalledTimes(1);
  });

  it("sends a long backlog in batches, a few requests a run", async () => {
    const total = MAX_PROBLEM_BATCH * (MAX_PROBLEM_REQUESTS + 1) + 3;
    const { problems, reportProblems, state } = setup({
      entries: keyed(...distinct(total)),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
    });
    await problems.flush();
    expect(reportProblems).toHaveBeenCalledTimes(MAX_PROBLEM_REQUESTS);
    expect(reportProblems.mock.calls.map(([, , report]) => report.entries.length)).toEqual(
      Array.from({ length: MAX_PROBLEM_REQUESTS }, () => MAX_PROBLEM_BATCH),
    );
    expect(state.cursor).toMatchObject({ after: MAX_PROBLEM_BATCH * MAX_PROBLEM_REQUESTS });
    await problems.flush();
    expect(
      reportProblems.mock.calls.slice(MAX_PROBLEM_REQUESTS).map(([, , r]) => r.entries.length),
    ).toEqual([MAX_PROBLEM_BATCH, 3]);
    expect(state.cursor).toMatchObject({ after: total });
  });

  it("keeps each request under its byte limit", async () => {
    const code = "x".repeat(64);
    const wide = {
      ...Object.fromEntries(
        ["route", "operation", "effect", "reason", "routeChange", "stop"].map((key) => [key, code]),
      ),
      url: `/${"login/".repeat(80)}`,
    };
    const { problems, reportProblems } = setup({
      entries: keyed(...distinct(MAX_PROBLEM_BATCH, wide)),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
    });
    await problems.flush();
    expect(reportProblems.mock.calls.length).toBeGreaterThan(1);
    for (const [, , report] of reportProblems.mock.calls)
      expect(new TextEncoder().encode(JSON.stringify(report.entries)).byteLength).toBeLessThan(
        32 * 1024,
      );
    expect(reportProblems.mock.calls.flatMap(([, , r]) => r.entries.map((e) => e.seq))).toEqual(
      Array.from({ length: MAX_PROBLEM_BATCH }, (_, at) => at + 1),
    );
  });

  it("sends each build's lines in requests of their own, with that build", async () => {
    const { problems, reportProblems } = setup({
      entries: keyed(
        { ...blocked({ step: 1 }), build: "abcdef1" },
        { ...blocked({ step: 2 }), build: "abcdef1" },
        { ...blocked({ step: 3 }), build: "1c42ad3" },
        // An entry an older log stored without its build, or with one the contract refuses,
        // goes with this build.
        blocked({ step: 4 }),
        { ...blocked({ step: 5 }), build: "not a build" },
      ),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
    });
    await problems.flush();
    expect(
      reportProblems.mock.calls.map(([, , report]) => [
        report.extensionBuild,
        report.logId,
        report.entries.map((entry) => entry.seq),
      ]),
    ).toEqual([
      ["abcdef1", LOG_ID, [1, 2]],
      ["1c42ad3", LOG_ID, [3, 4, 5]],
    ]);
  });

  it("goes on past entries a read only looked over, within the run's requests", async () => {
    const { problems, reportProblems, state } = setup({
      entries: keyed(info, info, info, info, info, info, info, blocked()),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
      scanLimit: 3,
    });
    await problems.flush();
    expect(reportProblems).toHaveBeenCalledTimes(1);
    expect(reportProblems.mock.calls[0]![2].entries.map((entry) => entry.seq)).toEqual([8]);
    expect(state.cursor).toMatchObject({ after: 8 });
  });

  it("keeps lines after a failure and backs off, doubling up to an hour", async () => {
    let answer: OutcomeResult = { kind: "failed", error: "unreachable" };
    const { problems, reportProblems, state, logged, cursorAt } = setup({
      entries: keyed(blocked()),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
      answer: async () => answer,
    });
    await problems.flush();
    expect(reportProblems).toHaveBeenCalledTimes(1);
    expect(state.cursor).toEqual(cursorAt(0, { failures: 1, retryAt: 1_000 + PROBLEM_RETRY_MS }));
    // Held off for a minute.
    state.now += PROBLEM_RETRY_MS - 1;
    await problems.flush();
    expect(reportProblems).toHaveBeenCalledTimes(1);
    state.now += 1;
    await problems.flush();
    expect(reportProblems).toHaveBeenCalledTimes(2);
    // Then two minutes, and never more than an hour.
    state.now += PROBLEM_RETRY_MS;
    await problems.flush();
    expect(reportProblems).toHaveBeenCalledTimes(2);
    for (let failure = 0; failure < 10; failure += 1) {
      state.now += PROBLEM_RETRY_MAX_MS;
      // oxlint-disable-next-line no-await-in-loop -- one run at a time
      await problems.flush();
    }
    expect(reportProblems).toHaveBeenCalledTimes(12);
    answer = { kind: "kept" };
    state.now += PROBLEM_RETRY_MAX_MS;
    await problems.flush();
    expect(state.cursor).toMatchObject({ after: 1, failures: 0, retryAt: 0 });
    expect(logged.at(0)).toEqual({ lines: 1, result: "failed:unreachable" });
    expect(logged.at(-1)).toEqual({ lines: 1, result: "kept" });
  });

  it("skips a batch the service refuses and a line the contract refuses", async () => {
    const { problems, reportProblems, state } = setup({
      entries: keyed(...distinct(2)),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
      answer: async () => ({ kind: "refused" }),
    });
    await problems.flush();
    expect(reportProblems).toHaveBeenCalledTimes(1);
    expect(state.cursor).toMatchObject({ after: 2 });
    // A line the contract refuses, such as one with a time before 1970, is never sent; an
    // unsendable line alone sends no request at all.
    const skipped = setup({
      entries: keyed({ ...blocked(), time: -1 }, blocked()),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
    });
    await skipped.problems.flush();
    expect(skipped.reportProblems.mock.calls.map(([, , r]) => r.entries.map((e) => e.seq))).toEqual(
      [[2]],
    );
    const alone = setup({
      entries: keyed({ ...blocked(), time: -1 }),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
    });
    await alone.problems.flush();
    expect(alone.reportProblems).not.toHaveBeenCalled();
    expect(alone.state.cursor).toEqual(alone.cursorAt(1));
    // Nor does a run that passed over only `debug` and `info` entries, but it moves on.
    const quiet = setup({
      entries: keyed(info, info, info),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
    });
    await quiet.problems.flush();
    expect(quiet.reportProblems).not.toHaveBeenCalled();
    expect(quiet.state.cursor).toEqual(quiet.cursorAt(3));
  });

  it("sends nothing without a service or with a rejected credential", async () => {
    const unpaired = setup({ entries: keyed(blocked()), connection: undefined });
    await unpaired.problems.flush();
    expect(unpaired.log.problemsAfter).not.toHaveBeenCalled();
    const rejected = setup({
      entries: keyed(blocked()),
      connection: { ...CONNECTION, rejected: true },
    });
    await rejected.problems.flush();
    expect(rejected.reportProblems).not.toHaveBeenCalled();
    const refusedNow = setup({
      entries: keyed(blocked(), blocked()),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
      answer: async () => ({ kind: "rejected" }),
    });
    await refusedNow.problems.flush();
    expect(refusedNow.state.cursor).toEqual({
      service: CONNECTION.origin,
      deviceId: CONNECTION.deviceId,
      after: 0,
    });
  });

  it("sends a burst of problems in one run shortly after the first, and never throws", async () => {
    const { problems, reportProblems, timers, state } = setup({
      entries: keyed(blocked()),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
      answer: async () => {
        throw new Error("network");
      },
    });
    problems.schedule();
    problems.schedule();
    expect(timers).toHaveLength(1);
    expect(timers[0]!.ms).toBe(PROBLEM_DELAY_MS);
    timers[0]!.run();
    await problems.flush();
    expect(reportProblems).toHaveBeenCalledTimes(1);
    expect(state.cursor).toMatchObject({ after: 0 });
    problems.schedule();
    expect(timers).toHaveLength(2);
  });

  it("keeps its backoff across a worker restart and waits as long as the service asks", async () => {
    const { problems, create, reportProblems, state, cursorAt } = setup({
      entries: keyed(blocked()),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
      answer: async () => ({ kind: "failed", error: "rate-limited", retryAfterMs: 3_600_000 }),
    });
    await problems.flush();
    expect(state.cursor).toEqual(cursorAt(0, { failures: 1, retryAt: 1_000 + 3_600_000 }));
    // A new worker holds off too.
    state.now += PROBLEM_RETRY_MS;
    await create().flush();
    expect(reportProblems).toHaveBeenCalledTimes(1);
    state.now = 1_000 + 3_600_000;
    await create().flush();
    expect(reportProblems).toHaveBeenCalledTimes(2);
    expect(state.cursor).toMatchObject({ failures: 2 });
  });

  it("leaves out a line identical to the last one sent within an hour", async () => {
    const later = (ms: number, fields: LogEntry["fields"] = {}) => ({
      ...blocked(fields),
      time: TIME + ms,
    });
    const { problems, create, reportProblems, state } = setup({
      entries: keyed(blocked(), later(1_000), later(2_000, { step: 1 }), later(3_000)),
      cursor: { service: CONNECTION.origin, deviceId: CONNECTION.deviceId, after: 0 },
    });
    await problems.flush();
    // Only the line just before is compared, so a line that differs ends a repeat.
    expect(reportProblems.mock.calls.map(([, , r]) => r.entries.map((e) => e.seq))).toEqual([
      [1, 3, 4],
    ]);
    expect(state.cursor).toMatchObject({ after: 4 });
    // The last line sent is kept, so a new worker's repeat of it is left out too...
    state.entries.push(
      { key: 5, entry: later(4_000) },
      { key: 6, entry: later(PROBLEM_REPEAT_MS + 3_000) },
    );
    await create().flush();
    // ...until an hour after it.
    expect(reportProblems.mock.calls.map(([, , r]) => r.entries.map((e) => e.seq))).toEqual([
      [1, 3, 4],
      [6],
    ]);
  });

  it("starts a new pairing's lines at the pairing", async () => {
    const { problems, reportProblems, state, cursorAt } = setup({ entries: keyed(blocked()) });
    await problems.paired({ origin: CONNECTION.origin, deviceId: CONNECTION.deviceId });
    expect(state.cursor).toEqual(cursorAt(1));
    // A warning between the pairing and the first run is sent.
    state.entries.push({ key: 2, entry: blocked({ step: 1 }) });
    await problems.flush();
    expect(reportProblems.mock.calls.map(([, , r]) => r.entries.map((e) => e.seq))).toEqual([[2]]);
  });
});
