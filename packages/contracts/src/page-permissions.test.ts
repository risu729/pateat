import * as v from "valibot";
import { describe, expect, it } from "vitest";
import {
  createDefaultSettings,
  DEFAULT_PAGE_PERMISSIONS,
  getPagePermissionDefaults,
  pagePermissionDefaultsSchema,
  pagePermissionDocument,
  parseLocalSettings,
  resolvePagePermission,
  sitePagePermissionsSchema,
  type PagePermissionResolution,
  type SitePagePermission,
} from "./settings";

const row = (
  hostname: string,
  permissions: SitePagePermission["permissions"] = { confirm: "off" },
  includeSubdomains = true,
): SitePagePermission => ({ hostname, includeSubdomains, permissions });

describe("page permission contracts", () => {
  it("keeps optional fields absent and copies complete decided defaults", () => {
    const settings = createDefaultSettings();
    expect(settings).not.toHaveProperty("pagePermissionDefaults");
    expect(settings).not.toHaveProperty("sitePagePermissions");
    expect(getPagePermissionDefaults(settings)).toEqual({
      "sign-in": "auto",
      confirm: "fill",
      "personal-details": "fill",
    });
    const copy = getPagePermissionDefaults(settings);
    copy.confirm = "off";
    expect(getPagePermissionDefaults(settings).confirm).toBe("fill");
    expect(Object.isFrozen(DEFAULT_PAGE_PERMISSIONS)).toBe(true);
    expect(
      pagePermissionDocument({
        pagePermissionDefaults: { ...DEFAULT_PAGE_PERMISSIONS },
        sitePagePermissions: [],
      }),
    ).toEqual({});
    const changed = { "sign-in": "fill", confirm: "off", "personal-details": "fill" } as const;
    const sites = [row("example.com")];
    expect(
      pagePermissionDocument({ pagePermissionDefaults: changed, sitePagePermissions: sites }),
    ).toEqual({ pagePermissionDefaults: changed, sitePagePermissions: sites });
    expect(
      parseLocalSettings({
        ...settings,
        pagePermissionDefaults: changed,
        sitePagePermissions: sites,
      }),
    ).toMatchObject({ pagePermissionDefaults: changed, sitePagePermissions: sites });
  });

  it.each([
    {},
    { "sign-in": "fill" },
    { ...DEFAULT_PAGE_PERMISSIONS, confirm: "auto" },
    { ...DEFAULT_PAGE_PERMISSIONS, "sign-in": "off" },
    { ...DEFAULT_PAGE_PERMISSIONS, "personal-details": "auto" },
    { ...DEFAULT_PAGE_PERMISSIONS, unknown: "off" },
    null,
  ])("requires every kind with only its permitted values: %j", (defaults) => {
    expect(v.safeParse(pagePermissionDefaultsSchema, defaults).success).toBe(false);
    expect(() =>
      parseLocalSettings({ ...createDefaultSettings(), pagePermissionDefaults: defaults }),
    ).toThrow();
  });

  it.each([
    row("example.com", {}),
    row("example.com", { confirm: undefined }),
    { ...row("example.com"), permissions: { confirm: "auto" } },
    { ...row("example.com"), permissions: { "sign-in": "off" } },
    { ...row("example.com"), permissions: { "personal-details": "auto" } },
    { ...row("example.com"), permissions: { confirm: "off", unknown: "fill" } },
    { ...row("example.com"), includeSubdomains: "true" },
    ...[
      "Example.com",
      "example.com.",
      "例え.テスト",
      "https://example.com",
      "example.com:443",
      "*.example.com",
      "bad..example",
      "[2001:0db8::1]",
    ].map((host) => row(host)),
  ])("rejects invalid or noncanonical site rows: %j", (site) => {
    expect(v.safeParse(sitePagePermissionsSchema, [site]).success).toBe(false);
    expect(() =>
      parseLocalSettings({ ...createDefaultSettings(), sitePagePermissions: [site] }),
    ).toThrow();
  });

  it("accepts canonical IDN and IP hosts, one row per hostname, at most 1000", () => {
    const sites = [row("xn--r8jz45g.xn--zckzah"), row("127.0.0.1"), row("[2001:db8::1]")];
    expect(v.parse(sitePagePermissionsSchema, sites)).toEqual(sites);
    expect(
      v.safeParse(sitePagePermissionsSchema, [
        row("example.com"),
        row("example.com", { "sign-in": "fill" }, false),
      ]).success,
    ).toBe(false);
    const limit = Array.from({ length: 1000 }, (_, index) => row(`h${index}.example.com`));
    expect(v.safeParse(sitePagePermissionsSchema, limit).success).toBe(true);
    expect(
      v.safeParse(sitePagePermissionsSchema, [...limit, row("extra.example.com")]).success,
    ).toBe(false);
  });
});

describe("page permission resolution", () => {
  it("selects the longest covering hostname separately for each kind, regardless of order", () => {
    const sites = [
      row("example.com", { "sign-in": "fill", confirm: "off" }),
      row("login.example.com", { confirm: "fill" }),
      row("deep.login.example.com", { "personal-details": "off" }, false),
    ];
    for (const sitePagePermissions of [sites, [...sites].reverse()]) {
      const settings = { sitePagePermissions };
      const url = "https://deep.login.example.com/verify";
      expect(resolvePagePermission(settings, url, "sign-in")).toEqual({
        permission: "fill",
        source: "site",
        hostname: "example.com",
      });
      expect(resolvePagePermission(settings, url, "confirm")).toEqual({
        permission: "fill",
        source: "site",
        hostname: "login.example.com",
      });
      expect(resolvePagePermission(settings, url, "personal-details")).toEqual({
        permission: "off",
        source: "site",
        hostname: "deep.login.example.com",
      });
      expect(
        resolvePagePermission(settings, "https://child.deep.login.example.com", "personal-details"),
      ).toEqual({ permission: "fill", source: "default" });
    }
  });

  it("uses profile defaults without crossing host labels or identity providers", () => {
    const settings = {
      pagePermissionDefaults: {
        "sign-in": "fill",
        confirm: "off",
        "personal-details": "off",
      } as const,
      sitePagePermissions: [row("example.com", { confirm: "fill" })],
    };
    for (const url of [
      "https://example.com.evil.test",
      "https://notexample.com",
      "https://accounts.google.com",
      "https://example.net",
    ]) {
      expect(resolvePagePermission(settings, url, "confirm")).toEqual({
        permission: "off",
        source: "default",
      });
    }
    expect(
      resolvePagePermission(
        { sitePagePermissions: [row("example.com", { confirm: "off" }, false)] },
        "https://child.example.com",
        "confirm",
      ),
    ).toEqual({ permission: "fill", source: "default" });
    const decision: PagePermissionResolution<"sign-in"> | undefined = resolvePagePermission(
      {},
      "https://example.com",
      "sign-in",
    );
    expect(decision).toEqual({ permission: "auto", source: "default" });
  });

  it.each([
    ["https://EXAMPLE.COM.:443/path", "example.com"],
    ["http://例え.テスト/path", "xn--r8jz45g.xn--zckzah"],
    ["http://127.1/path", "127.0.0.1"],
    ["https://[2001:0db8::1]:8443/path", "[2001:db8::1]"],
  ])("normalizes a valid page URL %s", (url, hostname) => {
    expect(resolvePagePermission({ sitePagePermissions: [row(hostname)] }, url, "confirm")).toEqual(
      { permission: "off", source: "site", hostname },
    );
  });

  it.each([
    "",
    "example.com",
    "//example.com",
    "ftp://example.com",
    "https:example.com",
    "https:///example.com",
    "https://user:pass@example.com",
    "https://@example.com",
    "https://example.com\\evil",
    "https://example.com/a b",
    "https://bad..example",
    "https://[invalid]",
    "javascript:alert(1)",
  ])("has no permission decision for invalid policy URL %s", (url) => {
    expect(resolvePagePermission({}, url, "sign-in")).toBeUndefined();
    expect(
      resolvePagePermission({ sitePagePermissions: [row("example.com")] }, url, "confirm"),
    ).toBeUndefined();
  });
});
