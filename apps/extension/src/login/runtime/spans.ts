import type { AttemptTiming } from "@pateat/contracts";
import type { Runtime } from "./state";
import type { Execution } from "./types";

/**
 * Where a login's own time went, in milliseconds, for the local log only (ADR 0019,
 * amendment of 2026-11-03): parts of `otherMs`, so that a log tells which of Pateat's own
 * work to speed up. None of them leaves the device (`LOCAL_ONLY_FIELDS`).
 *
 * - `beforeShownMs`: from when the extension saw the document until it first announced a
 *   sign-in on the path the login started on (a ready first step, a sign-in form offered
 *   for generation, a sign-in entry or an account list). Part of `totalMs` today; not part
 *   of `otherMs` alone, since generation may run in it.
 * - `startMs`: from that announcement, as last received, until the login started: its
 *   admission, settings, plan and account choice.
 * - `awaitMs`: waiting for a step's elements before it runs, mostly the site rendering
 *   them, which `otherMs` holds too.
 * - `saveMs`: storing the attempt's record after a change.
 * - `statusMs`: telling the page the login's new state after a change.
 * - `checkMs`: the policy checks before and after each step's values are read.
 * - `vaultMs`: reading the values a fill types, and the username it compares.
 * - `commandMs`: a step's command to the page and its answer, for every step but a fill:
 *   how long a fill took is never recorded, since values are typed one character at a time
 *   and it would tell a value's length (ADR 0012).
 *
 * A part counts only time that ran outside the login's waits for the site, the person and
 * the service, and while parts of one login overlap, as a save inside a policy check, the
 * time counts once, in the one that began first, so the parts other than `beforeShownMs`
 * never add up to more than `otherMs`. Each part is logged rounded down to a step of
 * {@link SPAN_STEP_MS}, so that what is left of `otherMs` after them does not tell how long
 * a fill took either, and a login that typed on a software keyboard, whose presses take
 * long enough to count, logs none (ADR 0067). The save and status of the change that ends
 * a login come after its entry and are not counted. They are kept in memory only: a worker
 * that stops loses them.
 */
export type SpanName =
  | "beforeShownMs"
  | "startMs"
  | "awaitMs"
  | "saveMs"
  | "statusMs"
  | "checkMs"
  | "vaultMs"
  | "commandMs";

export type AttemptSpans = Partial<Record<SpanName, number>>;

/** The step each part is rounded to when it is logged. */
export const SPAN_STEP_MS = 100;

/** Logins whose parts are kept at once; the oldest goes first. */
const KEPT_ATTEMPTS = 64;

type Tables = {
  /** The parts so far, by attempt. */
  spans: Map<string, AttemptSpans>;
  /** Attempts whose parts were taken or withheld, which add none any more. */
  closed: Set<string>;
  /** The parts being timed now, by attempt, in the order they began. */
  clocks: Map<string, Clock>;
};

/** A login's parts being timed now: since when, with its timing then. */
type Clock = {
  at: number;
  timing: AttemptTiming;
  active: { name: SpanName; token: object }[];
};

const tables = new WeakMap<Runtime, Tables>();

function tablesOf(rt: Runtime): Tables {
  let found = tables.get(rt);
  if (!found) {
    found = { spans: new Map(), closed: new Set(), clocks: new Map() };
    tables.set(rt, found);
  }
  return found;
}

/** Keeps the latest `KEPT_ATTEMPTS` keys of `map`, dropping the oldest. */
function bound(map: {
  size: number;
  keys(): IterableIterator<string>;
  delete(key: string): unknown;
}) {
  for (const old of map.keys()) {
    if (map.size <= KEPT_ATTEMPTS) break;
    map.delete(old);
  }
}

/** Adds `ms` to attempt `attemptId`'s part `name`; nothing for no time or a closed login. */
export function addSpan(rt: Runtime, attemptId: string, name: SpanName, ms: number): void {
  const add = Math.round(ms);
  if (!Number.isFinite(add) || add <= 0) return;
  const { spans, closed } = tablesOf(rt);
  if (closed.has(attemptId)) return;
  const kept = spans.get(attemptId) ?? {};
  spans.delete(attemptId);
  spans.set(attemptId, { ...kept, [name]: (kept[name] ?? 0) + add });
  bound(spans);
}

function close(rt: Runtime, attemptId: string): AttemptSpans | undefined {
  const { spans, closed } = tablesOf(rt);
  const found = spans.get(attemptId);
  spans.delete(attemptId);
  closed.delete(attemptId);
  closed.add(attemptId);
  bound(closed);
  return found;
}

/**
 * Attempt `attemptId`'s parts, taken once and rounded down to {@link SPAN_STEP_MS}: a login
 * that ended logs them with its times. A part rounded to nothing is left out, and the
 * login adds no part after.
 */
export function takeSpans(rt: Runtime, attemptId: string): AttemptSpans | undefined {
  const found = close(rt, attemptId);
  if (!found) return undefined;
  const rounded: AttemptSpans = {};
  for (const [name, ms] of Object.entries(found) as [SpanName, number][]) {
    const step = Math.floor(ms / SPAN_STEP_MS) * SPAN_STEP_MS;
    if (step > 0) rounded[name] = step;
  }
  return Object.keys(rounded).length ? rounded : undefined;
}

/** Drops attempt `attemptId`'s parts and logs none of them, as after a software keyboard. */
export function withholdSpans(rt: Runtime, attemptId: string): void {
  close(rt, attemptId);
}

/**
 * The time from `started` until `now` outside the login's waits, read from its timing at
 * the start (`before`) and the end (`after`): none when a wait for the site or the person
 * already ran at the start, only until a wait that began meanwhile, and less any service,
 * person or site time added meanwhile.
 */
export function ownTime(
  before: AttemptTiming,
  after: AttemptTiming,
  started: number,
  now = Date.now(),
): number {
  if (before.pageSince !== undefined || before.personSince !== undefined) return 0;
  let end = now;
  for (const since of [after.pageSince, after.personSince])
    if (since !== undefined) end = Math.min(end, Math.max(started, since));
  const added =
    Math.max(0, after.serviceMs - before.serviceMs) +
    Math.max(0, after.personMs - before.personMs) +
    Math.max(0, after.pageMs - before.pageMs);
  return Math.max(0, end - started - added);
}

/** Gives the time since the clock's last reading to the part of the login that began first. */
function tick(rt: Runtime, id: string, clock: Clock, timing: AttemptTiming): void {
  const now = Date.now();
  const owner = clock.active[0];
  if (owner) addSpan(rt, id, owner.name, ownTime(clock.timing, timing, clock.at, now));
  clock.at = now;
  clock.timing = timing;
}

/**
 * Runs `work` and adds the login's own time it took to part `name` of `run`'s login. While
 * another part of the same login runs too, as a save inside a policy check, the time counts
 * once, in the part that began first.
 */
export async function timed<T>(
  rt: Runtime,
  run: Execution,
  name: SpanName,
  work: () => Promise<T>,
): Promise<T> {
  const id = run.metadata.id;
  const { clocks } = tablesOf(rt);
  let clock = clocks.get(id);
  if (clock) tick(rt, id, clock, run.metadata.timing);
  else {
    clock = { at: Date.now(), timing: run.metadata.timing, active: [] };
    clocks.set(id, clock);
  }
  const token = {};
  clock.active.push({ name, token });
  try {
    return await work();
  } finally {
    if (run.metadata.id === id) tick(rt, id, clock, run.metadata.timing);
    clock.active = clock.active.filter((entry) => entry.token !== token);
    if (!clock.active.length && clocks.get(id) === clock) clocks.delete(id);
  }
}
