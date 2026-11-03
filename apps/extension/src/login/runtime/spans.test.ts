import { describe, expect, it, vi } from "vitest";
import { addSpan, ownTime, takeSpans, timed } from "./spans";
import type { Runtime } from "./state";
import type { Execution } from "./types";

const timing = (extra: Record<string, number> = {}) => ({
  since: 0,
  serviceMs: 0,
  networkMs: 0,
  personMs: 0,
  pageMs: 0,
  ...extra,
});

describe("ownTime", () => {
  it("counts the time that passed when nothing else waited", () => {
    expect(ownTime(timing(), timing(), 1_000, 1_250)).toBe(250);
  });
  it("counts nothing while a wait for the site or the person already ran", () => {
    expect(ownTime(timing({ pageSince: 900 }), timing({ pageSince: 900 }), 1_000, 1_250)).toBe(0);
    expect(ownTime(timing({ personSince: 900 }), timing(), 1_000, 1_250)).toBe(0);
  });
  it("counts only until a wait that began meanwhile", () => {
    expect(ownTime(timing(), timing({ pageSince: 1_100 }), 1_000, 1_250)).toBe(100);
    expect(ownTime(timing(), timing({ personSince: 1_050 }), 1_000, 1_250)).toBe(50);
  });
  it("leaves out service, person and site time added meanwhile, never below 0", () => {
    expect(ownTime(timing(), timing({ serviceMs: 100, pageMs: 50 }), 1_000, 1_250)).toBe(100);
    expect(ownTime(timing({ personMs: 10 }), timing({ personMs: 400 }), 1_000, 1_250)).toBe(0);
  });
});

describe("addSpan and takeSpans", () => {
  it("adds the time per part, and hands it out once in steps of 100 ms", () => {
    const rt = {} as Runtime;
    addSpan(rt, "a", "saveMs", 10.4);
    addSpan(rt, "a", "saveMs", 5);
    addSpan(rt, "a", "checkMs", 0);
    addSpan(rt, "a", "checkMs", -3);
    addSpan(rt, "a", "vaultMs", Number.NaN);
    addSpan(rt, "a", "checkMs", 149);
    addSpan(rt, "a", "awaitMs", 1_049);
    // `saveMs` (15 ms) rounds to nothing and is left out.
    expect(takeSpans(rt, "a")).toEqual({ checkMs: 100, awaitMs: 1_000 });
    expect(takeSpans(rt, "a")).toBeUndefined();
  });
  it("hands out nothing when every part rounds to nothing", () => {
    const rt = {} as Runtime;
    addSpan(rt, "a", "statusMs", 20);
    expect(takeSpans(rt, "a")).toBeUndefined();
  });
  it("keeps the parts of the latest 64 logins", () => {
    const rt = {} as Runtime;
    for (let index = 0; index < 65; index++) addSpan(rt, `${index}`, "startMs", 100);
    expect(takeSpans(rt, "0")).toBeUndefined();
    expect(takeSpans(rt, "64")).toEqual({ startMs: 100 });
  });
  it("keeps each runtime's parts apart", () => {
    const one = {} as Runtime;
    addSpan(one, "a", "awaitMs", 700);
    expect(takeSpans({} as Runtime, "a")).toBeUndefined();
    expect(takeSpans(one, "a")).toEqual({ awaitMs: 700 });
  });
});

describe("timed", () => {
  it("counts a part inside another only in the outer one", async () => {
    const rt = {} as Runtime;
    const run = { metadata: { id: "a", timing: timing() } } as unknown as Execution;
    let clock = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      await timed(rt, run, "checkMs", async () => {
        clock += 100;
        await timed(rt, run, "saveMs", async () => {
          clock += 200;
        });
        clock += 100;
      });
      await timed(rt, run, "saveMs", async () => {
        clock += 300;
      });
      expect(takeSpans(rt, "a")).toEqual({ checkMs: 400, saveMs: 300 });
    } finally {
      now.mockRestore();
    }
  });
});
