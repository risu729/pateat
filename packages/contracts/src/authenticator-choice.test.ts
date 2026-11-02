import { describe, expect, it } from "vitest";
import { namesAuthenticatorChoice, namesOtherThanAuthenticator } from "./authenticator-choice";

describe("a button that goes on to an authenticator app's code (ADR 0081)", () => {
  it.each([
    "Authenticator app",
    "AUTHENTICATOR APP",
    "Use code from authenticator",
    "Authenticator app Use code from authenticator",
    "Use your authenticator app",
    "Use a verification code from Microsoft Authenticator",
    "Use an authentication app",
    "Enter a code from your auth app",
    "TOTP",
    "Use code from the authenticator app on your phone",
    "認証アプリ",
    "認証アプリを使用",
    "認証アプリのコードを入力",
    "Google 認証システム アプリから確認コードを取得する",
  ])("names the authenticator choice in %s", (text) => {
    expect(namesAuthenticatorChoice(text)).toBe(true);
  });

  it.each([
    "Text me a code",
    "Send a code by SMS",
    "Call me",
    "Email me a code",
    "Use backup code",
    "Use a recovery code",
    "Approve a request on my authenticator app",
    "Send a push notification to the authenticator",
    "Use a passkey",
    "Use a security key or authenticator",
    "Use a FIDO2 authenticator",
    "WebAuthn authenticator",
    "Use a roaming authenticator",
    "Microsoft Authenticator",
    "Sign in with Authenticator",
    "Number matching in Authenticator app",
    "Use Windows Hello",
    "Set up an authenticator app",
    "Add an authenticator",
    "Lost your authenticator?",
    "Try another way",
    "Use a different method",
    "Cancel",
    "Log out",
    "Password",
    "Use code",
    "認証アプリを設定",
    "SMS で認証",
    "別の方法を試す",
    "その他の方法",
    "バックアップコードを使用",
    "パスキー",
  ])("does not name it in %s", (text) => {
    expect(namesAuthenticatorChoice(text)).toBe(false);
  });

  it("tells another way's words apart from neutral ones", () => {
    expect(namesOtherThanAuthenticator("Text me a code")).toBe(true);
    expect(namesOtherThanAuthenticator("Select")).toBe(false);
    expect(namesOtherThanAuthenticator("Use code from your app")).toBe(false);
  });
});
