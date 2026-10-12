# ADR 0028: Login pages that list accounts to choose from

Status: accepted by the owner on 2026-10-12 (04:36 to 04:45 UTC), and extended to a
single shown account and to usernames that are not emails at 08:36 UTC. Not implemented.
Delivery depends on the extension's `advance` continuation of
[ADR 0018](0018-recipe-generation-route.md), which is not implemented yet. Amends
[ADR 0016](0016-recipe-generation-trigger.md) (a page without a sign-in input can be
sent), [ADR 0018](0018-recipe-generation-route.md) (a generated answer that is not a
form plan) and the recipe contract in `packages/contracts/src/login.ts`.

Date: 2026-10-12

## Context

On 2026-10-12, after a sign-out, `https://dash.cloudflare.com/login` showed Cloudflare's
saved-profile list ("Sign in to Cloudflare"): up to five saved profiles, each showing
its email address, one marked "Last used", and a "Sign in with another profile" button.
The page has no input. Clicking a profile shows a password form on the same path in the
same document; "Sign in with another profile" shows an email and password form there. A
reload shows the list again. The owner keeps three Cloudflare items in the vault.

Pateat did nothing on that page: [ADR 0016](0016-recipe-generation-trigger.md) sends a
page only when it shows a sign-in input within 10 seconds of loading, and the
observation extractor refuses a page without a field
(`apps/extension/src/observation/extract.ts`). After the owner chose a profile and typed
the password by hand, Pateat completed the following passkey step on its own.

Google's "Choose an account" page is a similar list on another path.

## Decision

The owner decided on 2026-10-12:

- 04:36 UTC: Pateat never records a person's own clicks or input to build recipe steps
  ("操作を覚える、みたいなのはスコープ外"). Which page is a login page, and what it
  offers, is judged by the AI first. On Cloudflare Pateat chooses the profile of the
  item that is the site default in Pateat, when the list has one, rather than "Sign in
  with another profile".
- 04:43 UTC: a profile whose email is partly masked may be chosen when it identifies the
  item unambiguously, with a minimum of visible characters, because an account that is
  not in the vault may look alike. When no profile can be chosen, Pateat continues
  through the page's button for another account.
- 04:45 UTC: the page right after a sign-in is never sent as an account list.
- 04:45 UTC: without a site default, the account is chosen in the toolbar popup as for
  any other login (option B of the proposal).
- 04:46 UTC: finding the list's entries must not depend much on their element type,
  since a list may use buttons, links or `div role="link"` rows.

### List entries

An entry is the innermost visible, enabled element whose rendered text holds the email
token and that is one of: a `<button>` or button-type `<input>`; an `<a>`, whose `href`,
if any, stays on the page's origin; an element with `role` `button`, `link`, `option`,
`menuitem` or `radio`; an element with `tabindex` 0 or more; or an element whose
computed `cursor` is `pointer`. A link, button or element with one of those roles around
the text that fails the rule (another origin, disabled) means the text has no entry, since
a click on an element around it would land on that control. This deliberately wider rule
applies only to list entries and the `other` button, not to the executor's other click
steps.

### Which pages are sent

A top-level page of an origin with a vault match, on whose path no cached recipe starts,
is sent for generation when, 10 seconds after loading, it shows no sign-in input but
shows at least one [list entry](#list-entries) whose rendered text holds a token shaped
like an email address, masked or not. Entries inside `<header>`, `<nav>`,
`role="banner"` or `role="navigation"` do not count, so that the account menu of a
signed-in page does not qualify. The check uses the token's shape only; no vault
username reaches the page for it. The other ADR 0016 conditions apply unchanged: the
site is not excluded, at most one generation per origin and path in 24 hours, no path
that may carry a session token, and no page while the tab holds an attempt record for
the origin. The last one already keeps every page after a Pateat login in that tab from
being sent.

A page right after a manual sign-in is not sent either: after a form holding a password
input is submitted in a tab, the next page of that origin in the tab (a new document, or
a same-document URL change) is skipped. The submission is used only for this skip and is
not recorded anywhere else.

The observation lists the page's entries apart from its candidates: up to 8 entry texts
as `accounts`, and the page's other controls outside page chrome, by their text, as
candidates the AI may name as the other-account button. An entry is never a candidate,
since its redacted text cannot name it and the AI does not pick an account. Email-like
text, fullwidth included, is redacted to `[email]` as in every observation, so the AI
never sees the profiles' addresses; a text in which an `@` survives is left out. Until
the generator can answer that a page is an account list, the service refuses such an
observation as `invalid-request` without a model call.

### What the AI answers

Besides a form plan and an abstention, the generator may answer that the page is an
account list: a sign-in page with no fields, where choosing a listed account leads on to
the sign-in. A signed-in page, an account menu, or any other page is an abstention. The
AI does not pick a listed account. It may also name the list's button that continues
without choosing a listed account, such as `{"by":"text","value":"Sign in with another
profile"}`. The button is found by the [list entry](#list-entries) rule. The extension
refuses it when its text holds an email address,
`[masked]` or a run of four or more digits, or when it is inside a form with fields.
The prompt gains one short, language-neutral sentence for this, which describes the
other-account button by its meaning only, with no example text in any language.

### Recipe shape

The answer is saved as a recipe whose start is the list on its path, with the steps
after each choice kept apart, because the form after a profile (password only on
Cloudflare) and the form after "another profile" (email and password) differ. Field
names are settled in the implementation; the shape is:

```json
{
  "chooser": {
    "path": "/login",
    "other": { "by": "text", "value": "Sign in with another profile" },
    "afterAccount": [],
    "afterOther": []
  }
}
```

Each branch starts empty and its steps are generated the first time a login takes it, as
an ADR 0018 continuation of the page the click led to. A chooser recipe may therefore
have no slots until a branch is generated. [ADR 0027](0027-per-account-login-routes.md)
`alternatives` cannot hold the branches: a continuation cannot add a variant, a
password-only set is a subset of the email and password set, and the executor picks a
variant from the item's binding, not from the page. The continuation contract
(`continuesRecipe` in `packages/contracts/src/login.ts`, the service's `appendPageSteps`
and the extension's `continuable`) accepts only a linear append today, so it gains
branch-aware appends for this recipe.

### Execution

A login starts on the list when the recipe's chooser path shows a counted entry with an
email-shaped token or the `other` button. The item is chosen as for any login: the site
default, the single matching item, or the popup when several match and none is the
default.

The background then sends the chosen item's username to the content script with the
click, as it does for a fill that checks for another account. The content script picks
the one entry whose text holds an email that fits the username:

- Only email-shaped usernames are compared, case-insensitively, token by token, where
  element boundaries and whitespace separate tokens. Nested entries count as their
  innermost one.
- An unmasked email fits only when equal (`a@example.com` does not fit
  `aa@example.com`).
- A masked email (`*`, `●`, `•` and the like) fits when the part after `@` is unmasked
  and equal, the visible characters before `@` match the username at the same positions
  from the start and from the end, and at least 3 characters and at least half of the
  username's part before `@` are visible. For `risutaku@example.com`,
  `risu***@example.com` fits and `ri***@example.com` does not.
- A masked email that also fits another matching vault item's username is not used. The
  background makes this comparison; masked texts and usernames stay in the extension.
  For example, with `risu@example.com` and `risutaku@example.com` in the vault,
  `risu***@example.com` fits neither.
- This rule is stricter than the masked-email check before a password fill, which
  accepts any consistent masked email, on purpose: choosing an account needs more
  certainty than stopping.

When exactly one entry fits, it is clicked. Otherwise, with no fit or several, the
`other` button is clicked. Without one, the login ends `account-not-listed` with no
click: no submission is spent, there is no retry, and the record holds the origin in the
tab as `wrong-account` does ([ADR 0022](0022-login-attempts-per-tab-and-origin.md)); it
is not a signed-in state for the logout check of
[ADR 0021](0021-account-choice-outside-settings.md). After the click, the branch's steps
run, or are generated first. The existing check before a password fill still stops the
login when the form then shows a different full email.

### A shown account with a separate button, and usernames that are not emails

Two pages were described on 2026-10-12 but their DOM is not verified yet:
`https://wise.com/login` shows "Welcome back", a name, a masked email as plain text, a
"Log back in" button beside it and "Use another account"; Instagram after a logout shows
saved profiles by their Instagram username, not an email, with "Continue" and "Use
another profile". Neither has an entry that holds an email, so neither is sent. The
owner decided at 08:36 UTC:

- **A shown account with a separate button (Wise).** A page is also sent when, besides
  the conditions above, an email-shaped token outside page chrome, a footer, `<address>`
  and `mailto:` links shares its nearest container with at most three
  [list entries](#list-entries), none of which holds the token. The AI's account-list
  answer may then also name the button that continues with the shown account, by meaning
  as for `other`. Pateat clicks it only when the page shows exactly one account and that
  account fits the chosen item's username by the [execution](#execution) rule;
  otherwise it clicks `other`, or ends `account-not-listed` without one.
- **Usernames that are not emails (Instagram).** When the chosen item's username is not
  email-shaped, an entry fits when one of its tokens equals the username exactly,
  ignoring case and a leading `@`; masked text never fits such a username. To decide
  whether to send a page without an email-shaped token, the content script hands the
  background the texts of the page's list entries outside page chrome, at most 64
  characters each, and the background compares them with the usernames of the items
  that match the origin. The usernames never reach the page, and the AI sees every
  entry text as `[account]`, so neither the matched username nor other listed names
  reach it. This reads the vault before any recipe exists, which ADR 0016 otherwise
  avoids. The check before a password fill compares only email and all-digit usernames,
  so for these usernames the exact match is the only check; one username names one
  account on a site.

## Consequences

- Cloudflare logs in with the site default's profile and no action from the owner after
  the first login, which costs about $0.014 for two generation calls (about $0.007
  each), plus one more when the "another profile" branch is first taken.
- Pages with an email in an entry outside the header and navigation, on vault-matched
  sites, can be sent once a day per path even when signed in in another tab; the AI
  abstains on them. D1's generation log shows how often.
- A profile that resumes SSO or social sign-in leads to the identity provider, where
  Pateat does not act before [ADR 0026](0026-sign-in-through-identity-providers.md) is
  delivered (phase 4).
- Google's "Choose an account" list is expected to qualify through the entry rule, but
  its page and DOM are unverified.

## Alternatives

- Record the button the person clicked before a form appeared, and prepend it to the
  recipe: rejected by the owner (no learning from the person's operations).
- Always continue through "Sign in with another profile": rejected by the owner in
  favour of the default's profile.
- Pateat clicks the default's profile without asking the AI whether the page is an
  account list: rejected by the owner (the AI judges first). It would also need a vault
  read before any recipe exists.
