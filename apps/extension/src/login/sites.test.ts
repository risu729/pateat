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

  it("refuses other schemes and unsupported hostnames, and admits a site a rule pauses", async () => {
    granted.add("http://router.example/*");
    granted.add("https://my_host.example/*");
    const sites = sitesWith((settings) => {
      settings.excludedSites = [{ hostname: "router.example", includeSubdomains: false }];
    });
    expect(await sites.admission(new URL("ftp://files.example/"))).toBe("not-web");
    expect(await sites.admission(new URL("https://my_host.example/"))).toBe("unsupported-host");
    // The rule pauses automatic login there; the login runtime refuses it as paused.
    expect(await sites.admission(new URL("http://router.example/"))).toBe("admitted");
  });

  it("lists saved defaults of HTTP and HTTPS origins whose host access is granted", async () => {
    granted.clear();
    granted.add("http://router.example/*");
    const sites = sitesWith((settings) => {
      settings.siteDefaults = ["http://router.example", "https://login.example"].map((origin) => ({
        origin,
        provider: "dummy",
        userId: "user",
        itemId: "item",
      }));
    });
    expect(await sites.origins()).toEqual(["http://router.example"]);
  });
});
