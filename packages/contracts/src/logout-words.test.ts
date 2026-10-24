import { describe, expect, it } from "vitest";
import { logoutRisk, safeLogoutName } from "./logout-words";

// ADR 0063: the names an account switch's logout never clicks.
describe("logout risks", () => {
  it.each([
    "Log out",
    "Sign out and use another account",
    "ログアウト",
    "Account",
    "Sign out of Synthetic Shop",
    "安全にログアウト",
  ])("reads %s as no risk", (name) => {
    expect(logoutRisk(name)).toBeUndefined();
  });

  it.each([
    "Log out of other devices",
    "Sign out of all other sessions",
    "Sign out everywhere else",
    "Sign out of all devices",
    "Log out everywhere",
    "Sign out of every session",
    "Sign out other accounts",
    "このデバイス以外からログアウト",
    "すべてのデバイスからログアウト",
    "全てのセッションからログアウト",
    "全端末からログアウト",
  ])("reads %s as a logout elsewhere", (name) => {
    expect(logoutRisk(name)).toBe("elsewhere");
  });

  it.each([
    "Delete account",
    "Log out and delete my data",
    "Deactivate",
    "Close account",
    "Remove this account",
    "Cancel my membership",
    "アカウントを削除",
    "退会する",
    "解約",
    "ログアウトして退会",
  ])("reads %s as destructive", (name) => {
    expect(logoutRisk(name)).toBe("destructive");
  });

  it("lets a menu say all, but never a logout or a confirmation", () => {
    expect(safeLogoutName("All services", "menu")).toBe(true);
    expect(safeLogoutName("Sign out of all devices", "logout")).toBe(false);
    expect(safeLogoutName("Yes, sign out everywhere", "confirm")).toBe(false);
    expect(safeLogoutName("Delete account", "menu")).toBe(false);
    expect(safeLogoutName("Sign out", "logout")).toBe(true);
  });
});
