import type { LoginSecretKind } from "./wire";

/** The input attributes the secret fill rule reads. */
export type SecretInput = Pick<
  HTMLInputElement,
  "type" | "autocomplete" | "inputMode" | "maxLength"
>;

/**
 * The input's autofill tokens as the browser reads them: its `autocomplete` property,
 * which is empty when the attribute is not a valid token list (as
 * `autocomplete="one-time-code nope"`). The observation reads them so too, so it never
 * reports a hint the fill rule ignores.
 */
export function autofillTokens(input: Pick<HTMLInputElement, "autocomplete">): string[] {
  return input.autocomplete.toLowerCase().split(/\s+/u).filter(Boolean);
}
function passwordInput(input: SecretInput): boolean {
  return input.type === "password" || autofillTokens(input).includes("current-password");
}
/**
 * A short numeric field, as a code or a PIN goes in. `inputMode` is the browser's reading
 * of `inputmode`: empty for a value that is not a keyword, as `inputmode=" numeric "`.
 */
export function shortNumericInput(input: SecretInput): boolean {
  return (
    (input.inputMode === "numeric" || input.type === "tel" || input.type === "number") &&
    input.maxLength >= 1 &&
    input.maxLength <= 10
  );
}

/**
 * Secret values go only where a login form expects them, so a recipe cannot place a
 * password in a search box or comment field. A TOTP code may also use a short numeric
 * field, and a Hidden custom field may use a password input or a short numeric field
 * (for example a PIN), never a plain text input.
 */
export function acceptsSecret(input: SecretInput, secret: LoginSecretKind | undefined): boolean {
  if (secret === "password") return passwordInput(input);
  if (secret === "hidden") return passwordInput(input) || shortNumericInput(input);
  if (secret === "otp")
    return autofillTokens(input).includes("one-time-code") || shortNumericInput(input);
  return true;
}
