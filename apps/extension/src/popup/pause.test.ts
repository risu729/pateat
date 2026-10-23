import { describe, expect, it } from "vitest";
import { i18n } from "../i18n";
import type { StatusResponse } from "../login/choice-wire";
import { pageStatusLines } from "./page-status";
import { pauseLine, pauseShown, siteRules } from "./pause";

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
    expect(pauseLine(at, i18n.getFixedT("en"), "Asia/Tokyo")).toBe("Paused until 12:40");
    expect(pauseLine(at, i18n.getFixedT("en"), "UTC")).toBe("Paused until 03:40");
    expect(pauseLine("rule", i18n.getFixedT("en"))).toBe("Paused until turned back on");
  });
  it("says it in Japanese", () => {
    const at = Date.UTC(2026, 9, 23, 3, 40);
    expect(pauseLine(at, i18n.getFixedT("ja"), "UTC")).toBe("03:40 まで一時停止中");
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
  it("says automatic login is off in private windows there, not that the site is paused", () => {
    const en = i18n.getFixedT("en");
    const texts = (fields: Partial<Status>) =>
      pageStatusLines(status(fields), en, true).map(({ text }) => text);
    expect(texts({ recipe: "page", page: { state: "denied", reason: "paused" } })).toContain(
      "No login started: automatic login is off in private windows; choose an account to log in.",
    );
    expect(
      texts({ page: { state: "denied", reason: "recipe-not-found", generationSkip: "paused" } }),
    ).toContain("Not sent to the AI: automatic login is off in private windows.");
    expect(texts({ recipe: "page", page: { notStarted: "paused" } })).toContain(
      "No login started: automatic login is off in private windows; choose an account to log in.",
    );
    // Another reason reads as in a normal window.
    expect(texts({ recipe: "page", page: { state: "denied", reason: "logged-in" } })).toContain(
      "No login started: this site is already logged in.",
    );
    expect(
      pageStatusLines(
        status({ page: { generationSkip: "paused" } }),
        i18n.getFixedT("ja"),
        true,
      ).map(({ text }) => text),
    ).toContain("AI に送信しませんでした：プライベートウィンドウでは自動ログインはオフです。");
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
    // A rule pauses the site until turned back on, also before the worker answered.
    expect(pauseShown(undefined, false, true)).toBe(true);
  });
});

describe("siteRules", () => {
  const rule = (hostname: string, includeSubdomains = false) => ({ hostname, includeSubdomains });
  it("pauses the registrable site with its subdomains, replacing a rule of that name", () => {
    const settings = { excludedSites: [rule("example.co.jp"), rule("other.example")] };
    const value = structuredClone(settings) as Parameters<ReturnType<typeof siteRules>["pause"]>[0];
    siteRules(settings, "https://login.example.co.jp").pause(value);
    expect(value.excludedSites).toEqual([rule("other.example"), rule("example.co.jp", true)]);
  });
  it("resumes by removing the covering rules within the site, and names shared ones", () => {
    const settings = {
      excludedSites: [
        rule("example.co.jp", true),
        rule("login.example.co.jp"),
        rule("mail.example.co.jp"),
        rule("co.jp", true),
      ],
    };
    const rules = siteRules(settings, "https://login.example.co.jp");
    expect(rules.rules).toEqual([
      rule("example.co.jp", true),
      rule("login.example.co.jp"),
      rule("co.jp", true),
    ]);
    // A rule for a public suffix covers other sites too.
    expect(rules.shared).toEqual([rule("co.jp", true)]);
    const value = structuredClone(settings) as Parameters<typeof rules.resume>[0];
    rules.resume(value);
    expect(value.excludedSites).toEqual([rule("mail.example.co.jp"), rule("co.jp", true)]);
  });
});
