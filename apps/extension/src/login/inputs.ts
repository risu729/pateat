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

/** The `autocomplete` tokens that mark a sign-in or code field, which no detail fills. */
const signInTokens = ["username", "email", "current-password", "new-password", "one-time-code"];
/** The secret kinds of personal details (ADR 0061). */
const detailKinds: readonly (LoginSecretKind | undefined)[] = [
  "detail",
  "answer",
  "card-code",
  "card-number",
  "pin",
];

/**
 * Whether a value is one the page shows masked: a password, a Hidden field's, or a card's
 * code, number or PIN. Beside one, any consistent masked account the page shows counts as
 * the login item's (`showsOtherAccount`).
 */
export function maskedSecret(secret: LoginSecretKind | undefined): boolean {
  return (
    secret === "password" ||
    secret === "hidden" ||
    secret === "card-code" ||
    secret === "card-number" ||
    secret === "pin"
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
 * input; never into one whose `autocomplete` marks a sign-in or code field, as the
 * service's check of a `detail` handler refuses. The fill checks separately that a
 * declared `maxlength` holds the value.
 */
export function acceptsSecret(input: SecretInput, secret: LoginSecretKind | undefined): boolean {
  if (secret === "password") return passwordInput(input);
  if (secret === "hidden") return passwordInput(input) || shortNumericInput(input);
  if (secret === "otp")
    return autocompleteTokens(input).includes("one-time-code") || shortNumericInput(input);
  if (
    detailKinds.includes(secret) &&
    autocompleteTokens(input).some((token) => signInTokens.includes(token))
  )
    return false;
  if (secret === "detail") return ["text", "tel", "number"].includes(input.type);
  if (secret === "answer") return input.type === "text" || input.type === "password";
  if (secret === "card-number" || secret === "pin")
    return ["password", "text", "tel", "number"].includes(input.type);
  if (secret === "card-code")
    return (
      input.type === "password" ||
      ((input.type === "text" || input.type === "tel") &&
        (input.maxLength === 3 || input.maxLength === 4))
    );
  return true;
}
