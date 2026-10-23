# ADR 0078: A page's own control for another account switches without a recipe target

Status: proposed on 2026-10-23. Built ahead of the owner's decision as the owner asked
that day ("ある程度決め打ちで進め、後から判断"); a decision card asks the owner to pick
between this and the alternatives below.

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

1. **The page's own switch.** When the page shows another account and the recipe names
   no `accountSwitch`, the content script looks for the page's controls for another
   account: the innermost entry-like elements outside page chrome (ADR 0028: a button, a
   same-origin or script link, an entry role, `tabindex` 0 or more, or the element that
   sets `cursor: pointer`) whose whole text, at most 64 characters, holds a word for
   another (another, other, different, switch, 別の, 他の, ほかの, 切り替え, 切替) and
   one for an account (account, profile, user and their plurals, アカウント,
   プロフィール, ユーザー), and no email address, masked text or run of four or more
   digits, nor a word for another action (add, create, delete, logout, manage, register,
   remove, signout, "log out", "sign out", "sign up", ログアウト, サインアウト, 追加,
   作成, 削除, 登録, 管理), so "Add another account" or "Sign out of other accounts" is
   never clicked. Unlike a list's control, one inside a form with a shown field counts,
   since the remembered account's own password form holds it, but a native button that
   would submit its form never does. When exactly one shows, it is clicked as a recipe's
   switch is: recorded first as `account-switched`, clicked within 10 seconds while it
   is still the only one on the same path, and never again in the attempt that follows.
   A recipe's own target still wins: a recipe that names one never falls back to the
   page's control.
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

## Consequences

- Duolingo's remembered account is switched with no recipe change, and its form for
  another account is then generated and filled.
- A page whose own control for another account the words miss, such as "Not you?", still
  ends `wrong-account`; the person switches, and the form they reach is handled as
  before.
- A control with the words that does something else, such as "Add another user", can be
  clicked once on a page that shows another account. The click never fills or submits,
  and the attempt that follows never clicks another.

## Alternatives

- **Let the generation role name such a control.** The observation would also carry
  pointer-only elements with these words, and the executor would click a target that
  names one. Existing recipes would not switch until generated again, and an in-place
  switch would still need decision 2.
- **Keep it as is.** The person presses the switch; the form they reach is offered for
  generation or filled by its recipe as before.
