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
  it("lets automatic login run only on the allowed sites while they are on", () => {
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
    // A site left out is paused, not excluded, and a pick there still resolves its default.
    expect(isSiteExcluded(settings, "https://shop.example")).toBe(false);
    const leftOut = { ...settings, allowedSites: [] };
    expect(resolveSiteAccount(leftOut, DUMMY_VAULT_CATALOG, "https://bank.example")).toEqual(
      resolveSiteAccount(withDefault(), DUMMY_VAULT_CATALOG, "https://bank.example"),
    );
    // An exclusion names the pause before the allowed sites do.
    settings.excludedSites = [
      { hostname: "bank.example", includeSubdomains: false },
      { hostname: "shop.example", includeSubdomains: false },
    ];
    expect(siteAccess(settings, "https://bank.example")).toBe("excluded");
    expect(siteAccess(settings, "https://shop.example")).toBe("excluded");
    // On with nothing allowed, every site is paused.
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
