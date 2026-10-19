/**
 * Words, per language, of a button that goes on to typing the account's existing
 * password on a page that asks how to confirm the sign-in (ADR 0048): English
 * `password` and `passphrase` as whole words, and Japanese パスワード. Matched
 * case-insensitively. A language is added here, never a site.
 */
const passwordWords = /\bpass\s*(?:words?|phrases?)\b|パスワード/iu;
/**
 * Words that make such a text another way or another task: recovering, resetting,
 * changing, updating, renewing or making a password, an expired, temporary, initial or
 * different one, going without one, a one-time or sent code, another channel or device,
 * a passkey or the device's biometrics or platform sign-in (Touch ID, Face ID, a
 * fingerprint, Windows Hello), registering, cancelling or another option. Latin words
 * match whole words; Japanese ones anywhere.
 */
const otherWords =
  /\b(?:forgot|forgotten|forget|reset|recover|recovery|change|update|renew|expired|create|new|different|set\s*up|setup|without|lost|remind|reminder|help|trouble|problem|one\s*time|temporary|send|sent|code|codes|sms|text|e\s*mail|email|phone|mobile|app|push|link|magic|passkeys?|security\s*keys?|touch\s*id|face\s*id|fingerprints?|biometrics?|windows\s*hello|register|sign\s*up|cancel|another|other)\b|忘れ|再設定|リセット|変更|更新|作成|登録|設定|新規|新しい|発行|仮|初期|お困り|わから|不要|なし|使わ|ワンタイム|一時|送信|送る|コード|メール|SMS|電話|携帯|アプリ|パスキー|生体|指紋|顔|キャンセル|別|他/iu;

/**
 * Whether a button's text names the password as the way to confirm the sign-in, such as
 * "Password", "Use your password" or "パスワードでログイン", and nothing else: "Forgot
 * password?", "One-time password", "Sign in without a password", "パスワードを忘れた方"
 * and "ワンタイムパスワード" do not (ADR 0048). Shared by the service, which checks the
 * judged page's button, and the extension, which checks the live button before pressing.
 */
export function namesPasswordChoice(text: string): boolean {
  const words = text.replaceAll(/[^\p{L}\p{N}]+/gu, " ");
  return passwordWords.test(words) && !otherWords.test(words);
}

/**
 * Whether a text holds one of the words that make a button another way or another task,
 * the ones {@link namesPasswordChoice} refuses: "Send code" and "Mobile" do, "Select" and
 * "Password" do not.
 */
export function namesOtherChoice(text: string): boolean {
  return otherWords.test(text.replaceAll(/[^\p{L}\p{N}]+/gu, " "));
}

/**
 * Whether a control names the password as the way to confirm the sign-in (ADR 0048 and its
 * 2026-10-19 amendment), from its accessible name (`aria-labelledby` text, else
 * `aria-label`) and its visible text, either of which may be missing. With a name, the name
 * must pass {@link namesPasswordChoice} and the visible text must hold none of the words
 * it refuses ({@link namesOtherChoice}), so a neutral "Select" named "Select Password."
 * passes and a "Send code" named "Select Password." does not. Without one, the visible
 * text must pass {@link namesPasswordChoice}, as before the amendment. The extension checks
 * the live control with it when it enters a `password` handler and again just before the
 * press.
 */
export function namesPasswordControl(name: string | undefined, text: string | undefined): boolean {
  if (name === undefined) return text !== undefined && namesPasswordChoice(text);
  return namesPasswordChoice(name) && (text === undefined || !namesOtherChoice(text));
}
