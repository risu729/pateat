import { describe, expect, it } from "vitest";
import { acceptsSecret, type SecretInput } from "./inputs";

// The rule reads `autocomplete` by its attribute, as Chromium's property is empty for
// several tokens; `inputs.browser.test.ts` checks real inputs.
const input = ({
  autocomplete,
  ...overrides
}: Partial<Omit<SecretInput, "getAttribute">> & { autocomplete?: string } = {}): SecretInput => ({
  type: "text",
  inputMode: "",
  maxLength: -1,
  getAttribute: (name) => (name === "autocomplete" ? (autocomplete ?? null) : null),
  ...overrides,
});
const password = input({ type: "password" });
const declared = input({ autocomplete: "section-login current-password" });
// A sign-in form may mark its only password field so; the plan check decides (ADR 0018).
const newPassword = input({ type: "password", autocomplete: "new-password" });
const pin = input({ type: "tel", maxLength: 4 });
const numeric = input({ inputMode: "numeric", maxLength: 6 });
const number = input({ type: "number", maxLength: 10 });
const oneTimeCode = input({ autocomplete: "one-time-code" });
const text = input();
const longTel = input({ type: "tel", maxLength: 11 });
const unboundedTel = input({ type: "tel" });

describe("secret input rule", () => {
  it.each([
    ["password", password, true],
    ["password", declared, true],
    ["password", newPassword, true],
    ["password", pin, false],
    ["password", oneTimeCode, false],
    ["password", text, false],
    ["otp", oneTimeCode, true],
    ["otp", pin, true],
    ["otp", numeric, true],
    ["otp", number, true],
    ["otp", password, false],
    ["otp", text, false],
    ["otp", longTel, false],
    ["hidden", password, true],
    ["hidden", declared, true],
    ["hidden", newPassword, true],
    ["hidden", pin, true],
    ["hidden", numeric, true],
    ["hidden", number, true],
    ["hidden", text, false],
    ["hidden", oneTimeCode, false],
    ["hidden", longTel, false],
    ["hidden", unboundedTel, false],
    [undefined, text, true],
  ] as const)("%s into %o is %s", (secret, field, expected) => {
    expect(acceptsSecret(field, secret)).toBe(expected);
  });
});
