import { afterEach, describe, expect, it } from "vitest";
import { acceptsSecret } from "./inputs";

afterEach(() => {
  document.body.innerHTML = "";
});

const field = (html: string) => {
  document.body.innerHTML = html;
  const input = document.querySelector("input");
  if (!input) throw new Error("no input");
  return input;
};

// Chromium's `autocomplete` property reads "" for a token list that is not a valid
// autofill detail, so the rule must read the attribute's tokens.
describe("secret input rule on Chromium inputs", () => {
  it.each([
    ["otp", '<input autocomplete="one-time-code">', true],
    ["otp", '<input inputmode="text" autocomplete="off one-time-code">', true],
    ["otp", '<input autocomplete="ONE-TIME-CODE">', true],
    ["otp", '<input autocomplete="off">', false],
    ["password", '<input autocomplete="current-password">', true],
    ["password", '<input autocomplete="username current-password">', true],
    ["password", '<input autocomplete="off one-time-code">', false],
    ["hidden", '<input autocomplete="off current-password">', true],
    ["hidden", '<input autocomplete="off one-time-code">', false],
  ] as const)("%s into %s is %s", (secret, html, expected) => {
    expect(acceptsSecret(field(html), secret)).toBe(expected);
  });
});
