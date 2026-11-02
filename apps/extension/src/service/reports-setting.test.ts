import { describe, expect, it } from "vitest";
import { parseServiceReports, readServiceReports } from "./reports-setting";

describe("service reports setting", () => {
  it("sends by default, as before the setting existed", async () => {
    expect(parseServiceReports(undefined)).toEqual({ send: true });
    expect(parseServiceReports(null)).toEqual({ send: true });
    expect(await readServiceReports(async () => undefined)).toEqual({ send: true });
  });

  it("keeps the stored choice", () => {
    expect(parseServiceReports({ send: false })).toEqual({ send: false });
    expect(parseServiceReports({ send: true, since: 1_000 })).toEqual({ send: true, since: 1_000 });
  });

  it("sends nothing for a damaged or unreadable record", async () => {
    for (const value of [
      { send: "yes" },
      { send: true, extra: 1 },
      { send: true, since: -1 },
      false,
      "on",
    ])
      expect(parseServiceReports(value)).toEqual({ send: false });
    expect(await readServiceReports(() => Promise.reject(new Error("storage")))).toEqual({
      send: false,
    });
  });
});
