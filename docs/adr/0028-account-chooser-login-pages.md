# ADR 0028: Login pages that list accounts to choose from

Status: accepted by the owner on 2026-10-12 (04:36 to 04:45 UTC), and extended to a
single shown account and to usernames that are not emails at 08:36 UTC. Implemented
in the service and the extension, with local tests only: it is not yet checked in the
owner's Chrome. It builds on the
extension's `advance` continuation of [ADR 0018](0018-recipe-generation-route.md)
([#332](https://github.com/risu729/pateat/pull/332)). Amends
[ADR 0016](0016-recipe-generation-trigger.md) (a page without a sign-in input can be
sent), [ADR 0018](0018-recipe-generation-route.md) (a generated answer that is not a
form plan) and the recipe contract in `packages/contracts/src/login.ts`.

Date: 2026-10-12

Note added on 2026-10-12 with [ADR 0031](0031-sign-in-entry-pages.md): the retry window
quoted below as "at most one generation per origin and path in 24 hours" and "once a day
per path" is condition 4 of [ADR 0016](0016-recipe-generation-trigger.md); on
2026-10-12, after this ADR was accepted, the owner lifted the 24-hour rule and a
10-minute window replaced it ([#269](https://github.com/risu729/pateat/pull/269)). ADR
0031's recipe with only `entry` also starts without a fill step, so the contract change
that allows such a recipe is delivered once for both.

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
the text that fails the rule (another origin, disabled) means the text has no entry,
since a click on an element around it would land on that control. This deliberately
wider rule applies only to list entries and the `other` button, not to the executor's
other click steps.

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
never sees the profiles' addresses; a text in which an `@` survives is left out. Such
an observation is only ever a recipe's first page: sent with a `base`, the service
refuses it as `invalid-request` without a model call.

The page's footer counts as page chrome since 2026-10-13, for these controls and for
the controls the login clicks, matches by name or counts as one for another account
(`other-in-chrome` when the words show only there): a `contentinfo` landmark, or a
`footer` without a role outside article, aside, main, nav, section, their roles or a
dialog, which HTML maps to one. A card's own footer inside a section, or a main region
inside a footer, is not chrome. That day Instagram's saved-profile page showed four
controls of its own and 16 links in its `<footer role="contentinfo">`, so the list went
over its eight other controls and was logged `incomplete-observation` with
`too-many-controls`. Entries and the addresses that make a page a list still count in
a footer.

As implemented in the extension: the content script checks once, when its ten seconds to
offer a page for generation end, and announces a list with the page's path. Without an
email listed, it hands over up to 32 short texts instead: those beside at most three
buttons, each at most 64 characters and without an `@`; a control's own text is never
one. Only buttons with words (rendered text, an input button's value or an image's alt
text; an `aria-label` alone does not count) count toward the three and decide the
container: on
2026-10-13 Instagram's saved-profile page showed a settings gear, a control with no
text, beside the profile, "Continue", "Use another profile" and "Create new account", so
the profile's container held four controls and the page was logged `no-list`. Many
ordinary pages show such a text, so on a site with a vault match the worker reads the
matching items' usernames, email usernames included, one at a time on each such page,
and sends the page only when a text names one, or (owner, 2026-10-12 19:11 UTC, below)
when the page also shows a control to sign in with another account; a page offered only
by such texts that is not sent is logged at debug level only, as mostly ordinary
browsing (owner rule that Pateat never stops silently, 2026-10-12). The worker passes
the naming texts back with the request to describe the page. The observation then lists
each as `[account]`, and hides the name wherever it shows, with or without a leading
`@`, in any width or case, such as in a heading; a name starting or ending with a Latin
letter or digit is not found inside a longer Latin word, but is found beside kana or
kanji, as in `taro.yamadaさん`. A control whose text or label holds it is left out, and
so is the page when its path holds it. Every other text beside the buttons, which may
name an account that is not in the vault, is shown as `[account]` when it is a whole
heading or the title, and a control with such a text is left out. Not covered yet: such
another name inside a longer text, such as "Continue as" and that name, or as a
control's own text, still reaches the AI; and a list whose rows are buttons showing only
a username, with no text beside them, is not found. The page right after a submitted
password form is skipped: the content script skips its own next path, and the worker the
tab's next document when it loads within a minute of the submission, kept in memory
only, so a restart of the worker in between forgets it. The content script's skip ends
with its document, so only the worker's carries to the next document. A later load, such
as a reload after a single-page app signed in and out in one document, is not skipped (a
gap found while checking Cloudflare, 2026-10-12); nor is a page that loads more than a
minute after the submission because a second step in the same document took that long. A
submission in a frame counts for the tab's page, and a next page of another origin ends
the skip; after a submission in a frame, a same-document URL change of the tab's page is
not skipped, since only the frame saw the submission. A stored chooser's path counts as
a recipe start, so the page is not sent again, and a chooser login starts there. The
local log names a list's generation with `page: accounts`, and the skips of a list with
an email as `after-sign-in` or `no-vault-match`. At debug level it also names a page
that, once its ten seconds end without a sign-in input, holds an `@` in its text but is
not taken as a list (`not-a-list`, with why: for its first shown address, such as
`inside-control` or `not-rendered`; else how a hidden one is hidden; else
`split-address`), and a page of texts that named no item (`no-listed-account`, with why
a shown control for another account did not count when one showed, such as
`other-holds-name`, `other-label-only`, `other-in-chrome` or `other-not-entry`, added
2026-10-12 after Instagram's list was not sent), and one that showed nothing to send at
all (`nothing-offered`: `no-list`, `after-sign-in` or `sign-in-shown`; added 2026-10-12
after Instagram's saved-profile list left no log line); other pages without a matching
item stay `no-vault-match` with a detail. At info level, a page not sent because the
vault could not tell is logged as `vault-unavailable` or `connection-disabled`; one not
offered without the service is `not-connected` at debug level. An element with
`display: contents` has no box, so it counts as shown when its parent is and renders its
content, and any child element renders: Cloudflare's saved profiles wrap each address in
one, and the list was not found before (2026-10-12). The service's check of the answer
also refuses a control whose text holds `[account]`.

### What the AI answers

Besides a form plan and an abstention, the generator may answer that the page is an
account list: a sign-in page with no fields, where choosing a listed account leads on to
the sign-in. A signed-in page, an account menu, or any other page is an abstention. The
AI does not pick a listed account. It may also name the list's button that continues
without choosing a listed account, such as `{"by":"text","value":"Sign in with another
profile"}`. The button is found by the [list entry](#list-entries) rule. The extension
refuses it when its text holds an email address,
`[masked]` or a run of four or more digits, or when it is inside a form with fields.
The prompt gains one short, language-neutral line for this, which describes the
other-account button by its meaning only, with no example text in any language. Only a
request whose observation lists accounts gets it, after the generation role's
instructions, so other prompts stay short.

As implemented, the answer is `{"decision":"account-list","other":"c1","continue":"c2"}`
with optional candidate IDs, and the instructions say: "An observation with accounts
lists saved accounts and has no fields: answer account-list when choosing one of them
leads on to signing in, else abstain. Never choose an account." The service checks the
answer before writing anything: the page must have `accounts` (and a form page's answer
must be a plan), and each named control must be a button or link of the page, not the
other control, with no `[email]`, `[masked]`, `[number]`, `@` or run of four digits in
its text or label. A refused answer fails as `invalid-output` with its check's code,
such as `unexpected-plan` or `account-text`. The extension's own check of the control
on the page comes with execution.

Amended on 2026-10-13, after myUNSW's sign-in page was saved as a chooser that named no
control and every login on it ended `account-not-listed`. Its one listed account was a
button whose text held an address, while the matching items' usernames were not
addresses, which no address can be compared with. So a list by email is now sent only
when a matching item's username is an email or the page shows a control for another
account; otherwise it is logged as `no-listed-account` with `no-email-username`, and
the page is offered neither as a list nor as a sign-in entry (ADR 0031). Separately, the
observation says how many of its accounts are entries the extension clicks itself
(`accountEntries`), and the service refuses an answer that names neither control when
none is (`no-list-control`), since nothing could then lead on from the list.

### Recipe shape

The answer is saved as a recipe whose start is the list on its path, with the steps
after each choice kept apart, because the form after a profile (password only on
Cloudflare) and the form after "another profile" (email and password) differ. The
contract in `packages/contracts/src/login.ts` (`loginChooserRecipeSchema`) has this
shape:

```json
{
  "chooser": {
    "path": "/login",
    "other": { "by": "text", "value": "Sign in with another profile" },
    "continue": { "by": "text", "value": "Log back in" },
    "afterAccount": { "...": "a login recipe" },
    "afterOther": { "...": "a login recipe" }
  }
}
```

`continue` is the button for a shown account beside it (Wise, below). Each branch is the
login recipe of the page the click leads to, under the chooser's own ID, revision and
origin, so the executor and the continuation handle it as any login recipe. A branch is
absent until a login takes it and its page is generated as an ADR 0018 continuation, so
a chooser recipe may have no slots at first; `afterOther` needs `other`. The entry to
click is never stored. [ADR 0027](0027-per-account-login-routes.md)
`alternatives` cannot hold the branches: a continuation cannot add a variant, a
password-only set is a subset of the email and password set, and the executor picks a
variant from the item's binding, not from the page. The continuation contract
(`continuesRecipe` in `packages/contracts/src/login.ts`, the service's `appendPageSteps`
and the extension's `continuable`) accepts only a linear append, so it gains
branch-aware appends for this recipe.

As implemented in the service: a generation request names the branch the login took
beside its `base`, which is the chooser (`"branch":"account"` or `"other"`). Without the
branch's recipe, the page is the branch's first page, assembled as a recipe's first page
but without alternatives or a passkey route, since the page follows the click on the
list; with it, the page is appended after the branch's final `advance` as any
continuation. The judgement request names the branch too, and its completion or handler
is learned into that branch, with the list's path among the login paths the judge is
told. Each write is the whole chooser at its next revision, so the other branch, if any,
moves to that revision unchanged. A branch's generated page whose write loses to a write
of the other branch meanwhile is written once more onto that newer chooser, as long as
its own branch is unchanged there; a judgement that loses the same way is answered
without a change, and a request sent against the older revision is answered with the
newer chooser without a model call, which the extension sends the page again against
when the chooser still lacks the page's branch step. A list of accounts shown again
after a branch's step is never judged (`not-judgeable`). A form page on the chooser's
own path, as when no profile is saved, gets no recipe of its own (`recipe-conflict`): it
is reached only as the `other` branch. The service's retry window and its
once-per-revision judgement are kept per branch as well. The service sends the
`accounts` texts as they come, so the extension must hide a non-email account name as
`[account]` before it sends any list.

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
  extension makes this comparison; masked texts and usernames stay in the extension.
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

As implemented in the extension: a chooser's path is where its login starts, once the
page shows no sign-in input and shows one of the chooser's buttons or an account listed
by email. The account is chosen as for any login. The worker then reads the account's
username and, for an email username, the other matching items' usernames one at a time,
and asks the content script what it would click, without clicking. When an other item
cannot be read, its username field is excluded, or more than 32 items match, the others
are incomplete and no masked address fits. The answer is the one entry that fits, the
`continue` button when the page shows one account, that account fits and the button is
one of the buttons beside it, the `other` button, or nothing. A username that is not an
email fits an entry-like control whose whole text equals it, or the one text beside
buttons on the page whose whole text equals it. The `other` and `continue` buttons are
never clicked when their text holds an email address, a masked text or four or more
digits, or when they are inside a form with a shown field. The login runs the chooser's
route for that click (`chooserRoute` in `packages/contracts/src/login.ts`): an `advance`
click on the list, then the branch's steps. Just before the click, the content script
makes the same choice again and refuses any other. Without the branch, the page after
the click is sent with the chooser as `base` and the click's branch, and the chooser
that comes back is taken over as the route of the same click. A chooser that comes back
without the branch's page, because the other branch changed it meanwhile, is taken over
and the page is sent again. A judgement names the branch. With nothing to click, the
login ends `account-not-listed` before its first step. Like `wrong-account`, it is
released as a stop by Pateat. When the account's username cannot be read, the login does
not start and the log names `field-unavailable` with `list-username`. Each later page of
a chooser login resumes the route of its recorded click. The local log's `login.start`
names the click as `list`. After a logout, the tab's fill-only login presses nothing, so
it does nothing on a list. The branch's pages, and the page judged after the sign-in,
are sent as for any login; since the roadmap's redaction of the account's own username
(2026-10-12), a username shown there, such as in a heading beside the password, is
hidden as `[account]` by the same rule
([architecture](../architecture.md#declarative-recipes-and-ai)).

Amended on 2026-10-16 after a failure in the owner's Chrome on Cloudflare (07:09 UTC):
after a logout the tab asked for an account on the list, the account the owner wanted
was not listed, so the owner pressed "Sign in with another profile", which showed the
email and password form on the list's path in the same document, and then picked the
account in the popup. The pick started nothing ("Pateat could not log in with … on this
page"), because a chooser login started only where the list showed. Now the chooser's
start also includes the stored `afterOther` branch's first step when that step is on the
list's path and waits for an element. When the page shows that step and does not show
the list, a new login runs the `other` branch alone, without a click (`chooser.click` is
`other-shown` in the attempt record, and the log's `login.start` names it as `list`); it
is planned, filled, submitted, continued and judged as that branch. While the list
shows, even beside such a form, the login clicks on the list as before. Without a stored
`afterOther` branch nothing changes: the form is still no start, and a reload shows the
list again, where the login clicks `other`. The person's own click on the button is not
recorded; the login only reads what the page shows, as for any recipe's first step.

Since that form is now a recipe's first step on the list's path, it also does what any
first step does:

- A page that shows the form directly, as when no profile is saved, starts a login with
  the default or the single match, which submits, where Pateat did nothing before.
- After a finished login in the tab, the form showing counts as a logout
  ([ADR 0021](0021-account-choice-outside-settings.md) D), and while another tab's login
  is watched, it ends that watch as the list does
  ([ADR 0027](0027-per-account-login-routes.md#watching-after-a-challenge)).
- After a logout, a fill-only login fills the form when it is the document's first
  appearance of a start, as for any recipe. A document is filled at most once, so after
  a fill-only login on the list, which presses nothing there, the form reached in the
  same document is not filled; the tab asks, and a pick in the popup logs in on it.
- For an item without a password (ADR 0036), the form is a start page: when it fills the
  email and password on one page, no `advance` comes before the stop, so the login is
  refused `no-route` (`password-empty:no-advance`), while a click on `other` from the
  list stops before the password.

Amended on 2026-10-13 by the owner's decision at 06:32 UTC
([ADR 0036](0036-passkey-after-the-identifier.md#account-lists)): an item without a
password but with a usable passkey also logs in from a list. The click is chosen as
above; it is the `advance` before ADR 0036's stop, which lies at the branch's first step
that fills the password or just past the branch (or the click, without a branch), and
the page after it is continued and its passkey request answered as ADR 0036 says
(implemented, local tests only).

### A shown account with a separate button, and usernames that are not emails

On 2026-10-12 around 08:40 UTC the owner's Chrome showed two more pages without a field,
neither with a password field (structure only, in the project notes):

- `https://wise.com/login` ("Welcome back"): one container holds, as siblings, the
  initials, the display name in an `<h3>`, the masked email (`w***@…`, one visible
  character before `@`) in a `<p>`, a "Log back in" `<button>` and a "Use another
  account" `<button>`. No button holds the account text.
- Instagram after a logout (`https://www.instagram.com/`): the saved profile shows its
  Instagram username, not an email, in a `<span>` beside a `div[role=button]` whose
  visible text is "Continue" and whose `aria-label` starts with "Continue" (likely
  "Continue as" and the username), then "Use another profile" and "Create new account".

Neither has an entry whose text holds an email, so neither is sent. The owner decided
at 08:36 UTC, from descriptions of these pages given before the capture:

- **A shown account with a separate button (Wise).** Besides a page with an entry that
  holds an email, a page is sent when an email-shaped token, in a text of at most 64
  characters outside page chrome, a footer and `mailto:` links, sits in a container that
  also holds at most three elements meeting the [list entry](#list-entries) rule apart
  from its email requirement, none of which holds the token; the container is the
  token's nearest ancestor that holds such an element. The AI's account-list answer may
  then also name the button that continues with the shown account, by meaning as for
  `other`. Pateat clicks it only when the page shows exactly one account and that
  account fits the chosen item's username by the [execution](#execution) rule; otherwise
  it clicks `other`, or ends `account-not-listed` without one. With Wise's `w***@…`,
  fewer than 3 characters are visible, so Pateat continues through "Use another
  account".
- **Usernames that are not emails (Instagram).** When the chosen item's username is not
  email-shaped, a shown account fits when its whole text equals the username, ignoring
  case and a leading `@`; masked text never fits such a username. A shown account is an
  entry's text, or a text beside a separate continue button as in the previous point,
  which on Instagram is the `<span>` beside "Continue". To decide whether to send a page
  without an email-shaped token, the content script hands the background those texts
  outside page chrome, at most 64 characters each, and the background compares them with
  the usernames of the items that match the origin. The usernames never reach the page,
  and the AI sees each such text as `[account]`, so neither the matched username nor
  other listed names reach it. This reads the vault before any recipe exists, which
  ADR 0016 otherwise avoids. The check before a password fill compares only email and
  all-digit usernames, so for these usernames the exact match is the only check; one
  username names one account on a site.

Amended by the owner on 2026-10-12 (decision card answered "press" at 19:11 UTC), after
Instagram's list was never sent in the owner's Chrome because the item's username is an
email and the list shows only the profile's Instagram username: a page whose short texts
name no matching item's username is still sent when it also shows, outside page chrome,
a control whose whole text (at most 64 characters) holds a word for another (another,
other, different, switch, 別の, 他の, ほかの, 切り替え, 切替) and one for an account
(account, profile, user and their plurals, アカウント, プロフィール, ユーザー), such as
"Use another profile" or "Switch accounts", and that the `other` rule above could click.
Every short text the page handed over is then hidden as `[account]`, since any of them
may name an account. A control whose text holds one of those texts would be left out of
the page sent, so it does not count; nor, as a precaution, does one whose `aria-label`
holds one. A page without another such control is not sent: "Not taro? Switch accounts"
beside the name taro, or "別のアカウントでログイン" under a heading "ログイン" beside
the list. The login then clicks `other` by the [execution](#execution) rule, since no
shown account fits the username, and the next page is generated as that branch. The page
right after a sign-in is not sent and is logged as `after-sign-in`. The words are a
local list, as the passkey button words are, and name no site
([ADR 0033](0033-no-site-specific-features.md)). Known cost: a signed-in page on a
matching site that shows a short text beside a button and such a control in its content,
such as "Manage other accounts" or "Create another account", can be sent (about $0.007,
at most once in the 10-minute window), and the AI abstains there. Not covered: a control
worded only "Not you?", "Use a different email" or "Add account".

Amended by the owner on 2026-10-12 (decision card answered "exclude" at 19:45 UTC),
after a github.com pull request page was read as a list because a comment showed the
username beside its buttons: a list, of names or with an email, on a page whose path has
a segment that holds a matching item's username, as the service-bound check refuses it
(`username-shown`), is not read or sent, as a list or as a sign-in entry
([ADR 0031](0031-sign-in-entry-pages.md)). The worker compares the path with the
matching items' usernames, which it now reads for every list, before the page is read,
and logs it at debug level as `no-listed-account` with `username-in-path`, since such a
page is a signed-in page under the account's own name. No site is named
([ADR 0033](0033-no-site-specific-features.md)). A list on such a page was refused once
read before; this saves reading it and the failure its read could log, and an entry
offered beside such a list is no longer sent. An entry page that shows no list is
unchanged, since the entry route reads nothing of the vault.

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
- With the 08:36 UTC extension, a page that shows an email next to at most three
  buttons, such as a signed-in settings page, can also be sent once a day per path, and
  on sites whose usernames are not emails the vault is read on pages without a field to
  compare the shown texts.
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
