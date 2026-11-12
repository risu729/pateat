import type { LoginObservation, SemanticSlot } from "@pateat/contracts";
import {
  namesPasskey,
  registersPasskey,
  validateGeneratedPage,
  validatePagePlan,
  type GeneratedPagePlan,
  type PagePlan,
} from "../../src/plan";
import { expect, it } from "vitest";
import type { PlanTestFixtures } from "../../src/plan.test";

type Generate = (
  passkeyButton: string | undefined,
  change?: Partial<GeneratedPagePlan>,
) => ReturnType<typeof validateGeneratedPage>;

export function registerPasskeyEntry({
  generate,
  page,
  fields,
  slots,
  branch,
  input,
  action,
}: {
  generate: Generate;
  page: LoginObservation;
  fields: PagePlan["fields"];
  slots: PlanTestFixtures["slots"];
  branch: PlanTestFixtures["branch"];
  input: PlanTestFixtures["input"];
  action: PlanTestFixtures["action"];
}) {
  it("keeps a sign-in button the plan does not use, with its locator", () => {
    const result = generate("passkey-login");
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan).toMatchObject({
      passkeyButton: "passkey-login",
      passkeyTarget: { by: "id", value: "passkey-login" },
    });
    // The password plan itself is unchanged.
    expect(result.plan.fields).toEqual(fields);
    const plain = validatePagePlan(page, slots, { fields, action });
    if (!plain.ok) throw new Error(plain.reason);
    expect(result.plan.steps).toEqual(plain.plan.steps);
  });

  it.each([
    ["a link", "passkey-help"],
    ["an unknown candidate", "missing"],
    ["a button whose locator reads as adding a passkey", "add-passkey"],
    ["a registration button", "register"],
    ["a field instead of a button", "password"],
    ["a button with the action's locator", "login-copy"],
  ])("drops %s and keeps the plan", (_label, candidate) => {
    const result = generate(candidate);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan).not.toHaveProperty("passkeyButton");
    expect(result.plan).not.toHaveProperty("passkeyTarget");
    expect(result.plan.fields).toEqual(fields);
  });

  it("drops the account switch and any element of an alternative set", () => {
    const withSwitch = validateGeneratedPage(
      {
        ...page,
        candidates: [
          ...page.candidates,
          input("other", { role: "button", label: "Sign in with a passkey" }),
        ],
      },
      slots,
      { fields, action, accountSwitch: "other", passkeyButton: "other" },
    );
    if (!withSwitch.ok) throw new Error(withSwitch.reason);
    expect(withSwitch.plan).toMatchObject({ accountSwitch: "other" });
    expect(withSwitch.plan).not.toHaveProperty("passkeyButton");
    const contract: SemanticSlot = { ...branch, id: "custom-4", fieldName: "契約者番号" };
    const alternative = {
      fields: [
        { slot: "custom-4", candidate: "contract" },
        { slot: "password", candidate: "password" },
      ],
      action: { candidate: "passkey-login", purpose: "submit" as const },
    };
    const varied = validateGeneratedPage(page, [...slots, contract], {
      fields,
      action,
      alternatives: [alternative],
      passkeyButton: "passkey-login",
    });
    if (!varied.ok) throw new Error(varied.reason);
    expect(varied.plan.alternatives).toHaveLength(1);
    expect(varied.plan).not.toHaveProperty("passkeyButton");
  });

  it("drops the plan's own action even when it names a passkey", () => {
    const result = generate("passkey-login", {
      action: { candidate: "passkey-login", purpose: "submit" },
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan).not.toHaveProperty("passkeyButton");
  });

  it.each([
    ["a Google sign-in button", "google"],
    ["an SSO button", "sso"],
    ["a button that names no passkey", "plain"],
  ])("drops %s, which names no passkey or security key", (_label, candidate) => {
    const result = generate(candidate);
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan).not.toHaveProperty("passkeyButton");
    expect(result.plan).not.toHaveProperty("passkeyTarget");
  });

  it("reads passkey words in the label, text and locator alike", () => {
    const button = (label: string | undefined, value: string) => ({
      label,
      target: { by: "id" as const, value },
    });
    for (const [label, value] of [
      [undefined, "passkeyLoginButtonAD"],
      ["Sign in with a passkey", "login"],
      ["Sign in with a Pass Key", "login"],
      ["Use security key", "login"],
      ["Use a SecurityKey", "login"],
      ["パスキーでログイン", "login"],
      ["セキュリティキーでログイン", "login"],
      ["生体認証でログイン", "login"],
      ["Sign in", "webauthn-login"],
      ["FIDO2", "login"],
      [undefined, "signInWithPassKey"],
      ["Use your passkeys", "login"],
      ["セキュリティーキーでログイン", "login"],
      ["Sign in", "fido-login"],
      ["Sign in", "myFido"],
      ["セキュリティキー", "login"],
      ["セキュリティキーを使用", "login"],
    ] as const)
      expect(namesPasskey(button(label, value)), `${label} ${value}`).toBe(true);
    for (const [label, value] of [
      ["Sign in with Google", "google"],
      ["Sign in with SSO", "sso"],
      ["Log in", "login"],
      ["Forgot your password?", "password-reset"],
      ["パスワードでログイン", "password"],
      [undefined, "submit"],
      // Latin words match whole words only.
      ["MyFido", "login"],
      ["Fidor Bank", "login"],
      ["Passkeyless", "login"],
      ["Sign in", "fidorBank"],
      ["Sign in", "passkeyless"],
      // A software keyboard or keypad is not a security key.
      ["Security keyboard", "login"],
      ["Sign in", "securityKeyboard"],
      ["セキュリティキーボード", "login"],
      ["セキュリティーキーボード", "login"],
      ["セキュリティキーパッド", "login"],
      ["セキュリティキーボードを使う", "login"],
    ] as const)
      expect(namesPasskey(button(label, value)), `${label} ${value}`).toBe(false);
    // A text locator reads as a label, never split inside a word.
    expect(namesPasskey({ target: { by: "text", value: "MyFido" } })).toBe(false);
    expect(namesPasskey({ target: { by: "text", value: "Sign in with a passkey" } })).toBe(true);
  });

  it("never rescues a plan that fails its own checks", () => {
    expect(
      generate("passkey-login", { action: { candidate: "passkey-help", purpose: "submit" } }),
    ).toEqual({ ok: false, reason: "incompatible-role" });
  });

  it("reads registration words in the label, text and locator alike", () => {
    const button = (label: string | undefined, value: string) => ({
      label,
      target: { by: "id" as const, value },
    });
    for (const [label, value] of [
      ["Add a passkey", "key"],
      ["Set up security key", "key"],
      ["パスキーを登録", "key"],
      ["パスキーを追加", "key"],
      ["パスキーを作成", "key"],
      ["Sign in", "addPasskey"],
      ["Sign in", "register_key"],
      ["Sign in", "set-up-key"],
      ["Create passkey", "key"],
      ["パスキーを設定", "key"],
      ["生体認証を設定する", "key"],
      ["パスキーを有効にする", "key"],
      ["パスキーを管理", "key"],
      ["Manage passkeys", "key"],
      ["Enable passkey", "key"],
      ["Turn on security key", "key"],
      ["Sign in", "managePasskeys"],
      ["Sign in", "enable-passkey"],
    ] as const)
      expect(registersPasskey(button(label, value)), `${label} ${value}`).toBe(true);
    for (const [label, value] of [
      ["Sign in with a passkey", "passkeyLoginButtonAD"],
      ["パスキーでログイン", "passkey"],
      ["Use security key", "key"],
      [undefined, "signin-passkey"],
      ["セキュリティキーでログイン", "login"],
      ["生体認証でログイン", "login"],
      ["Sign in with a passkey", "login"],
      ["パスキー（設定済みの方）でログイン", "login"],
      ["設定済みのパスキーでログイン", "login"],
      ["有効なパスキーでログイン", "login"],
    ] as const)
      expect(registersPasskey(button(label, value)), `${label} ${value}`).toBe(false);
  });
}
