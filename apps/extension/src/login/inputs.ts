import { observedAutocompleteTokens, observedInputModes } from "@pateat/contracts";
import { autocompleteTokens } from "../page/targets";
import type { LoginSecretKind } from "./wire";

/**
 * The input attributes the secret fill rule reads; `autocomplete` and `inputmode` by their
 * attributes. A select has no `maxLength`.
 */
export type SecretInput = Pick<HTMLInputElement, "type" | "getAttribute"> & {
  readonly maxLength?: number;
};

function passwordInput(input: SecretInput): boolean {
  return input.type === "password" || autocompleteTokens(input).includes("current-password");
}
/**
 * A short numeric field, as a code or a PIN goes in. Its `inputmode` is read from the
 * attribute, trimmed and in lower case, as the page's description reads it
 * (observation/extract.ts), so the service and the fill agree on every value.
 */
export function shortNumericInput(input: SecretInput): boolean {
  const maxLength = input.maxLength ?? -1;
  const inputMode = input.getAttribute("inputmode")?.trim().toLowerCase();
  return (
    (inputMode === "numeric" || input.type === "tel" || input.type === "number") &&
    maxLength >= 1 &&
    maxLength <= 10
  );
}

/**
 * An input a code goes into as the service's `isCodeField` reads one: marked
 * `autocomplete="one-time-code"`, or a short numeric field. A page that shows one is a
 * code page (ADR 0027).
 */
export function codeInput(input: SecretInput): boolean {
  return autocompleteTokens(input).includes("one-time-code") || shortNumericInput(input);
}

/** The `autocomplete` tokens a page's description names (observation/extract.ts). */
const describedTokens: ReadonlySet<string> = new Set(observedAutocompleteTokens);

/** The `inputmode` values a page's description shows (observation/extract.ts). */
const describedInputModes: ReadonlySet<string> = new Set(observedInputModes);

/**
 * A text input whose `inputmode` the page's description shows as none, `text` or
 * `numeric`, that declares no `maxlength` (or 0 or one past 1024, which the page's
 * description leaves out too) and whose `autocomplete` names no token the page's
 * description shows, so the description shows it with none or `off`, as the service's
 * `judgedCodeInput` reads one (ADR 0027 amendments of 2026-11-07 and 2026-11-08): a
 * `totp` handler's code may go in, as HCP Cloud's "Enter your one-time code" and
 * Supabase's "Authentication code", though the page is no code page for it.
 */
function unlimitedTextInput(input: SecretInput): boolean {
  const mode = input.getAttribute("inputmode")?.trim().toLowerCase();
  return (
    input.type === "text" &&
    (mode === undefined ||
      mode === "text" ||
      mode === "numeric" ||
      !describedInputModes.has(mode)) &&
    // The description leaves out a `maxlength` of 0 or past 1024, as no limit.
    ((input.maxLength ?? -1) < 1 || (input.maxLength ?? -1) > 1024) &&
    !autocompleteTokens(input).some((token) => describedTokens.has(token))
  );
}

/** The `autocomplete` tokens that mark a sign-in or code field, which no detail fills. */
const signInTokens = ["username", "email", "current-password", "new-password", "one-time-code"];
/** The secret kinds of personal details (ADR 0061). */
const detailKinds: readonly (LoginSecretKind | undefined)[] = [
  "detail",
  "date-part",
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
 * field, or a text input that declares no `maxlength` (`unlimitedTextInput`),
 * and a Hidden custom field may use a password input or a short numeric field
 * (for example a PIN), never a plain text input. A personal detail (ADR 0061) goes into
 * a text, tel or number input, a split date's part also into a single-choice select, a
 * secret question's answer into a text or password input, a card's security code into a
 * password input or a text or tel input of 3 or 4 characters, and a whole card number or
 * a PIN, or one of their digit groups, into a password, text, tel or number input; never
 * into one whose `autocomplete` marks a sign-in or code field, as the service's check of
 * a `detail` handler refuses. No other value goes into a select. The fill checks
 * separately that a declared `maxlength` holds the value.
 */
export function acceptsSecret(input: SecretInput, secret: LoginSecretKind | undefined): boolean {
  const select = input.type.startsWith("select");
  if (select && secret !== "date-part") return false;
  if (secret === "password") return passwordInput(input);
  if (secret === "hidden") return passwordInput(input) || shortNumericInput(input);
  if (secret === "otp") return codeInput(input) || unlimitedTextInput(input);
  if (
    detailKinds.includes(secret) &&
    autocompleteTokens(input).some((token) => signInTokens.includes(token))
  )
    return false;
  if (select) return input.type === "select-one";
  if (secret === "detail" || secret === "date-part")
    return ["text", "tel", "number"].includes(input.type);
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
