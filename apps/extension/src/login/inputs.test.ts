import { describe, expect, it } from "vitest";
import { acceptsSecret, type SecretInput } from "./inputs";

// The rule reads `autocomplete` by its attribute, as Chromium's property is empty for
// several tokens, and `inputmode` as the page's description does;
// `inputs.browser.test.ts` checks real inputs.
const input = ({
  autocomplete,
  inputMode,
  ...overrides
}: Partial<Omit<SecretInput, "getAttribute">> & {
  autocomplete?: string;
  inputMode?: string;
} = {}): SecretInput => ({
  type: "text",
  maxLength: -1,
  getAttribute: (name) =>
    name === "autocomplete"
      ? (autocomplete ?? null)
      : name === "inputmode"
        ? (inputMode ?? null)
        : null,
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
const select: SecretInput = { type: "select-one", getAttribute: () => null };

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
    // Read as the page's description reads it: trimmed, in any case.
    ["otp", input({ inputMode: " Numeric ", maxLength: 6 }), true],
    ["otp", number, true],
    ["otp", password, false],
    // A text input without a maxlength, as Supabase's code input (ADR 0027 amendment of
    // 2026-11-08).
    ["otp", text, true],
    ["otp", input({ autocomplete: "off" }), true],
    ["otp", input({ inputMode: "text" }), true],
    // An `inputmode` the page's description leaves out reads as none.
    ["otp", input({ inputMode: "kana" }), true],
    ["otp", input({ inputMode: "tel" }), false],
    ["otp", input({ inputMode: "none" }), false],
    ["otp", input({ inputMode: "email" }), false],
    ["otp", input({ autocomplete: "email" }), false],
    ["otp", input({ maxLength: 12 }), false],
    ["otp", input({ type: "email" }), false],
    ["otp", longTel, false],
    // A numeric text input without a maxlength, as HCP Cloud's code input (ADR 0027
    // amendment of 2026-11-07); never a tel input without one, as a phone number's.
    ["otp", input({ inputMode: "numeric" }), true],
    ["otp", input({ inputMode: "numeric", autocomplete: "off" }), true],
    ["otp", input({ inputMode: "numeric", autocomplete: "username" }), false],
    ["otp", input({ inputMode: "numeric", maxLength: 12 }), false],
    // A length of 0 or past 1024 the page's description leaves out, as none.
    ["otp", input({ inputMode: "numeric", maxLength: 0 }), true],
    ["otp", input({ inputMode: "numeric", maxLength: 2000 }), true],
    ["otp", unboundedTel, false],
    ["hidden", input({ inputMode: "numeric" }), false],
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
    // Never into the account's own password field (review of PR #930).
    ["card-number", declared, false],
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

  // A personal detail (ADR 0061) never goes into an input marked as a sign-in or code
  // field, as the service's check of a `detail` handler refuses one.
  it.each(["card-number", "pin", "detail", "answer", "card-code"] as const)(
    "refuses %s in a sign-in or code field",
    (secret) => {
      for (const token of [
        "username",
        "email",
        "current-password",
        "new-password",
        "one-time-code",
        "section-login username",
      ]) {
        for (const type of ["text", "tel", "number", "password"])
          expect(
            acceptsSecret(input({ type, maxLength: 4, autocomplete: token }), secret),
            `${type} ${token}`,
          ).toBe(false);
      }
      // A personal-data hint or none is no sign-in field.
      const type = secret === "answer" || secret === "card-code" ? "text" : "tel";
      expect(acceptsSecret(input({ type, maxLength: 4 }), secret)).toBe(true);
      for (const autocomplete of ["off", "tel", "bday", "cc-number"])
        expect(acceptsSecret(input({ type, maxLength: 4, autocomplete }), secret)).toBe(true);
    },
  );
});

// A personal detail (ADR 0061) goes into a text, tel or number input; a card's security
// code into a password input, or a text or tel input of 3 or 4 characters.
describe("personal-detail input rule (ADR 0061)", () => {
  it.each([
    ["detail", text, true],
    ["detail", input({ maxLength: 6 }), true],
    ["detail", pin, true],
    ["detail", unboundedTel, true],
    ["detail", number, true],
    ["detail", numeric, true],
    ["detail", password, false],
    ["detail", newPassword, false],
    ["detail", input({ type: "email" }), false],
    ["detail", input({ type: "search" }), false],
    ["card-code", password, true],
    // A text input marked as the account's password is a sign-in field, which no detail fills.
    ["card-code", declared, false],
    ["card-code", input({ maxLength: 3 }), true],
    ["card-code", input({ maxLength: 4 }), true],
    ["card-code", input({ inputMode: "numeric", maxLength: 4 }), true],
    ["card-code", input({ type: "tel", maxLength: 3 }), true],
    ["card-code", pin, true],
    ["card-code", text, false],
    ["card-code", input({ maxLength: 2 }), false],
    ["card-code", input({ maxLength: 5 }), false],
    ["card-code", unboundedTel, false],
    ["card-code", input({ type: "tel", maxLength: 6 }), false],
    ["card-code", input({ type: "number", maxLength: 4 }), false],
    ["card-code", oneTimeCode, false],
    ["card-code", input({ type: "email", maxLength: 4 }), false],
  ] as const)("%s into %o is %s", (secret, field, expected) => {
    expect(acceptsSecret(field, secret)).toBe(expected);
  });
});
