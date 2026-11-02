# ADR 0081: A learned button goes on to the authenticator app's code

Status: proposed on 2026-11-02 by Claude, after the owner said on 2026-11-02 at 04:53
UTC to resume and handle what can be done on open issues, for
[#1152](https://github.com/risu729/pateat/issues/1152). Built on assumed decisions, as
the owner allowed on 2026-10-23 at 05:28 UTC; another AI reviewed the proposal
(`designs/authenticator-method-button-proposal-ja.md` in the project files) against the
code before the owner was asked. Not yet accepted by the owner. Implemented with local
tests only (unit and runtime); not checked on a real site. Amends
[ADR 0027](0027-per-account-login-routes.md) (a fifth handler kind and what the judge
may name) and follows [ADR 0048](0048-password-method-button.md), whose `password`
handler it mirrors.

Date: 2026-11-02

## Context

On 2026-10-29 and 2026-10-30, in the owner's Chrome on build `c5a0a3a`, Pateat filled
and submitted the email and password on `https://app.notion.com/login`. The site then
showed, on the same URL, "Verify your identity" with three choices: the authenticator
app ("Use code from authenticator"), "Text me a code" and "Use backup code", and no
input. After the owner chose the authenticator app, the page showed six one-digit inputs
and a disabled "Continue", and nothing was filled. The owner's vault list of 2026-10-12
holds a TOTP key on the Notion item.

The code split over six one-digit inputs is already supported (`splitCodeInputs`,
ADR 0027 owner decision of 2026-10-12 19:21 UTC). What stopped the login:

- The judge could learn only four kinds of button or field: `passkey`, `password`,
  `totp` and `detail`. None of them is a button that goes on to the authenticator app's
  code, so the choice page ended `challenge`.
- A login stopped at `challenge` is watched for 10 minutes, but its pages are only read,
  never filled or clicked, and the document the watch began in is not read again
  ([ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge)). Notion's
  code page replaces the choice in the same document.
- A page is judged once per recipe revision, path and prompt version. The choice page
  and the code page share `/login`, so the code page after the person's own choice was
  never judged and no `totp` handler could be learned.

The extension's diagnostics log in the owner's Chrome from 2026-10-29 00:02 UTC holds no
line for Notion, and the service's records were not readable on 2026-11-02, so the
judge's answer on the choice page is not known; the reasons above follow from the code.

## Decision (assumed)

1. **What the judge names.** On a `challenge` page that asks how to confirm the sign-in,
   the judge may name `authenticatorButton`: a button that goes on to typing a code from
   an authenticator app, such as "Authenticator app" or "Use code from authenticator";
   never one that sends a code by SMS, text message, call or email, uses a backup or
   recovery code, a push notification or approval, a passkey, security key or FIDO or
   built-in authenticator (that is `passkeyButton`), sets up, adds or changes an
   authenticator, tries another way or cancels, and never a link, radio button or option
   of a list. The judge's prompt version changes, so each recipe's pages are judged once
   more.
2. **The handler.** It is stored as:

   ```json
   {
     "kind": "authenticator",
     "path": "/login",
     "target": { "by": "text", "value": "Use code from authenticator" }
   }
   ```

   Its one step is a click with purpose `advance`, so it is one effect step and the page
   after it is judged under the revision that added it, which may add a `totp` handler
   on the same path. It needs the item's `totp` fact.
3. **The word list.** `namesAuthenticatorChoice` in `packages/contracts` (shared by the
   service and the extension) holds English `authenticator`, `authentication app`,
   `auth app` and `TOTP` as whole words and Japanese 認証アプリ and 認証システム. It
   refuses a text that also holds: SMS, text, message, call, voice, email, mail, send,
   sent, resend, backup, recovery, recover, scratch, push, notification, approve,
   approval, request, prompt, passkey, security key, hardware, built-in, platform, FIDO,
   YubiKey, Touch ID, Face ID, fingerprint, biometric, Windows Hello, set up, add,
   register, enroll, enable, disable, new, change, update, reset, remove, delete, lost,
   forgot, without, another, other, different, help, trouble, problem, cancel, link,
   magic, sign or log out or off; and in Japanese ショートメッセージ, メッセージ, 電話,
   通話, 音声, メール, 送信, 送る, 再送, バックアップ, リカバリ, 復旧, 予備, 回復,
   プッシュ, 通知, 承認, パスキー, セキュリティキー, 生体, 指紋, 顔, 設定, 登録, 追加,
   有効, 無効, 変更, 再設定, 解除, 削除, 忘れ, 紛失, お困り, わから, できない, 別, 他,
   キャンセル, ログアウト, サインアウト. "Code", "app", "phone" and "mobile" stay
   neutral. No word names a site ([ADR 0033](0033-no-site-specific-features.md)).
4. **Checked on the service.** `addHandler` keeps the button only when it is a button of
   the judged page whose label and text locator, whichever it has and at least one, pass
   the word list, it is no route step's element on that path and no account switch,
   rejection, signed-in marker or other handler's element, and the recipe has no
   `authenticator` handler on that path yet (`not-authenticator`, `step-target`,
   `duplicate`, `not-on-page` otherwise). It is never learned from a stop's page or
   beside the sign-in form. It is never named by its accessible name.
5. **Entering.** A login enters it after an effect step like any handler, only on the
   `password` route after its password was filled in this login, not fill-only, in the
   tab's top document on the recipe's own origin, while none of the route's fill fields
   on that path shows writable, when the item has a TOTP code the account may fill (its
   built-in TOTP or the custom field its binding names), and when the login has not
   typed a code yet (`code-used`). Its button must be a shown button or script button
   whose rendered text passes the word list and none of whose text, hidden text
   included, and accessible name holds a refused word (`authenticator-choice`); the
   content script checks it again in the click's own task (`authenticatorChoice`), and a
   button that no longer passes is not pressed (`target-missing`). When several handlers
   show, it comes after a `password`, `passkey` and `totp` handler and before a `detail`
   one, so a code field already shown is filled and a passkey button beside it is
   preferred. Pressed at most once per login: a choice page shown again ends the login
   `challenge`.
6. **After the press.** Its click is held like any handler's; the code page that
   replaces the choice is judged as after any effect step, learns a `totp` handler for
   the split or single code input, and the same login types the item's TOTP once. Later
   logins make no model call.

## Consequences

- Notion-like sites (password, then a choice of authenticator app, text message or
  backup code, then the code) can log in end to end, with two judge calls on the first
  login.
- A wrong button that passes both the judge and the word list is pressed once per login
  until the recipe is revoked in `/manage`. A press that does nothing ends `challenge`
  and is watched. A wrong press could send a text message on every login.
- A site whose choice is a radio list with a Continue button is not covered.

## Alternatives

- **Fill the code during the watch after the person's own choice.** The person presses
  the authenticator choice every time, and the watch would have to read its own document
  again, judge a path already judged and run handlers while watched, which changes the
  owner's 2026-10-12 decision that a watched login only reads.
- **Keep it as is.** The person types the code on such sites.
