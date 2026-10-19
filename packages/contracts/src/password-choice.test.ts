import { describe, expect, it } from "vitest";
import { namesOtherChoice, namesPasswordChoice, namesPasswordControl } from "./password-choice";

describe("a button that goes on to the password (ADR 0048)", () => {
  it.each([
    "Password",
    "PASSWORD",
    "Use your password",
    "Sign in with password",
    "Continue with a passphrase",
    "Enter password",
    "Use password instead",
    "Continue with password",
    "Password sign-in",
    "パスワード",
    "パスワードでログイン",
    "パスワードを入力する",
    "パスワードで続ける",
    "パスワードを使用",
  ])("names the password choice in %s", (text) => {
    expect(namesPasswordChoice(text)).toBe(true);
  });

  it.each([
    "Mobile",
    "Try another way",
    "Cancel",
    "Forgot password?",
    "Forgot your password",
    "Reset password",
    "Change password",
    "Create a password",
    "Set up a new password",
    "Sign in without a password",
    "Passwordless sign-in",
    "One-time password",
    "Send me a temporary password",
    "Text me a code",
    "Email me a password",
    "Use a passkey instead of a password",
    "Use another password",
    "Use a different password",
    "Update password",
    "Renew password",
    "Password expired",
    "Your password has expired",
    "Use Touch ID or password",
    "Use Face ID or password",
    "Sign in with Windows Hello or password",
    "Use fingerprint or password",
    "Use biometrics or password",
    "Password help",
    "パスワードを忘れた方",
    "パスワードを再設定",
    "パスワードの変更",
    "パスワードの更新",
    "仮パスワードでログイン",
    "初期パスワードでログイン",
    "生体認証またはパスワード",
    "指紋またはパスワードでログイン",
    "顔認証またはパスワード",
    "ワンタイムパスワード",
    "パスワードを使わずにログイン",
    "SMSで認証",
    "別の方法を試す",
  ])("does not name it in %s", (text) => {
    expect(namesPasswordChoice(text)).toBe(false);
  });
});

describe("a control named apart from its text (ADR 0048 amendment of 2026-10-19)", () => {
  it("finds the refused words alone in a visible text", () => {
    for (const text of ["Send code", "Mobile", "Use another way", "コードを送信"])
      expect(namesOtherChoice(text)).toBe(true);
    for (const text of ["Select", "Password", "Continue", "選択"])
      expect(namesOtherChoice(text)).toBe(false);
  });

  it("takes a neutral text whose accessible name names the password", () => {
    expect(namesPasswordControl("Select Password.", "Select")).toBe(true);
    expect(namesPasswordControl("Select Password.", undefined)).toBe(true);
    expect(namesPasswordControl("パスワードを選択", "選択")).toBe(true);
  });

  it("refuses a visible text with a refused word, whatever the name says", () => {
    expect(namesPasswordControl("Select Password.", "Send code")).toBe(false);
    expect(namesPasswordControl("Select Password.", "Mobile")).toBe(false);
  });

  it("refuses a name that does not name the password, whatever the text says", () => {
    expect(namesPasswordControl("Select Phone", "Select")).toBe(false);
    expect(namesPasswordControl("Continue", "Password")).toBe(false);
  });

  it("keeps the visible text's own rule for a control without a name", () => {
    expect(namesPasswordControl(undefined, "Password")).toBe(true);
    expect(namesPasswordControl(undefined, "Select")).toBe(false);
    expect(namesPasswordControl(undefined, undefined)).toBe(false);
  });
});
