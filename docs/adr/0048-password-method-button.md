# ADR 0048: A learned button goes on to the password on a page that asks how to verify

Status: accepted by the owner on 2026-10-18 at 01:38 UTC, on a decision card that chose
option B of the proposal `designs/method-choice-after-identifier-proposal-ja.md` in the
project files, 「判定 AI がパスワードへ進むボタンを覚える」 (the judge
learns a button that goes on to the password). The proposal was reviewed twice against
the code by another AI before it was put to the owner. The owner was not asked the
proposal's second question separately, so passkey buttons stay as they are (see
[Unchanged](#unchanged)). Implemented (local tests only; not yet checked on a real
site). Amends [ADR 0027](0027-per-account-login-routes.md) (a third handler
kind, what the judge may name, and the order of handlers shown together) and
[ADR 0018](0018-recipe-generation-route.md) (a continuation after that handler's click).

Date: 2026-10-18

## Context

On 2026-10-17 at 01:33 UTC, in the owner's Chrome on build `d29951d`, Pateat tried
UniSuper (`member.id.unisuper.com.au`). Its generated recipe (revision 1) filled the
username and clicked Next (`advance`). The next page, on the same path, was "Let's
confirm it's you": no inputs, a "Password" button and a "Mobile" button, and the links
Cancel and "Protect your account". The judge answered `unclear`, and the login ended
there; since [#571](https://github.com/risu729/pateat/pull/571) such an end is
undecided (yellow "!", no saved default account). The owner pressed "Password"
themselves.

Before this ADR the code stopped there because:

- The page after a recipe's final `advance` is sent to be continued only when it shows a
  password or identifier input ([ADR 0018](0018-recipe-generation-route.md)'s
  `continueOn`).
- [ADR 0031](0031-sign-in-entry-pages.md) presses a same-site `<a href>` sign-in entry
  only on a page without a recipe; it never presses a button.
- The judge could learn only two kinds of button or field (handlers): a `passkey`
  button and a `totp` code field ([ADR 0027](0027-per-account-login-routes.md)).

Every option adds a button that Pateat presses without the person.

## Decision

The owner chose option B. Its points, as the proposal put them:

1. The judge, which already sees this page, may answer `challenge` with a new
   `passwordButton`: a button that goes on to typing the password. It is stored like
   `passkeyButton`, as a recipe handler of the same kind of treatment as the `passkey`
   handler.
2. The handler is pressed only when its button shows, at most once per login. When the
   site skips the page and shows the password field directly, it is not pressed and the
   login goes on.
3. When the page after the press shows a password field, that page is sent to
   generation as a continuation ([ADR 0018](0018-recipe-generation-route.md)). The
   continuation did not handle the page after a handler before; it does now.
4. Three guards against pressing the wrong button:
   - The judge's instructions say not to name Mobile, a push notification, SMS, sending
     a code, "Forgot password", "Try another way", Cancel or a link.
   - The extension checks the button's text against a per-language list of password
     words and does not press it otherwise, as the service already recognises
     passkey-registration buttons by words. A per-language word list is not a
     site-specific feature under [ADR 0033](0033-no-site-specific-features.md).
   - A press that does nothing, or that leads to a push or code page, ends `challenge`
     and is watched for 10 minutes like today's handlers
     ([ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge)).
5. It is pressed only on the login's own origin, in its own tab and top document. It
   is not pressed by a login that only fills
   ([ADR 0021](0021-account-choice-outside-settings.md) D after a logout, and the
   `fill` mode of [ADR 0035](0035-page-kinds-per-site.md) once that is built). No code
   names a site.
6. Cost: the judge's instructions change, so each recipe's pages are judged once more
   under the new prompt version, and such a site makes one more continuation
   generation call. Paid runs within $5 a day are allowed.
7. Accepted weakness: the button is stored when the judge answers, not after a press
   shows that it works. A wrong button that passes the word list stays until the recipe
   is revoked in `/manage`.

### How it is built

These follow from the decision and the existing handler rules; Claude chose them, and
the owner has not confirmed them separately.

- **Shape.** A `password` handler is `{ kind: "password", path, target }`, a button
  locator, like a `passkey` handler. Its one step is a click with purpose `advance`, so
  it counts as one effect step and grows the attempt's budget by one submission. It
  needs the item's `password` fact.
- **What the judge names.** The judge's output schema gains an optional
  `passwordButton` on `challenge`. Its instructions say a page that asks how to confirm
  the sign-in, such as with the password or a phone, is a `challenge`, and that
  `passwordButton` is a button that goes on to typing the account's existing password,
  never one that uses a phone, a push notification, SMS, email, an app or a passkey,
  sends or enters a code, makes, resets or changes a password, says "Forgot password",
  tries another way or cancels, and never a link; nor one that uses the device's
  biometrics or platform sign-in, such as Touch ID, Face ID, a fingerprint or Windows
  Hello, even when its label also names the password. A named element that is not a
  button of the page adds nothing. The judge's prompt version changes. The stop's prompt
  ([ADR 0036](0036-passkey-after-the-identifier.md)) keeps only a `passkey` handler, so
  a `passwordButton` from a stop's page is logged and dropped.
- **Checked on the service.** `addHandler` keeps the button only when it is a button of
  the judged page, its label and its text locator (whichever it has, at least one) both
  name a password choice by the word list below, it is no route step's element on that
  path, no account switch, rejection, signed-in marker or other handler's element, the
  recipe has no `password` handler on that path yet, and no step of any password
  variant fills the `password` slot. A recipe that already types the password has
  passed the page that asks for it, so a "Use password instead" button on a later
  second-factor page is never learned. The log `Judged page handlers` names the kind
  and the refusal (`not-password`, `password-filled`, `step-target`, `duplicate`,
  `not-on-page`, `origin-mismatch`, `invalid-recipe`, or `stop` for a stop's page).
- **The word list.** `namesPasswordChoice` in `packages/contracts` (shared by the
  service and the extension) holds the words per language: English (`password`,
  `passphrase`, as whole words) and Japanese (パスワード). It refuses text that also
  reads as another way or another task: forgot, reset, change, update, renew, expired,
  create, new, different, set up, without, one-time, temporary, send, code, SMS, text,
  email, phone, mobile, app, push, link, passkey, security key, Touch ID, Face ID,
  fingerprint, biometric, Windows Hello, register, sign up, cancel, another or other,
  help or trouble, and in Japanese 忘れ, 再設定, リセット, 変更, 更新, 作成, 登録, 設定,
  新規, 新しい, 発行, 仮, 初期, お困り, わから, 不要, なし, 使わ, ワンタイム, 一時,
  送信, 送る, コード, メール, SMS, 電話, 携帯, アプリ, パスキー, 生体, 指紋, 顔,
  キャンセル, 別, 他. So "Password", "Use your password", "パスワードでログイン"
  qualify; "Forgot password?", "One-time password", "Sign in without a password", "Use
  Touch ID or password", "Update password", "パスワードを忘れた方",
  "仮パスワードでログイン" and "ワンタイムパスワード" do not: a button that offers a
  biometric or platform sign-in beside the password is left to the person. Other
  languages are added to the same list, never per site.
- **Entering.** A `password` handler is entered after an effect step like any handler,
  only by a login on the `password` route without a stop (ADR 0036), that is not
  fill-only, in the tab's top document on the recipe's own origin, and that has not
  filled its password yet in this login. Its button must be shown and its rendered
  text, read by the content script at that moment (`password-choice`), must pass the
  word list; a button that fails is not pressed, and the page goes on as one no handler
  explains. The content script reads the text again in the click's own task, just
  before the press (`passwordChoice` on the click); a button the page rendered again
  with other text in between, under the same id, name or test ID, is not pressed, and
  the step fails as one whose target is missing (`target-missing`). It is not entered
  while one of the route's fill fields on that path shows writable, so a page that
  shows the password field gets the password, and so does a page whose route already
  continues there: the route's next step is checked before handlers. When several
  handlers show, a `password` handler goes first for such a login, so a login that
  types its password never presses a passkey button beside it; the order of `passkey`
  and `totp` handlers is unchanged. A `password` handler that shows but is passed over,
  as when its button shows again after its press (`shown-again`), ends the login
  `challenge` there instead of letting another handler shown with it be entered, so a
  passkey button beside it stays unpressed.
- **After the press.** Its click is held like any handler's
  ([ADR 0027](0027-per-account-login-routes.md), "Held click"): while the button still
  shows in the document that pressed it, the page is neither judged nor settled for up
  to two minutes, then the login ends `challenge` and is watched. A page that shows a
  push approval or a code is judged as after any effect step, which may add a `totp`
  handler. On a later login, the route's next step on the same path, such as the
  continued password field, confirms the press as an `advance` on its own path does
  (ADR 0013): only when it was not ready just before the click.
- **The continuation.** A `password` handler's click that is the last step of the
  login's plan, in a recipe whose own last step is an `advance`, is continued like that
  advance: once its page shows a password input, the page is sent with the recipe's
  revision as the base (one request per click), before the click's hold is checked, and
  the continued steps follow the handler's steps in the plan. The service appends them
  to the route as for any continuation; the handler stays. Later logins run the
  identifier, Next, the button when its page shows, then the password.
- **Logs.** `login.handler` names `kind` `password` with the usual outcomes.

### Unchanged

The proposal's second question was whether a button that goes on to a passkey, such as
"Use a passkey", should also be pressed on a login that will type a password. The owner
was not asked separately, so the current rule stays: a `password` login never enters a
`passkey` handler on a path where its plan still has a step to run that fills the
password or while a fill field of the route shows
([ADR 0036](0036-passkey-after-the-identifier.md) rule 6 and its 05:39 UTC
amendment). This ADR does not amend ADR 0036.

## Consequences

- UniSuper-like pages (identifier, then a choice of how to verify) can log in end to
  end: the first login is judged on the choice page, presses the button, continues on
  the password page and signs in; later logins make no model call.
- A site that sometimes skips the choice page still logs in: a handler is entered only
  when its button shows after an effect step, so a page that shows the password field
  instead gets the route's next step.
- Each recipe's pages are judged once more after the prompt changes, within the
  existing limits (20 a recipe a day, $5 a day, $100 a month).
- A wrong button that passes both guards is pressed once per login until the recipe is
  revoked; a press that does nothing ends `challenge` and is watched, so it costs the
  person one press, as before this ADR.
- The extension checks the live text when the handler is entered and again in the same
  task as the click, so a button the page renders again with other text under the same
  locator is not pressed: the click fails as `target-missing` (outcome
  `structural-mismatch`) without acting, and when the page reports again with the
  button still showing, the login ends `challenge`.
- When the `password` handler already ran and its button shows again beside a learned
  passkey button, the login ends `challenge` rather than pressing the passkey button.

## Alternatives

- **A. Keep #571's behaviour.** The login stops with the yellow "!", and the person
  presses "Password" and types it. No code, but such sites never log in end to end.
- **C. Press first, verify, then store the steps.** Store "press, fill the password,
  submit" as route steps only after a press showed the password page. Safer than B,
  since it stores only what worked, but it needs a new model request, a way to press a
  button not yet stored and a temporary record on the service, and changes the
  continuation further. The press also becomes a required route step, so a site that
  skips the page would no longer match the recipe.
- **D. Pateat finds the button by its words alone, without the model.** No cost, but it
  misses across languages and wordings and risks taking "Forgot password" for the
  choice.
