import type { LoginSecretKind } from "./wire";

/** The input attributes the secret fill rule reads. */
export type SecretInput = Pick<
  HTMLInputElement,
  "type" | "autocomplete" | "inputMode" | "maxLength"
>;

function tokens(input: SecretInput): string[] {
  return input.autocomplete.toLowerCase().split(/\s+/u);
}
function passwordInput(input: SecretInput): boolean {
  return input.type === "password" || tokens(input).includes("current-password");
}
function shortNumericInput(input: SecretInput): boolean {
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
  if (secret === "otp") return tokens(input).includes("one-time-code") || shortNumericInput(input);
  return true;
}
