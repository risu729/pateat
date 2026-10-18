import { describe, expect, it } from "vitest";
import { namesPasswordChoice } from "./password-choice";

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
