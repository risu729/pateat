import { describe, expect, it } from "vitest";
import { readServiceReports } from "./reports-setting";

describe("service reports setting", () => {
  it("sends by default, as before the setting existed", async () => {
    expect(await readServiceReports(async () => ({}))).toEqual({ send: true });
  });

  it("keeps the synced choice", async () => {
    const serviceReports = { send: false, since: 1_000 };
    expect(await readServiceReports(async () => ({ serviceReports }))).toEqual(serviceReports);
  });

  it("sends nothing when the settings cannot be read", async () => {
    expect(await readServiceReports(() => Promise.reject(new Error("storage")))).toEqual({
      send: false,
    });
  });
});
