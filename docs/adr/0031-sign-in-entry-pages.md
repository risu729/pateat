# ADR 0031: Press a site's sign-in entry on pages without a login form

Status: accepted by the owner on 2026-10-12 (03:31 to 06:53 UTC). Partly implemented:
the stored entry recipe ([#325](https://github.com/risu729/pateat/pull/325)) and, on
2026-10-12, the service side (#336): an entry request, the `entry` decision, its prompt
line and plan checks, and the stored entry recipe. Also on 2026-10-12, the extension
side: sending such pages, the checks before and after the press, the press record, the
device block and the `login.entry` log, tested locally and with synthetic pages only.
Not yet verified on pixiv in the owner's Chrome. Amends
[ADR 0016](0016-recipe-generation-trigger.md) (a page without a sign-in input can be
sent), [ADR 0018](0018-recipe-generation-route.md) (a generated answer that is not a
form plan) and the recipe contract in `packages/contracts/src/login.ts`. Like
[ADR 0028](0028-account-chooser-login-pages.md)'s `chooser`, it needs a recipe whose
start has no fill step.

Implementation notes (2026-10-12), which leave the decision below as accepted:

- The `login.entry` levels follow
  [ADR 0019's standard](0019-local-diagnostics-and-logs.md#amendment-what-the-log-records)
  of the same day, not "refused (debug)" below: a refusal is `info` once per document
  and reason, and `debug` for `no-return-target` (an entry page visited while signed
  in), `in-progress` and a reason the document already logged. `pressed` is `info` and
  `blocked` `warn`.
- The URL parser reads every query key and value of a link, on its own and resolved
  against the link, and a link is refused when either reading leads to another site; a
  page's return path counts only when every reading of it stays on the site. So
  `https:evil.example/x`, `\\evil.example/x` and a bare key naming another site are
  refused.
- A link is also refused when it leads only to another fragment of the page, downloads,
  has an empty box, or opens elsewhere through the document's `<base target>`.
- A press the page never answered is not taken as one: its next page is not checked, but
  it counts against the tab's 10-minute limit. A page that comes after the wait settles
  the press as `no-sign-in` without being refused itself.

Amended by the owner on 2026-10-12 (decision card answered "fix" at 15:30 UTC): the page
after the press also passes when it asks for an account identifier alone, by the same
email and identifier-word rules that send such a page for generation
([ADR 0016](0016-recipe-generation-trigger.md#pages-that-ask-for-an-identifier-alone)),
so an entry whose login page asks for the email address first (as Resend's does) is
kept instead of blocked as `no-sign-in`. Known cost: a wrong link that leads to a page
with an email input beside other inputs, such as a contact or newsletter form, or to a
sign-up flow that asks for the email first, also passes, so that entry stays and is
pressed again on later visits (at most once per tab in 10 minutes) while its next page's
generation abstains; the owner revokes it in the web UI.

Date: 2026-10-12

## Context

On 2026-10-12 the owner opened
`https://www.pixiv.net/en/?return_to=%2Fbookmark_new_illust.php` while signed out of
pixiv. pixiv had sent the visitor there to sign in before showing
`/bookmark_new_illust.php`. The page has no form; it shows "Create account", "Login" and
icons for signing in with other services. "Login" leads to
`https://accounts.pixiv.net/login`, the real login page. Pateat did nothing on the top
page. Checked against main `88a8222`:

- ADR 0016 sends a page only when it shows a sign-in input. `showsSignIn`
  (`apps/extension/src/login/content.ts:97-107`) finds none, so the content script never
  offers the page (`content.ts:251`) after the background allowed it
  (`offersGeneration`, `apps/extension/src/login/runtime.ts:3727`). The extractor would
  refuse it anyway: a page without a field form gives `no-candidates`
  (`apps/extension/src/observation/extract.ts:598`).
- A recipe needs at least one slot and one step (`recipeSlotList` and `routeStepList`,
  `packages/contracts/src/login.ts:178-184`) and holds one origin (`login.ts:227`), so
  nothing can describe "press this, then go on elsewhere". An ADR 0018 continuation
  cannot cross from `www.pixiv.net` to `accounts.pixiv.net`: the assembler refuses it
  as `origin-mismatch` (`packages/inference/src/assemble.ts:101`), and a top-level
  attempt whose tab moves to another origin ends `left-origin` or `interrupted`
  (`packages/contracts/src/login-attempt.ts:294-298`, `:366-368`).
- The owner's pixiv items carry URIs on `accounts.pixiv.net`. Under Bitwarden's default
  Domain match they also match `www.pixiv.net`, since both share the registrable domain
  `pixiv.net` (`domainKey`, `packages/bitwarden/src/uri.ts:114`).

The login page itself works since 2026-10-12 07:24 UTC: on build `e9144a6`, after
[#297](https://github.com/risu729/pateat/pull/297) added the `autocomplete` locator for
inputs that pixiv names only by `autocomplete="username webauthn"`, generation on
`https://accounts.pixiv.net/login` succeeded. The pixiv item has no usable password; the
offered slots were the username and a Hidden custom field "Backup codes". The generated
recipe fills the username field, presses "Log In" and has the page's passkey button, and
the login signed in to `www.pixiv.net`. After a logout, Pateat now only fills the login
form and presses nothing ([#294](https://github.com/risu729/pateat/pull/294), an
[ADR 0021](0021-account-choice-outside-settings.md) amendment), and a login completes on
local evidence of a sign-in ([#299](https://github.com/risu729/pateat/pull/299),
[ADR 0029](0029-local-sign-in-state.md) delivery 2, first part).

## Decision

The owner decided on 2026-10-12:

- 03:31 UTC: prompts stay short and language-neutral.
- 04:36 UTC: Pateat never records the person's own clicks or input to build recipes
  ("操作を覚える、みたいなのはスコープ外"); what a page is and what it offers is judged
  by the AI first, as in ADR 0028.
- 06:26 UTC: on pixiv's top page Pateat presses "Login" itself to reach the real login
  page. It never presses "Create account" or a sign-in through another service.
- 06:53 UTC (decision card, option 「戻り先つきだけ」, "only with a return target"):
  Pateat presses only when the site sent the visitor to the page to sign in first, shown
  by a query value that names another path of the same site, such as
  `return_to=/bookmark_new_illust.php` on pixiv. A manual logout that lands on the bare
  top page is never undone.

The approved proposal's design follows. The press only opens the site's login page. It
reads no vault field and fills nothing. The page it leads to logs in through its own
recipe, or is generated, as any login page is today; on pixiv that is the
`accounts.pixiv.net/login` recipe described above.

- **Stored recipe.** A recipe of the page's origin with only `entry`: the start path and
  the control to press,
  `{"origin":"https://www.pixiv.net","entry":{"path":"/en/","target":{"by":"text","value":"Login"}}}`.
  ADR 0028's `chooser` needs the same kind of recipe, one whose start has no fill step.
- **When the page is sent.** A top-level HTTPS page (or HTTP page, whose item must be
  saved with an `http://` URI; [ADR 0050](0050-http-pages-for-http-items.md)) of a site
  that is not excluded, with a vault item whose URI matches its origin, on whose path no
  recipe starts, and that 10 seconds after loading shows no sign-in input. Its URL must
  carry a query value naming another path of the same site, such as
  `return_to=/bookmark_new_illust.php`. ADR 0016's 10-minute retry window applies.
- **What the AI sees and answers.** The visible, enabled buttons and links that carry
  text, outside forms with fields. Links to another site are dropped on the device, so
  off-site social sign-ins never reach the model. It names one of them as `entry`, or
  abstains.
- **Prompt line**, one sentence, by meaning only:

  > If the page has no sign-in fields, name in `entry` the one control that opens
  > sign-in to an existing account for a visitor who is not signed in; never one that
  > creates an account or signs in through another service; otherwise abstain.

- **Checks just before the press.** The site is not excluded; the vault is unlocked with
  a URI match for the page; the recipe is current and not blocked; the document is the
  tab's top frame; the press is bound to the document. The current URL still carries
  the query value naming a same-site path, so a manual logout that lands on the bare top
  page is never undone. The target is unique and has rendered text; a link's `href` is
  on the same site (registrable domain) and names no URL of another site in its query.
  The tab holds no Pateat record for the site, and nothing holds the site in any tab. At
  most one press per tab per 10 minutes.
- **Checks after the press.** Within 10 seconds the next page must be on the same site,
  show a sign-in input and show no sign-up form (a visible `new-password` field beside a
  confirmation field, or two password fields in one form). Otherwise the recipe is
  blocked on this device, a warning is logged, and that page is not sent for generation.

### Implementation choices

These follow from the decisions above and were made on 2026-10-12 without a new owner
decision.

#### Recipe contract

The recipe with only `entry` has no `slots`, `steps` or `maxSubmissions`, and none of
the members only a login route uses (`alternatives`, `passkey`, `completion`,
`rejection`, `accountSwitch`, `handlers`). The ID here is synthetic:

```json
{
  "version": 1,
  "id": "entry-01",
  "revision": 1,
  "origin": "https://www.pixiv.net",
  "entry": { "path": "/en/", "target": { "by": "text", "value": "Login" } }
}
```

`entry` is never beside `slots`, `steps` or the login route's members, and never gains
steps: a continuation (`base`) of such a recipe is refused. The shape of a recipe with
`chooser`, which gains slots once a branch is generated, stays ADR 0028's. The contract
change that lets a recipe start without a fill step is delivered once for both. The
service keeps the recipe as the one generated recipe of its origin and start path (ADR
0016's amendment), so its path is a path where a recipe starts.

#### Query value naming a same-site path

A query value counts when, after URL decoding, it is an absolute URL or starts with `/`;
other values, such as `lang=en`, are not read, since any word resolves to a path of the
page. Whether a value stays on the site is decided by the URL parser, never by its
characters: the value is parsed against the page's URL, and the result must be `https:`,
on the page's registrable domain (as `domainKey` computes it), with a path other than
`/` and other than the current path. `reachedReturnTarget`
(`apps/extension/src/login/sign-in-state.ts:50`) reads ADR 0029's E3 values much the
same way but compares origins. So `//evil.example/x`, `/\evil.example/x` and
`/<TAB>/evil.example/x` (the parser reads a backslash as a slash and drops tabs) resolve
to `evil.example` and do not count. Any parameter name counts. The query is read on the
device only; the observation never carries it.

#### More conditions for sending

Besides the proposal's conditions and ADR 0016's (no path that may carry a token, the
claim and `recipe.generate` log entry), a page is not sent when:

- the tab holds an ADR 0022 attempt record for any origin of the page's site, ended or
  not (per site, as the check before the press);
- a logout state is kept for an origin of the site in any tab
  (`pateat.login-logouts.v1`, ADR 0021 D); or
- the page is the next page of its origin in the tab after a form holding a password
  input was submitted there, ADR 0028's skip of a page right after a manual sign-in,
  delivered with whichever of the two ADRs comes first.

#### Request and answer

The request is ADR 0018's `POST /v1/recipes/generate` with a `LoginObservation` and no
`slots`, since nothing of the vault is offered. `recipeGenerationRequestSchema.slots`
(`packages/contracts/src/generation.ts:102`) requires at least one slot today; it
becomes optional for this request only, which the service recognises by an observation
with no fill candidate.

```json
{
  "version": 1,
  "observation": {
    "version": 1,
    "origin": "https://www.pixiv.net",
    "path": "/en/",
    "language": "en",
    "title": "pixiv",
    "complete": true,
    "candidates": [
      { "id": "c1", "role": "link", "target": { "by": "text", "value": "Create account" } },
      { "id": "c2", "role": "link", "target": { "by": "text", "value": "Login" } }
    ]
  }
}
```

Candidates in `<header>`, `<nav>`, `role="banner"` or `role="navigation"` come first,
then the rest in document order, up to the observation's 48 candidates; the rest are
left out without making the observation incomplete, since one control is all such a page
needs. A link is dropped on the device when its parsed `href` is not on the page's
registrable domain or a query value of it names a URL of another registrable domain.
Labels are redacted as in every observation (`[email]`, `[masked]`, `[number]`). The
path goes without its query, and no `href` is sent.

The model's output format gains one decision beside `plan` and `abstain`:

```json
{ "result": { "decision": "entry", "entry": "c2" } }
```

The prompt line goes only into requests without slots. `entry` is accepted only for a
request without slots, and only when it names a `link` candidate; a request with slots
that answers `entry`, or a request without slots that answers `plan`, fails
`invalid-output` with the plan check's code. The service resolves the candidate to its
target and saves the recipe. An abstention is not saved: it is logged and counts toward
the 10-minute retry window
([API README](../../services/api/README.md#recipe-generation)), so the page is sent
again on a visit after 10 minutes.

#### What may be pressed

Only an `<a href>` link is pressed. The `text` target names it by its rendered text, as
a recipe's `accountSwitch` and completion may name such a link; "rendered text" excludes
a link whose only text is an image `alt`. Its parsed `href` must be `https:` on the
page's registrable domain, no query value of it may name a URL of another registrable
domain (parsed as above), and it has no `target` attribute, or `_self`. Buttons and
script links are never pressed. A same-site link that redirects to another provider,
such as `/auth/google`, passes these checks; it is guarded only by the model before the
press and by the `left-site` block after the first press. pixiv's "Login" control type
is not verified; if it is a button, the implementation PR comes back to the owner with
that evidence before the rule is widened.

#### More checks just before the press

- The link's destination site is not excluded either.
- "The tab holds no Pateat record for the site" means no ADR 0022 attempt record for any
  origin of the site, ended or not: a tab that already ran a login there, failed or not,
  is not sent back to the login page. "Nothing holds the site" means ADR 0022's holding
  rules, and no logout state kept for an origin of the site in any tab.
- Amended on 2026-10-16 by
  [ADR 0021 D's logout clicks](0021-account-choice-outside-settings.md#logout-clicks):
  no entry is pressed in a tab while a control that logs out, clicked there on the site
  in the last 10 minutes, waits for the site's first step (`logout-clicked`).

Neither the press nor the recipe's start is an ADR 0022 attempt. The press starts no
attempt, holds no origin, is not a first step for ADR 0021 D's logout detection and is
not a signed-in state, so the entry page showing "Login" again is never taken as a
logout.

#### Checks after the press

The next page is a new top-level document, or a same-document URL change, in the same
tab within 10 seconds of the press. The checks on it then get their own wait of up to 10
seconds (`LOGIN_STEP_WAIT_MS`). No navigation within 10 seconds, or a modal on the same
page, counts as `no-sign-in` and blocks the recipe. A new tab or popup window is never
followed: a link with another `target` is refused before the press, and a window a
script opens is out of scope.

On that page:

- it must be on the entry page's registrable domain (else `left-site`);
- it must show a visible `type="password"` input, an input with
  `autocomplete="username"` or `autocomplete="one-time-code"` (ADR 0016 condition 3), an
  input that asks for an account identifier alone as ADR 0016's amendment of 2026-10-12
  defines it (a writable email input, or the page's only text input named with an
  identifier word),
  or a ready first step of a cached recipe (else `no-sign-in`);
- it must not show a visible `autocomplete="new-password"` input together with a second
  visible password input in the same form, nor two or more visible password inputs in
  one form (else `sign-up`).

When they hold, that page goes on as any login page: its own recipe starts, or it is
generated under ADR 0016. A sign-up page that passes these checks is then judged by its
own generation: [#298](https://github.com/risu729/pateat/pull/298) refuses a plan that
puts a secret into a lone `new-password` field unless the page is shaped like a sign-in
(ADR 0018), and otherwise the model's `no-login-form` abstention keeps it out.

#### Records and log

The press is kept per tab in `chrome.storage.session` until the tab closes, so the
10-minute limit and the checks after the press survive a worker restart. Field names are
settled in the implementation; the shape is:

```json
{
  "tabId": 812,
  "origin": "https://www.pixiv.net",
  "recipeId": "entry-01",
  "revision": 1,
  "pressedAt": "2026-10-12T07:30:00.000Z"
}
```

A block is kept in `chrome.storage.local` until the device's recipe sync brings a newer
revision of the recipe or removes it:

```json
{
  "recipeId": "entry-01",
  "revision": 1,
  "reason": "sign-up",
  "blockedAt": "2026-10-12T07:30:04.000Z"
}
```

`reason` is `left-site`, `no-sign-in` or `sign-up`. To recover, the owner revokes the
recipe in the web UI; since [#269](https://github.com/risu729/pateat/pull/269) its start
page is generated again on the next visit. While the blocked recipe stays cached, no
page is generated on its path, because a recipe starts there.

The log event is `login.entry`, with the origin, recipe ID and revision and an outcome:
`pressed` (info), `refused` with the failed check before the press (debug), or `blocked`
with the reason (warn).

## Consequences

- No new permission: the page is already reachable under
  [ADR 0009](0009-install-time-https-site-access.md), and the press is one click on a
  same-site link in the top document.
- Nothing of the vault is read on the entry page beyond ADR 0016's URI match. The
  username, password and other fields are read only on the login page the press leads
  to, by that page's own recipe.
- The service and Anthropic see, for each such page, its origin, its path without the
  query, its title and headings, and the text of its buttons and on-site links, redacted
  as every observation is. That is more ordinary browsing than a login page shows; it is
  sent only for vault-matched sites whose URL names a same-site path in its query.
- A call costs about $0.007, like a login page. It is bounded by ADR 0016's 10-minute
  window per origin and path and by the service's daily and monthly limits. Once the
  recipe exists the page is not sent again; after an abstention it is sent again on a
  visit at least 10 minutes later.
- A manual logout that lands on the bare top page is never undone, because that URL has
  no query value naming a same-site path. A logout that redirects to a URL carrying
  `return_to`, in a tab where Pateat never logged in to the site and while no tab keeps
  a logout state for it, would be pressed, unless the person clicked a control that logs
  out there (ADR 0021 D, since 2026-10-16).
- A wrong answer that leads to another site, to a page without a sign-in input or to a
  sign-up form blocks the recipe on the device after one press.

## Alternatives

- **Continue across origins.** Extend ADR 0018's continuation so one recipe spans
  `www.pixiv.net` and `accounts.pixiv.net`. Rejected: a recipe holds one origin, the
  assembler refuses `origin-mismatch`, an attempt that leaves its origin ends by ADR
  0022, and a recipe that carries vault fields across origins weakens the
  account-origin-tab scope of every login.
- **Reuse ADR 0028's chooser.** The chooser is for a list of accounts, compares the
  chosen item's username on the page and keeps branches of steps. An entry page has no
  account and no branches, and needs no vault read. The two share only the contract
  change for a recipe that starts without a fill step.
- **Navigate to a learned URL.** Save `https://accounts.pixiv.net/login` and send the
  tab there. Rejected: recipes hold no URLs (`loginTargetSchema` allows locators only),
  a saved URL drops the site's own return target and other state, and Pateat would
  choose where the tab goes instead of the site.
- **A local word list or device-local cache.** Find the control with a list of words
  such as "Login" and keep the result on the device. Not used, because the AI judges a
  page first (owner, 04:36 UTC). Recipes are also held by the service
  ([ADR 0013](0013-service-held-recipes-and-settings.md)), and a word list ties Pateat
  to languages.
- **Press on every signed-out visit to the top page.** Rejected by the owner (06:53
  UTC): it would undo a manual logout that lands on the top page.

## Delivery

1. The login page first: until `accounts.pixiv.net/login` logs in, pressing "Login"
   gains nothing. Done on 2026-10-12 07:24 UTC, build `e9144a6`, as described in
   [Context](#context).
2. The contract change for a recipe that starts without a fill step, in the contract,
   the service and the extension's recipe cache, delivered once for this ADR's `entry`
   and ADR 0028's `chooser`.
3. The press: sending such pages, the `entry` decision and prompt line, the checks
   before and after the press, the press record, the device block and the `login.entry`
   log. Verified on pixiv's top page in the owner's Chrome; the paid generation calls
   that needs were approved by the owner on 2026-10-12 at 06:28 UTC.

## Not covered

- A sign-in button that opens a form on the same path or in a modal, without a new page.
  The page then shows a sign-in input only after a click, which ADR 0016 does not send.
- A sign-in control that is a button or a script link rather than an `<a href>` link.
- A sign-in link that opens a new tab or window.
- Pressing a sign-in entry on a bare top page whose URL names no same-site path in its
  query.
- Signing in through a social or SSO provider, which waits for
  [ADR 0026](0026-sign-in-through-identity-providers.md).
