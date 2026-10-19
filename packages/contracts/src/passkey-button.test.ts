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
