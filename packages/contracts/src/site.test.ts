import { describe, expect, it } from "vitest";
import { loginMoveFits } from "./site";

describe("loginMoveFits", () => {
  it("takes another HTTPS host of the registrable domain", () => {
    expect(loginMoveFits("https://ssl.pc.moppy.jp", "https://pc.moppy.jp", false)).toBe(true);
    expect(loginMoveFits("https://login.example.co.uk", "https://www.example.co.uk", false)).toBe(
      true,
    );
    expect(loginMoveFits("https://login.example", "https://login.example", false)).toBe(true);
  });

  it("refuses another registrable domain or a page that is not HTTPS", () => {
    expect(
      loginMoveFits("https://login.microsoftonline.com", "https://m365.cloud.microsoft", false),
    ).toBe(false);
    expect(loginMoveFits("https://ssl.pc.moppy.jp", "http://pc.moppy.jp", false)).toBe(false);
    expect(loginMoveFits("https://a.example.co.uk", "https://b.co.uk", false)).toBe(false);
  });

  it("keeps each name under a private suffix its own site", () => {
    expect(loginMoveFits("https://one.github.io", "https://two.github.io", false)).toBe(false);
  });

  it("compares addresses and localhost as whole hosts", () => {
    expect(loginMoveFits("https://192.0.2.1", "https://192.0.2.2", false)).toBe(false);
    expect(loginMoveFits("https://192.0.2.1", "https://192.0.2.1:8443", false)).toBe(true);
    expect(loginMoveFits("https://localhost:8443", "https://localhost:9443", false)).toBe(true);
    expect(loginMoveFits("not a url", "https://example.com", false)).toBe(false);
  });

  it("takes an HTTPS origin of any site right after a code was submitted", () => {
    expect(
      loginMoveFits("https://login.microsoftonline.com", "https://m365.cloud.microsoft", true),
    ).toBe(true);
    expect(loginMoveFits("https://login.example", "https://two.github.io", true)).toBe(true);
    expect(loginMoveFits("https://login.example", "http://www.example", true)).toBe(false);
    expect(loginMoveFits("https://login.example", "https://co.uk", true)).toBe(false);
  });
});
