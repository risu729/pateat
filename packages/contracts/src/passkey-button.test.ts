import { describe, expect, it } from "vitest";
import { namesPasskey, registersPasskey } from "./passkey-button";

const labelled = (label: string, value = "login") => ({
  label,
  target: { by: "id" as const, value },
});

describe("device unlock words of a passkey button (ADR 0053, owner 2026-10-19)", () => {
  it.each([
    "生体認証でログイン",
    "指紋認証でログイン",
    "指紋でログイン",
    "顔認証でログイン",
    "顔 認証でサインイン",
    "Face IDでログイン",
    "Sign in with Face ID",
    "Use Touch ID",
    "Sign in with Windows Hello",
    "Biometric sign-in",
    "Use biometrics",
    "Log in with your fingerprint",
    "Sign in with face recognition",
  ])("names a passkey: %s", (label) => {
    expect(namesPasskey(labelled(label))).toBe(true);
    expect(registersPasskey(labelled(label))).toBe(false);
  });

  it.each([
    [undefined, "faceIdLogin"],
    [undefined, "touch-id-button"],
    [undefined, "windows_hello"],
    [undefined, "biometricLogin"],
  ] as const)("reads them in a locator: %s %s", (label, value) => {
    expect(namesPasskey({ label, target: { by: "id", value } })).toBe(true);
  });

  it.each([
    "Continue with Facebook",
    "Sign in with Facebook",
    "Switch to the new interface",
    "Your face here",
    "Touch here to continue",
    "Hello",
    "Windows",
    "顔写真をアップロード",
  ])("never matches inside or beside another word: %s", (label) => {
    expect(namesPasskey(labelled(label))).toBe(false);
  });

  it.each([
    "Touch ID を登録",
    "Touch IDを登録",
    "Set up Windows Hello",
    "Add a fingerprint",
    "Enable Face ID",
    "Turn on biometrics",
    "指紋認証を設定する",
    "顔認証を有効にする",
    "生体認証を追加",
  ])("still refuses a registration button: %s", (label) => {
    expect(namesPasskey(labelled(label))).toBe(true);
    expect(registersPasskey(labelled(label))).toBe(true);
  });
});

describe("buttons inside shadow hosts (ADR 0070)", () => {
  it("refuses a button inside a host that registers a passkey", () => {
    const inside = (host: string) => ({
      label: undefined,
      target: { by: "id" as const, value: "button", within: [{ by: "id" as const, value: host }] },
    });
    // A host that registers refuses its buttons; one that names a passkey makes none of
    // them a passkey button, as it may hold "Cancel" too.
    expect(registersPasskey(inside("register-passkey"))).toBe(true);
    expect(registersPasskey(inside("passkey-login"))).toBe(false);
    expect(namesPasskey(inside("passkey-login"))).toBe(false);
  });
});

describe("recovery links beside a passkey button (Logi ID, 2026-11-07, #1375)", () => {
  it.each([
    "パスキーを忘れた場合",
    "パスキーを紛失した場合",
    "パスキーを使用できない場合",
    "パスキーが使えない場合",
    "パスキーでお困りの方",
    "セキュリティキーをリセット",
    "Forgot your passkey?",
    "Forgotten passkey",
    "Lost your security key?",
    "Can't use your passkey?",
    "Cannot use a passkey",
    "Unable to use your passkey?",
    "Trouble with your passkey?",
    "Reset passkey",
    "Passkey recovery",
    "Recover your passkey",
    "Forget this passkey",
    "Can\u2019t use your passkey?",
    "Cant use passkey",
    "Can not use a passkey",
    "Don't have your passkey?",
    "Passkey not working?",
    "Need help with your passkey?",
    "Troubleshoot passkey",
    "Learn more about passkeys",
    "What is a passkey?",
    "パスキーを復旧",
    "パスキーが使えません",
    "パスキーをご利用できません",
    "パスキーをお持ちでない方",
    "パスキーをなくした場合",
    "パスキーとは",
    "パスキーについて詳しく",
  ])("refuses a link that recovers a passkey: %s", (label) => {
    expect(namesPasskey(labelled(label))).toBe(true);
    expect(registersPasskey(labelled(label))).toBe(true);
  });

  it.each([
    "🔑 パスキーを使用してログイン",
    "パスキーでログイン",
    "Sign in with a passkey",
    "Use your security key",
  ])("keeps the sign-in button: %s", (label) => {
    expect(registersPasskey(labelled(label))).toBe(false);
  });

  it.each([
    ["forgotPasskey", true],
    ["lost-passkey", true],
    ["resetPasskey", true],
    ["cantUsePasskey", true],
    ["CANT_USE_PASSKEY", true],
    ["btn-passkey-help", true],
    ["passkeyLoginCanTouch", false],
    ["passkeyLogin", false],
  ] as const)("reads them in a locator: %s", (value, refused) => {
    expect(registersPasskey({ label: undefined, target: { by: "id", value } })).toBe(refused);
  });
});
