import { type AttemptTiming, watched } from "./schema-primitives";

/** A duration in whole, non-negative milliseconds. */
const duration = (value: number) => Math.max(0, Math.round(value));
type Timed = { timing: AttemptTiming };

/**
 * Adds time a login waited for the service, and of that for the network, or for the person
 * (ADR 0019). Service time while the login waits for the person or the site moves that
 * wait's start on, so no time counts twice.
 */
export function addAttemptTime<T extends Timed>(
  metadata: T,
  add: { serviceMs?: number; networkMs?: number; personMs?: number },
  now = Date.now(),
): T {
  const { timing } = metadata;
  const service = duration(add.serviceMs ?? 0);
  const moved = (since: number | undefined) =>
    since === undefined ? undefined : Math.max(since, Math.min(duration(now), since + service));
  const personSince = moved(timing.personSince);
  const pageSince = moved(timing.pageSince);
  return {
    ...metadata,
    timing: {
      ...timing,
      serviceMs: timing.serviceMs + service,
      networkMs: timing.networkMs + duration(add.networkMs ?? 0),
      personMs: timing.personMs + duration(add.personMs ?? 0),
      ...(personSince === undefined ? {} : { personSince }),
      ...(pageSince === undefined ? {} : { pageSince }),
    },
  };
}

/** Ends a running wait for the site and adds its time (ADR 0019). */
function pageShown<T extends Timed>(metadata: T, now: number): T {
  const { timing } = metadata;
  if (timing.pageSince === undefined) return metadata;
  const { pageSince, ...rest } = timing;
  return { ...metadata, timing: { ...rest, pageMs: rest.pageMs + duration(now - pageSince) } };
}

/**
 * Starts a wait for the person, unless one is running (ADR 0019). A running wait for the
 * site ends: what the person does next is their time.
 */
export function awaitPerson<T extends Timed>(metadata: T, now = Date.now()): T {
  if (metadata.timing.personSince !== undefined) return metadata;
  const { timing } = pageShown(metadata, now);
  return { ...metadata, timing: { ...timing, personSince: duration(now) } };
}

/** Ends a running wait for the person and adds its time (ADR 0019). */
export function personAnswered<T extends Timed>(metadata: T, now = Date.now()): T {
  const { timing } = metadata;
  if (timing.personSince === undefined) return metadata;
  const { personSince, ...rest } = timing;
  return {
    ...metadata,
    timing: { ...rest, personMs: rest.personMs + duration(now - personSince) },
  };
}

/**
 * Starts or ends the login's wait for the site (ADR 0019): it runs while the login waits
 * for the result of a step that may have changed the page (`awaiting-result` and
 * `reconciling`), a page load or a new page included, until it reads that result. It never
 * runs while the login waits for the person or after its result settled as unknown, as a
 * watched one that only waits for a later page.
 */
export function followPage<T extends Timed & Parameters<typeof watched>[0]>(
  metadata: T,
  now = Date.now(),
): T {
  const waits =
    (metadata.state === "awaiting-result" || metadata.state === "reconciling") &&
    metadata.settled !== true &&
    metadata.timing.personSince === undefined;
  if (!waits) return pageShown(metadata, now);
  if (metadata.timing.pageSince !== undefined) return metadata;
  return { ...metadata, timing: { ...metadata.timing, pageSince: duration(now) } };
}

/** A login's times for the local log and its login record, each in whole milliseconds. */
export type AttemptTimes = {
  /** From when the extension saw the page that started the login until now. */
  totalMs: number;
  /** Waiting for the service: recipe generation, judging and the recipe sync after them. */
  serviceMs: number;
  /**
   * Of `serviceMs`, the network part: each request's round trip less the service's own
   * time from its `Server-Timing` header. A request whose answer did not name that time,
   * or that got no answer, adds nothing, so this is a lower bound.
   */
  networkMs: number;
  /** Waiting for the person: a watched login, a click left to them, an account pick. */
  personMs: number;
  /**
   * Waiting for the site: from a step of the login that may change the page, or the
   * sign-in entry press before it, until the login read the page's answer, a page load
   * included.
   */
  pageMs: number;
  /** The rest: Pateat's own work and waits, reading pages, filling and clicking. */
  otherMs: number;
};

/**
 * A login's times until `now`, running waits for the person and the site included. The
 * parts other than `networkMs` add up to `totalMs`, unless the service and person time
 * alone are more, as after overlapping requests or a clock that moved back; `pageMs` is
 * cut so that it never makes them more.
 */
export function attemptTimes(metadata: Timed, now = Date.now()): AttemptTimes {
  const { timing } = pageShown(personAnswered(metadata, now), now);
  const totalMs = duration(now - timing.since);
  const pageMs = Math.min(timing.pageMs, duration(totalMs - timing.serviceMs - timing.personMs));
  return {
    totalMs,
    serviceMs: timing.serviceMs,
    networkMs: timing.networkMs,
    personMs: timing.personMs,
    pageMs,
    otherMs: duration(totalMs - timing.serviceMs - timing.personMs - pageMs),
  };
}
