import { describe, expect, it } from "vitest";
import type { StatusResponse } from "../login/choice-wire";
import { pageStatusLines } from "./page-status";
import { pauseLine, pauseShown } from "./pause";

type Status = Extract<StatusResponse, { ok: true }>;
const status = (fields: Partial<Status> = {}): Status => ({
  ok: true,
  origin: "https://login.example",
  recipe: "none",
  ...fields,
});

describe("pauseLine", () => {
  it("says until when automatic login is paused, on a 24-hour clock", () => {
    const at = Date.UTC(2026, 9, 23, 3, 40);
    expect(pauseLine(at, "Asia/Tokyo")).toBe("Paused until 12:40");
    expect(pauseLine(at, "UTC")).toBe("Paused until 03:40");
  });
});

describe("the page section on a paused site", () => {
  it("says why no login started", () => {
    const lines = pageStatusLines(
      status({ recipe: "page", page: { state: "denied", reason: "paused" } }),
    ).map(({ text }) => text);
    expect(lines).toContain(
      "No login started: automatic login is paused on this site; choose an account to log in.",
    );
  });
  it("says why a page without a recipe was not sent", () => {
    const lines = pageStatusLines(
      status({ page: { state: "denied", reason: "recipe-not-found", generationSkip: "paused" } }),
    ).map(({ text }) => text);
    expect(lines).toContain("Not sent to the AI: automatic login is paused on this site.");
  });
});

describe("pauseShown", () => {
  it("offers a pause where a vault item matches or the site has a recipe", () => {
    expect(pauseShown(status(), true)).toBe(true);
    expect(pauseShown(status({ recipe: "page" }), false)).toBe(true);
    expect(pauseShown(status({ recipe: "other-paths" }), false)).toBe(true);
  });
  it("offers none where Pateat would not log in by itself", () => {
    expect(pauseShown(status(), false)).toBe(false);
    // Before the worker answered for the page.
    expect(pauseShown(undefined, true)).toBe(false);
  });
  it("always shows a running pause, so it can be resumed", () => {
    expect(pauseShown(status({ pause: { until: 1 } }), false)).toBe(true);
  });
});
