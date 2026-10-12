import { describe, expect, it } from "vitest";
import { sameLoginSite } from "./site";

describe("sameLoginSite", () => {
  it("takes another HTTPS host of the registrable domain", () => {
    expect(sameLoginSite("https://ssl.pc.moppy.jp", "https://pc.moppy.jp")).toBe(true);
    expect(sameLoginSite("https://login.example.co.uk", "https://www.example.co.uk")).toBe(true);
    expect(sameLoginSite("https://login.example", "https://login.example")).toBe(true);
  });

  it("refuses another registrable domain or a page that is not HTTPS", () => {
    expect(sameLoginSite("https://login.microsoftonline.com", "https://m365.cloud.microsoft")).toBe(
      false,
    );
    expect(sameLoginSite("https://ssl.pc.moppy.jp", "http://pc.moppy.jp")).toBe(false);
    expect(sameLoginSite("https://a.example.co.uk", "https://b.co.uk")).toBe(false);
  });

  it("keeps each name under a private suffix its own site", () => {
    expect(sameLoginSite("https://one.github.io", "https://two.github.io")).toBe(false);
  });

  it("compares addresses and localhost as whole hosts", () => {
    expect(sameLoginSite("https://192.0.2.1", "https://192.0.2.2")).toBe(false);
    expect(sameLoginSite("https://localhost:8443", "https://localhost:9443")).toBe(true);
    expect(sameLoginSite("not a url", "https://example.com")).toBe(false);
  });
});
