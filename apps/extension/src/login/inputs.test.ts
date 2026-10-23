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
const select: SecretInput = { type: "select-one", inputMode: "", getAttribute: () => null };

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
    // A whole card number or a PIN (ADR 0061): a password, text, tel or number input; the
    // fill checks a declared `maxlength` against the value itself.
    ["card-number", password, true],
    ["card-number", declared, true],
    ["card-number", text, true],
    ["card-number", unboundedTel, true],
    ["card-number", number, true],
    ["card-number", input({ type: "email" }), false],
    ["card-number", input({ type: "search" }), false],
    ["pin", password, true],
    ["pin", pin, true],
    ["pin", text, true],
    ["pin", number, true],
    ["pin", input({ type: "email" }), false],
    ["pin", input({ type: "url" }), false],
    // A card's expiry date is a `detail`: no password input.
    ["detail", password, false],
    ["detail", text, true],
    [undefined, text, true],
    // A split date's part (owner, 2026-10-23 12:26 UTC) goes into a text, tel or number
    // input or a single-choice select, and no other value goes into a select.
    ["date-part", text, true],
    ["date-part", pin, true],
    ["date-part", number, true],
    ["date-part", password, false],
    ["date-part", select, true],
    ["date-part", input({ type: "select-multiple" }), false],
    ["detail", select, false],
    ["card-number", select, false],
    ["pin", select, false],
    ["password", select, false],
    ["hidden", select, false],
    ["otp", select, false],
    [undefined, select, false],
  ] as const)("%s into %o is %s", (secret, field, expected) => {
    expect(acceptsSecret(field, secret)).toBe(expected);
  });
});
