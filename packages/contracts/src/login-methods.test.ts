import { describe, expect, it } from "vitest";
import {
  LOGIN_METHOD_WHYS,
  loginMethodList,
  loginMethodSuspect,
  missedLoginMethod,
  parseLoginMethodList,
} from "./login-methods";

describe("sign-in methods (ADR 0055, amendment of 2026-11-18)", () => {
  it("lists methods in the automatic order, each once", () => {
    expect(loginMethodList(["password", "passkey"])).toBe("passkey.password");
    expect(loginMethodList(["password", "sso", "password"])).toBe("sso.password");
    expect(loginMethodList([])).toBe("none");
    expect(parseLoginMethodList("passkey.sso.password")).toEqual(["passkey", "sso", "password"]);
    expect(parseLoginMethodList("none")).toEqual([]);
    for (const value of ["password.passkey", "passkey.", "", "totp", "none.passkey"])
      expect(parseLoginMethodList(value)).toBeUndefined();
  });

  it("names a passkey or SSO method held that ranks above everything the login used", () => {
    expect(missedLoginMethod(["password", "passkey"], ["password"])).toBe("passkey");
    expect(missedLoginMethod(["passkey", "password"], [])).toBe("passkey");
    expect(missedLoginMethod(["passkey", "password"], ["password", "passkey"])).toBeUndefined();
    expect(missedLoginMethod(["sso", "password"], ["password"])).toBe("sso");
    expect(missedLoginMethod(["passkey", "sso"], ["sso"])).toBe("passkey");
    expect(missedLoginMethod(["password"], ["password"])).toBeUndefined();
    // Nothing better than the password: a login that stopped before it misses nothing.
    expect(missedLoginMethod(["password"], [])).toBeUndefined();
    // A method the item does not hold, as a passkey answered from another item, outranks it.
    expect(missedLoginMethod(["sso", "password"], ["passkey"])).toBeUndefined();
    expect(missedLoginMethod([], [])).toBeUndefined();
  });

  it("suspects every reason but the person's choice and a setting", () => {
    expect(loginMethodSuspect(undefined)).toBe(true);
    expect(
      Object.entries(LOGIN_METHOD_WHYS)
        .filter(([why]) => !loginMethodSuspect(why as keyof typeof LOGIN_METHOD_WHYS))
        .map(([why]) => why),
    ).toEqual(["picked", "fill-only", "sign-in-fill", "sso-not-automatic"]);
  });
});
