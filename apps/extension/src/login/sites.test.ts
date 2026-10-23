import { createDefaultSettings, type SettingsSnapshot } from "@pateat/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createLoginSites } from "./sites";

const { granted, contains } = vi.hoisted(() => {
  const hosts = new Set<string>();
  return {
    granted: hosts,
    contains: vi.fn(async ({ origins }: { origins: string[] }) =>
      origins.every((origin) => hosts.has(origin)),
    ),
  };
});
vi.mock("wxt/browser", () => ({ browser: { permissions: { contains } } }));

function sitesWith(change: (settings: SettingsSnapshot["settings"]) => void = () => {}) {
  const settings = createDefaultSettings();
  change(settings);
  return createLoginSites({ read: async () => ({ version: 1, revision: 1, settings }) });
}

describe("createLoginSites", () => {
  beforeEach(() => {
    granted.clear();
    granted.add("https://*/*").add("http://*/*");
    contains.mockClear();
  });

  it("admits HTTP and HTTPS pages, checking host access for the page's own scheme", async () => {
    granted.clear();
    granted.add("http://router.example/*");
    const sites = sitesWith();
    expect(await sites.admission(new URL("http://router.example:8080/login"))).toBe("admitted");
    expect(await sites.admission(new URL("https://router.example/login"))).toBe("no-site-access");
    expect(contains).toHaveBeenCalledWith({ origins: ["http://router.example/*"] });
    expect(contains).toHaveBeenCalledWith({ origins: ["https://router.example/*"] });
  });

  it("refuses other schemes and excluded sites", async () => {
    const sites = sitesWith((settings) => {
      settings.excludedSites = [{ hostname: "router.example", includeSubdomains: false }];
    });
    expect(await sites.admission(new URL("ftp://files.example/"))).toBe("not-web");
    expect(await sites.admission(new URL("http://router.example/"))).toBe("site-excluded");
  });

  it("refuses a site the allowed sites leave out while they are on, and says so (ADR 0077)", async () => {
    granted.add("https://bank.example/*").add("https://shop.example/*");
    const sites = sitesWith((settings) => {
      settings.allowedSites = [{ hostname: "bank.example", includeSubdomains: false }];
      settings.allowedSitesEnabled = true;
      settings.excludedSites = [{ hostname: "router.example", includeSubdomains: false }];
    });
    expect(await sites.admission(new URL("https://bank.example/login"))).toBe("admitted");
    expect(await sites.admission(new URL("https://shop.example/"))).toBe("site-not-allowed");
    // An exclusion is named as such even where the allowed sites also leave the site out.
    expect(await sites.admission(new URL("https://router.example/"))).toBe("site-excluded");
    const off = sitesWith((settings) => {
      settings.allowedSites = [{ hostname: "bank.example", includeSubdomains: false }];
      settings.allowedSitesEnabled = false;
    });
    expect(await off.admission(new URL("https://shop.example/"))).toBe("admitted");
  });

  it("lists no saved default whose site the allowed sites leave out", async () => {
    granted.add("https://bank.example/*").add("https://shop.example/*");
    const sites = sitesWith((settings) => {
      settings.allowedSitesEnabled = true;
      settings.siteDefaults = ["https://bank.example", "https://shop.example"].map((origin) => ({
        origin,
        provider: "dummy",
        server: "cloud-us",
        userId: "user",
        itemId: "item",
      }));
      settings.allowedSites = [{ hostname: "bank.example", includeSubdomains: false }];
    });
    expect(await sites.origins()).toEqual(["https://bank.example"]);
  });

  it("lists saved defaults of HTTP and HTTPS origins whose host access is granted", async () => {
    granted.clear();
    granted.add("http://router.example/*");
    const sites = sitesWith((settings) => {
      settings.siteDefaults = ["http://router.example", "https://login.example"].map((origin) => ({
        origin,
        provider: "dummy",
        server: "cloud-us",
        userId: "user",
        itemId: "item",
      }));
    });
    expect(await sites.origins()).toEqual(["http://router.example"]);
  });
});
