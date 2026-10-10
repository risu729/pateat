import { describe, expect, it } from "vitest";
import { acceptsSecret, type SecretInput } from "./inputs";

const input = (overrides: Partial<SecretInput> = {}): SecretInput => ({
  type: "text",
  autocomplete: "",
  inputMode: "",
  maxLength: -1,
  ...overrides,
});
const password = input({ type: "password" });
const declared = input({ autocomplete: "section-login current-password" });
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
