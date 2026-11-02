/**
 * Words, per language, of a button that goes on to typing a code from an authenticator
 * app on a page that asks how to confirm the sign-in (ADR 0081): English `authenticator`,
 * `authentication app`, `auth app` and `TOTP` as whole words, and Japanese 認証アプリ and
 * 認証システム (as in 「Google 認証システム」). Matched case-insensitively. A language is
 * added here, never a site.
 */
const authenticatorWords =
  /\b(?:authenticators?|authentication\s*apps?|auth\s*apps?|totp)\b|認証アプリ|認証システム/iu;
/**
 * Words that make such a text another way or another task: a code sent by SMS, a text
 * message, a call or email, or sent at all; a backup or recovery code; an approval or
 * push notification; a passkey, security key, built-in or platform authenticator or the
 * device's biometrics; setting up, adding, registering, enabling, changing, resetting or removing an
 * authenticator; a lost one, help, another or a different way, cancelling, and signing or
 * logging out. Latin words match whole words; Japanese ones anywhere. "Code", "app",
 * "phone" and "mobile" stay neutral: "Use code from the authenticator app on your phone"
 * names the choice.
 */
const otherWords =
  /\b(?:sms|texts?|texting|message|messages|call|calls|calling|voice|e\s*mail|email|emails|mail|send|sent|resend|backup|back\s*up|recovery|recover|scratch|push|notifications?|approve|approval|request|prompt|passkeys?|security\s*keys?|hardware|built\s*in|platform|fido|yubikey|touch\s*id|face\s*id|fingerprints?|biometrics?|windows\s*hello|set\s*up|setup|add|register|enroll|enable|disable|new|change|update|reset|remove|delete|lost|forgot|without|another|other|different|help|trouble|problem|cancel|link|magic|(?:sign|log)\s*(?:out|off))\b|ショートメッセージ|メッセージ|電話|通話|音声|メール|送信|送る|再送|バックアップ|リカバリ|復旧|予備|回復|プッシュ|通知|承認|パスキー|セキュリティキー|生体|指紋|顔|設定|登録|追加|有効|無効|変更|再設定|解除|削除|忘れ|紛失|お困り|わから|できない|別|他|キャンセル|ログアウト|サインアウト/iu;

const words = (text: string) => text.replaceAll(/[^\p{L}\p{N}]+/gu, " ");

/**
 * Whether a button's text names a code from an authenticator app as the way to confirm
 * the sign-in, such as "Authenticator app", "Use code from authenticator" or
 * 「認証アプリを使用」, and nothing else: "Text me a code", "Use backup code", "Set up an
 * authenticator app", "Use a security key" and 「別の方法を試す」 do not (ADR 0081).
 * Shared by the service, which checks the judged page's button, and the extension, which
 * checks the live button before pressing.
 */
export function namesAuthenticatorChoice(text: string): boolean {
  const spaced = words(text);
  return authenticatorWords.test(spaced) && !otherWords.test(spaced);
}

/**
 * Whether a text holds one of the words that make a button another way than the
 * authenticator app's code, the ones {@link namesAuthenticatorChoice} refuses.
 */
export function namesOtherThanAuthenticator(text: string): boolean {
  return otherWords.test(words(text));
}
