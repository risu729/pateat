# ADR 0078: A page's own control for another account switches without a recipe target

Status: accepted by the owner on 2026-10-24 (01:35 UTC, decision card "A:
決まりに合う1つを押す"), after it was built ahead of the decision on 2026-10-23 as the
owner asked ("ある程度決め打ちで進め、後から判断"). Decision 3 follows the owner's
message right after (01:35 UTC):
"ページによって挙動が微妙に違うのおかしいからちゃんと直して". Amends
[ADR 0028](0028-account-chooser-login-pages.md#amendment-2026-10-24-one-rule-for-a-control-for-another-account).

Date: 2026-10-23

## Context

Before a fill that writes a secret but not the username, the content script compares the
selected item's username with the account the page shows. On a mismatch it fills nothing
and clicks the recipe's `accountSwitch`, a button or `<a href>` link the generation role
named, or ends the attempt `wrong-account`. After the click, only the tab's next
document starts a new attempt.

Duolingo's remembered-account sign-in (`https://www.duolingo.com/?isLoggingIn=true`,
Real Chrome on main `c3197c3`, 2026-10-23 22:05–22:30 UTC) shows the remembered address
and a password field, and switches with an element that is neither a button nor a link:

```html
<form><div><div><div>
  <h1>Welcome Back!</h1><div>T</div><div>x@example.com</div>
  <div data-test="use-another-account" class="Dd4kg ...">
    <span>Use another account</span>
  </div>
</div></div></div><input id="web-ui3" placeholder="Password"> ...</form>
```

It has no role, `href` or `tabindex` 0, only `cursor: pointer`. The generation role
never sees it, so recipe `gen-e622e6f3…` has no switch and the attempt ended
`wrong-account`. Clicking it changes the page in place: the URL,
`performance.timeOrigin` and the navigation entry stay, and an email and a password
input replace the remembered account. So even a recipe target would not have continued
the login.

## Decision

1. **The page's own switch.** When the page shows another account and the recipe
   names no `accountSwitch`, the content script looks for the page's controls for
   another account: the innermost entry-like elements outside page chrome (ADR 0028: a
   button, a same-origin or script link, an entry role, `tabindex` 0 or more, or the
   element that sets `cursor: pointer`) whose whole text, at most 64 characters, holds a
   word for another (another, other, different, switch, 別の, 他の, ほかの, 切り替え,
   切替) and one for an account (account, profile, user and their plurals, アカウント,
   プロフィール, ユーザー), and no email address, masked text or run of four or more
   digits, nor a word for another action (add, create, delete, forget, logoff, logout,
   manage, register, remove, signoff, signout, signup, unlink, "log off", "log out",
   "sign out", "sign up", also with a hyphen, ログアウト, ログオフ, サインアウト,
   サインアップ, 追加, 作成, 削除, 登録, 管理), so "Add another account" or "Sign out of
   other accounts" is never clicked. One inside a form with a shown field counts, since
   the remembered account's own password form holds it, but one whose click would reach
   a native button that submits such a form never does (decision 3). When exactly one
   shows, it is clicked as a recipe's switch is: recorded first as `account-switched`,
   clicked within 10 seconds while it is still the only one on the same path, and never
   again in the attempt that follows. A recipe's own target still wins: a recipe that
   names one never falls back to the page's control.
2. **A switch in place.** After a switch click, the content script waits until the
   document has loaded and its DOM has had no change for 1 second, at most 5 seconds.
   If the switch it clicked no longer shows, the page changed in place, and the content
   script announces the document again as a new page, marked as switched: a recipe that
   starts on its path starts a new attempt carrying the switch, and a page without one
   may be offered for generation once more. The background takes only that marked
   announcement from a document whose attempt ended `account-switched`. A page that
   still shows the switch is waiting for its next document, which announces itself as
   before. A page that still shows another account ends the new attempt
   `wrong-account`.
3. **One rule.** Wherever Pateat clicks a control for another account, the same rule
   decides whether it may: a list's `other` button (ADR 0028), a recipe's
   `accountSwitch` and the page's own control. The control is entry-like, its text holds
   no email address, masked text, run of four or more digits or word for another action,
   and its click would not reach a native submit or image button of a form with a shown
   field: the control itself, a button around it, or the button a label around it names.
   So a recipe's switch may also be a pointer-only element, and a list's `other` button
   may be inside a form with a shown field. Finding the page's own control also needs
   the words for another account, at most 64 characters and a place outside page chrome,
   because nothing named it; a recipe's target and a list's `other` button were named by
   the generation role. A list's `continue` button is not a control for another account
   and keeps its own rule.

## Consequences

- Duolingo's remembered account is switched with no recipe change, and its form for
  another account is then generated and filled.
- A page whose own control for another account the words miss, such as "Not you?", still
  ends `wrong-account`; the person switches, and the form they reach is handled as
  before.
- A control with the words that does something else but has no word for another action,
  such as "Other users' settings", can be clicked once on a page that shows another
  account. The click never fills, and never reaches a native button that submits a form
  with a shown field; the page's own script could still submit one, as for any click.
  The attempt that follows never clicks another.
- A recipe's `accountSwitch` that names a link to another origin, or a control with a
  word for another action such as "Not you? Sign out", is no longer clicked; the attempt
  ends `wrong-account`, and the person switches.
- A list whose `other` button is a submit button of a form with a shown field, or whose
  text names another action, is no longer clicked; such a list ends as other lists
  with no single choice do.

## Alternatives

- **Let the generation role name such a control.** The observation would also carry
  pointer-only elements with these words, and the executor would click a target that
  names one. Existing recipes would not switch until generated again, and an in-place
  switch would still need decision 2.
- **Keep it as is.** The person presses the switch; the form they reach is offered for
  generation or filled by its recipe as before.
