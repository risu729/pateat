// Times are kept as epoch milliseconds (`Date.now()`) in extension storage and IndexedDB,
// and as ISO 8601 strings in a few stored records. The native Temporal (Chrome 144, the
// extension's minimum) formats and reads them. The service has no Temporal and uses Date.
import * as v from "valibot";

/** `2026-10-13T14:29:34.352Z`, the form `Date.prototype.toISOString` writes. */
export function isoTime(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toString({ fractionalSecondDigits: 3 });
}

/** `2026-10-13T14:29Z`: the time to the minute, in UTC. */
export function isoMinute(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toString({ smallestUnit: "minute" });
}

/**
 * A sync time for a settings page, such as `Oct 13, 2026, 11:29 PM` in the browser's
 * locale and time zone. A value outside Temporal's range, which only damaged storage can
 * hold, reads `at an unknown time` instead of breaking the page.
 */
export function localSyncTime(ms: number): string {
  try {
    return Temporal.Instant.fromEpochMilliseconds(ms).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
  } catch {
    return "at an unknown time";
  }
}

/** The epoch milliseconds of an ISO 8601 time with a UTC offset; a RangeError for other text. */
export function isoTimeMs(text: string): number {
  return Temporal.Instant.from(text).epochMilliseconds;
}

/** An ISO 8601 time with a UTC offset that names a real date, such as `isoTime` writes. */
export const isoTimeSchema = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.check((text) => {
    try {
      isoTimeMs(text);
      return true;
    } catch {
      return false;
    }
  }),
);
