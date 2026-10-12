import { describe, expect, it } from "vitest";
import { pickBrowser, readBrowserInfo } from "./browser";

describe("browser info", () => {
  it("picks Chrome, then Chromium, and skips GREASE brands", () => {
    expect(
      pickBrowser([
        { brand: "Not)A;Brand", version: "99.0.0.0" },
        { brand: "Chromium", version: "154.0.7712.45" },
        { brand: "Google Chrome", version: "154.0.7712.45" },
      ]),
    ).toEqual({ name: "Chrome", version: "154.0.7712.45" });
    expect(pickBrowser([{ brand: "Chromium", version: "141.0.1.0" }])).toEqual({
      name: "Chromium",
      version: "141.0.1.0",
    });
    expect(pickBrowser(undefined)).toEqual({ name: "Unknown browser", version: "" });
  });

  it("falls back when an API is missing or fails", async () => {
    await expect(
      readBrowserInfo({ getSelf: () => Promise.reject(new Error("no management")) }),
    ).resolves.toEqual({ name: "Unknown browser", version: "", installType: "unknown" });
    await expect(
      readBrowserInfo({
        getSelf: () => {
          throw new TypeError("browser.management is undefined");
        },
      }),
    ).resolves.toEqual({ name: "Unknown browser", version: "", installType: "unknown" });
    await expect(
      readBrowserInfo({
        userAgentData: { getHighEntropyValues: () => Promise.reject(new Error("no hints")) },
        getSelf: async () => ({ installType: "normal" }),
      }),
    ).resolves.toEqual({ name: "Unknown browser", version: "", installType: "normal" });
  });
});
