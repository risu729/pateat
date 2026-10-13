import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { isoMinute, isoTime, isoTimeSchema, isoTimeMs, localSyncTime } from "./time";

// Year 0 to 9999, including leap days, the epoch and times just before it.
const TIMES = [
  0, 1, -1, -30_000, 999, 1_000, 59_999, 60_000, 951_782_400_000, 1_791_900_034_000,
  1_791_900_034_352, -62_167_219_200_000, 253_402_300_799_999,
];

describe("ISO times", () => {
  it("writes what Date.prototype.toISOString writes, and to the minute", () => {
    for (const ms of TIMES) {
      expect(isoTime(ms)).toBe(new Date(ms).toISOString());
      expect(isoMinute(ms)).toBe(`${new Date(ms).toISOString().slice(0, 16)}Z`);
    }
    expect(isoTime(1_791_900_034_000)).toBe("2026-10-13T14:00:34.000Z");
    expect(isoMinute(1_791_900_034_352)).toBe("2026-10-13T14:00Z");
  });

  it("throws for a time outside the range a Date holds", () => {
    expect(() => isoTime(8.64e15 + 1)).toThrow(RangeError);
    expect(() => isoMinute(Number.NaN)).toThrow(RangeError);
  });

  it("reads a time with an offset back to epoch milliseconds", () => {
    for (const ms of TIMES) expect(isoTimeMs(isoTime(ms))).toBe(ms);
    expect(isoTimeMs("2026-10-13T23:00:34.352+09:00")).toBe(1_791_900_034_352);
    // .NET writes seven fraction digits; milliseconds keep the first three.
    expect(isoTimeMs("2026-10-13T14:00:34.3529999Z")).toBe(1_791_900_034_352);
  });

  it("reads no time without an offset or with a date that does not exist", () => {
    expect(() => isoTimeMs("2026-10-13T14:00:34")).toThrow(RangeError);
    expect(() => isoTimeMs("2026-02-29T00:00:00Z")).toThrow(RangeError);
    expect(() => isoTimeMs("not a time")).toThrow(RangeError);
    expect(v.is(isoTimeSchema, "2026-02-29T00:00:00Z")).toBe(false);
    expect(v.is(isoTimeSchema, "2028-02-29T00:00:00Z")).toBe(true);
    expect(v.is(isoTimeSchema, isoTime(1_791_900_034_352))).toBe(true);
  });
});

describe("local sync times", () => {
  it("shows a time as Date did and an out-of-range one as unknown", () => {
    const options = { dateStyle: "medium", timeStyle: "short" } as const;
    expect(localSyncTime(1_791_900_034_352)).toBe(
      new Date(1_791_900_034_352).toLocaleString(undefined, options),
    );
    expect(localSyncTime(8.64e15 + 1)).toBe("at an unknown time");
  });
});
