import { describe, expect, it } from "vitest";
import { resolvePagePermission } from "@pateat/contracts";
import { pagePermission, signInPermission } from "./page-permission";

const odd = "https://under_score.example/signin";
const fill = { "sign-in": "fill", confirm: "fill", "personal-details": "fill" } as const;

describe("page permissions of a document (ADR 0035)", () => {
  it("keeps the profile default for a hostname no site rule can name", () => {
    expect(resolvePagePermission({}, odd, "sign-in")).toBeUndefined();
    expect(pagePermission({}, odd, "sign-in")).toEqual({ permission: "auto", source: "default" });
    expect(pagePermission({}, odd, "confirm")).toEqual({ permission: "fill", source: "default" });
    expect(pagePermission({ pagePermissionDefaults: fill }, odd, "sign-in")).toEqual({
      permission: "fill",
      source: "default",
    });
    expect(signInPermission({}, { url: odd, topUrl: odd }).permission).toBe("auto");
  });

  it("fills a frame when its own site or its tab's site says so", () => {
    const rule = (hostname: string) => ({
      sitePagePermissions: [
        { hostname, includeSubdomains: false, permissions: { "sign-in": "fill" as const } },
      ],
    });
    const frame = { url: "https://login.example/frame", topUrl: "https://portal.example/" };
    expect(signInPermission(rule("portal.example"), frame)).toMatchObject({
      permission: "fill",
      source: "site",
      hostname: "portal.example",
    });
    expect(signInPermission(rule("login.example"), frame)).toMatchObject({
      permission: "fill",
      hostname: "login.example",
    });
    expect(signInPermission(rule("other.example"), frame)).toEqual({
      permission: "auto",
      source: "default",
    });
    expect(signInPermission(rule("portal.example"), { url: frame.url })).toEqual({
      permission: "auto",
      source: "default",
    });
  });
});
