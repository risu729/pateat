import { autocompleteTokens } from "../page/targets";
import type { LoginSecretKind } from "./wire";

/** The input attributes the secret fill rule reads; `autocomplete` by its attribute. */
export type SecretInput = Pick<
  HTMLInputElement,
  "type" | "inputMode" | "maxLength" | "getAttribute"
>;

function passwordInput(input: SecretInput): boolean {
  return input.type === "password" || autocompleteTokens(input).includes("current-password");
}
/** A short numeric field, as a code or a PIN goes in. */
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
 * (for example a PIN), never a plain text input. A personal detail (ADR 0061) goes into
 * a text, tel or number input, a secret question's answer into a text or password input,
 * a card's security code into a password input or a text or tel input of 3 or 4
 * characters, and a whole card number or a PIN into a password, text, tel or number
 * input; the fill checks separately that a declared `maxlength` holds the value.
 */
export function acceptsSecret(input: SecretInput, secret: LoginSecretKind | undefined): boolean {
  if (secret === "password") return passwordInput(input);
  if (secret === "hidden") return passwordInput(input) || shortNumericInput(input);
  if (secret === "otp")
    return autocompleteTokens(input).includes("one-time-code") || shortNumericInput(input);
  if (secret === "detail") return ["text", "tel", "number"].includes(input.type);
  if (secret === "answer") return input.type === "text" || input.type === "password";
  if (secret === "card-number" || secret === "pin")
    return passwordInput(input) || ["text", "tel", "number"].includes(input.type);
  if (secret === "card-code")
    return (
      passwordInput(input) ||
      ((input.type === "text" || input.type === "tel") &&
        (input.maxLength === 3 || input.maxLength === 4))
    );
  return true;
}
