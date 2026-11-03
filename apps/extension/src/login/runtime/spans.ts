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
 * the service, and a part inside another, such as a save inside a policy check, counts
 * only in the outer one, so the parts other than `beforeShownMs` never add up to more than
 * `otherMs`. Each part is logged in steps of {@link SPAN_STEP_MS}, so that what is left of
 * `otherMs` after them does not tell how long a fill took either. They are kept in memory
 * only: a worker that stops loses them.
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

const tables = new WeakMap<Runtime, Map<string, AttemptSpans>>();

/** Attempts with a part being timed now, whose inner parts count in it alone. */
const timing = new WeakMap<Runtime, Set<string>>();

function table(rt: Runtime): Map<string, AttemptSpans> {
  let found = tables.get(rt);
  if (!found) {
    found = new Map();
    tables.set(rt, found);
  }
  return found;
}

/** Adds `ms` to attempt `attemptId`'s part `name`; nothing for no time. */
export function addSpan(rt: Runtime, attemptId: string, name: SpanName, ms: number): void {
  const add = Math.round(ms);
  if (!Number.isFinite(add) || add <= 0) return;
  const spans = table(rt);
  const kept = spans.get(attemptId) ?? {};
  spans.delete(attemptId);
  spans.set(attemptId, { ...kept, [name]: (kept[name] ?? 0) + add });
  for (const old of spans.keys()) {
    if (spans.size <= KEPT_ATTEMPTS) break;
    spans.delete(old);
  }
}

/**
 * Attempt `attemptId`'s parts, taken once and rounded to {@link SPAN_STEP_MS}: a login that
 * ended logs them with its times. A part rounded to nothing is left out.
 */
export function takeSpans(rt: Runtime, attemptId: string): AttemptSpans | undefined {
  const spans = table(rt);
  const found = spans.get(attemptId);
  spans.delete(attemptId);
  if (!found) return undefined;
  const rounded: AttemptSpans = {};
  for (const [name, ms] of Object.entries(found) as [SpanName, number][]) {
    const step = Math.round(ms / SPAN_STEP_MS) * SPAN_STEP_MS;
    if (step > 0) rounded[name] = step;
  }
  return Object.keys(rounded).length ? rounded : undefined;
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

/**
 * Runs `work` and adds the login's own time it took to part `name` of `run`'s login; inside
 * another part of the same login, it adds nothing, as the outer part counts it.
 */
export async function timed<T>(
  rt: Runtime,
  run: Execution,
  name: SpanName,
  work: () => Promise<T>,
): Promise<T> {
  const id = run.metadata.id;
  let active = timing.get(rt);
  if (!active) {
    active = new Set();
    timing.set(rt, active);
  }
  if (active.has(id)) return work();
  const before = run.metadata.timing;
  const started = Date.now();
  active.add(id);
  try {
    return await work();
  } finally {
    active.delete(id);
    if (run.metadata.id === id)
      addSpan(rt, id, name, ownTime(before, run.metadata.timing, started));
  }
}
