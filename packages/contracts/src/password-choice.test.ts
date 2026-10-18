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
    "パスワード",
    "パスワードでログイン",
    "パスワードを入力する",
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
    "Password help",
    "パスワードを忘れた方",
    "パスワードを再設定",
    "パスワードの変更",
    "ワンタイムパスワード",
    "パスワードを使わずにログイン",
    "SMSで認証",
    "別の方法を試す",
  ])("does not name it in %s", (text) => {
    expect(namesPasswordChoice(text)).toBe(false);
  });
});
