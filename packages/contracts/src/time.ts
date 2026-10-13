// Times are kept as epoch milliseconds (`Date.now()`) in storage, IndexedDB and D1, and as
// ISO 8601 strings in a few stored records. Temporal formats and reads them; it comes
// from temporal-polyfill-lite because workerd and Chrome before 144 have no native one.
import { Temporal } from "temporal-polyfill-lite";
import * as v from "valibot";

/** `2026-10-13T14:29:34.352Z`, the form `Date.prototype.toISOString` writes. */
export function isoTime(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toString({ fractionalSecondDigits: 3 });
}

/** `2026-10-13T14:29Z`: the time to the minute, in UTC. */
export function isoMinute(ms: number): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toString({ smallestUnit: "minute" });
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
