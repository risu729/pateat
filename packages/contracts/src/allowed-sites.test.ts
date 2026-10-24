import { describe, expect, it } from "vitest";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  isSiteAllowed,
  isSiteExcluded,
  parseLocalSettings,
  resolveSiteAccount,
  siteAccess,
} from "./index";

function withDefault() {
  const settings = createDefaultSettings();
  settings.siteDefaults.push({
    origin: "https://bank.example",
    provider: "dummy",
    server: "cloud-us",
    userId: "demo-personal-account",
    itemId: "primary",
  });
  return settings;
}

describe("allowed sites (ADR 0077)", () => {
  it("limits Pateat to the allowed sites only while they are on, before any pause", () => {
    const settings = withDefault();
    settings.allowedSites = [
      { hostname: "bank.example", includeSubdomains: false },
      { hostname: "mail.example", includeSubdomains: true },
    ];
    // Off by default: the list is kept but limits nothing (ADR 0077).
    expect(siteAccess(settings, "https://shop.example")).toBe("allowed");
    expect(isSiteAllowed(settings, "https://shop.example")).toBe(true);
    settings.allowedSitesEnabled = true;
    expect(siteAccess(settings, "https://bank.example/login")).toBe("allowed");
    expect(siteAccess(settings, "http://bank.example:8080")).toBe("allowed");
    expect(siteAccess(settings, "https://inbox.mail.example")).toBe("allowed");
    expect(siteAccess(settings, "https://auth.bank.example")).toBe("not-allowed");
    expect(siteAccess(settings, "https://shop.example")).toBe("not-allowed");
    expect(isSiteAllowed(settings, "https://shop.example")).toBe(false);
    // Leaving a site out is not a pause: exclusions alone pause automatic login (ADR 0062).
    expect(isSiteExcluded(settings, "https://shop.example")).toBe(false);
    expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, "https://shop.example")).toEqual({
      ok: false,
      reason: "site-not-allowed",
    });
    // An allowed site can still be paused, and a site left out is refused before its pause.
    settings.excludedSites = [
      { hostname: "bank.example", includeSubdomains: false },
      { hostname: "shop.example", includeSubdomains: false },
    ];
    expect(siteAccess(settings, "https://bank.example")).toBe("excluded");
    expect(siteAccess(settings, "https://shop.example")).toBe("not-allowed");
    // On with nothing allowed, Pateat acts nowhere.
    settings.allowedSites = [];
    expect(siteAccess(settings, "https://inbox.mail.example")).toBe("not-allowed");
    expect(siteAccess(settings, "not a url")).toBe("invalid");
    expect(isSiteAllowed(settings, "not a url")).toBe(false);
  });

  it("parses allowed sites as a list of unique rules beside an on or off switch", () => {
    const base = createDefaultSettings();
    expect(
      parseLocalSettings({ ...base, allowedSitesEnabled: true, allowedSites: [] }),
    ).toMatchObject({ allowedSitesEnabled: true, allowedSites: [] });
    expect(() =>
      parseLocalSettings({
        ...base,
        allowedSites: [
          { hostname: "bank.example", includeSubdomains: false },
          { hostname: "bank.example", includeSubdomains: true },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseLocalSettings({
        ...base,
        allowedSites: [{ hostname: "https://bank.example", includeSubdomains: false }],
      }),
    ).toThrow();
  });
});
