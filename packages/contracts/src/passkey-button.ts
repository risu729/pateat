import type { ObservedCandidate } from "./observation";

/**
 * Words of a button that registers, adds, sets up, turns on or manages a passkey ("Add a
 * passkey", "Set up security key", "Manage passkeys", "パスキーを登録", "パスキーを設定",
 * "パスキーを有効にする"). The model is told not to name one; this local check also refuses
 * it, and can refuse a sign-in button whose text happens to match. Latin words match whole
 * words, Japanese ones anywhere except 設定済み ("already set up") and 有効な ("valid"),
 * which describe the passkey a sign-in button uses.
 */
const registration =
  /\b(?:add|register|create|set\s*up|new|enrol?l|manage|enable|turn\s*on)\b|登録|追加|作成|設定(?!済)|有効(?!な)|管理/iu;
/**
 * A locator value as words: `addPasskey`, `register_key` and `#set-up-key` read as
 * "add Passkey", "register key" and "set up key".
 */
const words = (value: string) =>
  value.replaceAll(/([a-z])([A-Z])/gu, "$1 $2").replaceAll(/[^\p{L}\p{N}]+/gu, " ");
/** A label as words: split at anything but letters and digits, never inside a word. */
const labelWords = (value: string) => value.replaceAll(/[^\p{L}\p{N}]+/gu, " ");
/**
 * Whether a button registers, adds, creates or sets up a passkey or security key rather
 * than signing in with one (ADR 0027): its label, its text or its `id`, `name` or test ID
 * locator reads so. Shared by the generated passkey route and the judge's `passkey`
 * handler.
 */
export const registersPasskey = (button: Pick<ObservedCandidate, "label" | "target">) =>
  [button.label, button.target.value].some(
    (text) => text !== undefined && registration.test(words(text)),
  );

/**
 * Words that name a passkey, a security key or the device unlock a passkey uses ("Sign
 * in with a passkey", "Use security key", "Sign in with Face ID", "パスキーでログイン",
 * "指紋認証でログイン", `#passkeyLoginButton`), matched case-insensitively. Latin words
 * match whole words of a label, or whole camelCase, kebab or snake parts of a locator, so
 * "MyFido" or "Fidor" in a label never match, nor "Facebook" or "interface" for "Face
 * ID"; Japanese words match anywhere, except that セキュリティキー followed by more
 * katakana is another word, such as セキュリティキーボード ("security keyboard"). The
 * device unlock words were widened on 2026-10-19 by the owner ("broad is fine", ADR 0053).
 */
const passkeyWording =
  /\b(?:pass\s*keys?|security\s*keys?|webauthn|fido\d*|face\s*id|touch\s*id|windows\s*hello|biometrics?|fingerprints?|face\s*recognition)\b|パスキー|セキュリティー?\s*キー(?![\p{sc=Katakana}ー])|生体認証|指紋|顔\s*認証/iu;
/**
 * Whether a button's label, text or `id`, `name` or test ID locator names a passkey or a
 * security key (ADR 0027). The generated passkey route and a passkey-only start page (ADR
 * 0053) keep only such a button, so a mislabelled "Sign in with Google" never becomes a
 * passkey click; the judge's `passkey` handler may use it later.
 */
export const namesPasskey = (button: Pick<ObservedCandidate, "label" | "target">) =>
  (button.label !== undefined && passkeyWording.test(labelWords(button.label))) ||
  passkeyWording.test(
    button.target.by === "text" ? labelWords(button.target.value) : words(button.target.value),
  );
