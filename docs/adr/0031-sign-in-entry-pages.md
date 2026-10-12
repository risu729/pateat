# ADR 0031: Press a site's sign-in entry on pages without a login form

Status: accepted by the owner on 2026-10-12 (03:31 to 06:53 UTC). Not implemented.
Amends [ADR 0016](0016-recipe-generation-trigger.md) (a page without a sign-in input can
be sent), [ADR 0018](0018-recipe-generation-route.md) (a generated answer that is not a
form plan) and the recipe contract in `packages/contracts/src/login.ts`. Shares its
start-only recipe member with [ADR 0028](0028-account-chooser-login-pages.md).

Date: 2026-10-12

## Context

On 2026-10-12 the owner opened
`https://www.pixiv.net/en/?return_to=%2Fbookmark_new_illust.php` while signed out of
pixiv. pixiv had sent the visitor there to sign in before showing
`/bookmark_new_illust.php`. The page has no form; it shows "Create account", "Login" and
icons for signing in with other services. "Login" leads to
`https://accounts.pixiv.net/login`, the real login page. Pateat did nothing on the top
page. Checked against main `e3acb8c`:

- ADR 0016 sends a page only when it shows a sign-in input. `showsSignIn`
  (`apps/extension/src/login/content.ts:97-107`) finds none, so the content script never
  offers the page (`content.ts:243`) after the background allowed it
  (`offersGeneration`, `apps/extension/src/login/runtime.ts:3700`). The extractor would
  refuse it anyway: a page without a field form gives `no-candidates`
  (`apps/extension/src/observation/extract.ts:604`).
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
[ADR 0029](0029-local-sign-in-state.md) delivery 2).

## Decision

The owner decided on 2026-10-12:

- 03:31 UTC: prompts stay short and language-neutral. The new prompt line describes the
  control by its meaning, with no example text in any language.
- 04:36 UTC: the AI judges which control is which. Pateat keeps no local word lists such
  as "Login" or "ログイン".
- 06:26 UTC: on pixiv's top page Pateat presses "Login" itself to reach the real login
  page. It never presses "Create account" or a sign-in through another service.
- 06:53 UTC (decision card, option 「戻り先つきだけ」, "only with a return target"):
  Pateat presses only when the site sent the visitor to the page to sign in first, shown
  by a query value that names another path of the same site, as `return_to` does on
  pixiv. A manual logout that lands on the bare top page is never undone.

The press only opens the site's login page. It reads no vault field and fills nothing.
The page it leads to logs in through its own recipe, or is generated, as any login page
is today; on pixiv that is the `accounts.pixiv.net/login` recipe described above.

### Entry recipe

The answer is saved as a recipe of the page's origin whose only member is `entry`: the
start path and the control to press. `slots`, `steps` and `maxSubmissions` are absent,
and so are the members that only a login route uses (`alternatives`, `passkey`,
`completion`, `rejection`, `accountSwitch`, `handlers`). The ID is synthetic here:

```json
{
  "version": 1,
  "id": "entry-01",
  "revision": 1,
  "origin": "https://www.pixiv.net",
  "entry": { "path": "/en/", "target": { "by": "text", "value": "Login" } }
}
```

`target` is a `loginTargetSchema` locator. A `text` target names the one button whose
rendered text equals the value, as for any click, and, like a recipe's `accountSwitch`
and completion, also an `<a href>` link by its rendered text when no button shows it.

ADR 0028's `chooser` needs the same change: a recipe that starts on a page without a
fill step and may have no slots. The contract therefore gains one "start-only member"
rule, delivered once for both: a recipe holds either a login route (`slots` and `steps`,
as today) or exactly one of `entry` and `chooser`, never both and never beside `slots`
or `steps`. An `entry` recipe never gains steps; a continuation (`base`) of it is
refused. The service keeps it as the one generated recipe of its origin and start path
(ADR 0016's amendment), so its path counts as a path where a recipe starts.

### Which pages are sent

A page is sent for an entry recipe when all of these hold:

1. It is a top-level HTTPS document of a site that is not excluded.
2. The vault is unlocked and has an item whose URI matches the page's origin under the
   provider's URI rules (ADR 0016 condition 2). No field of the item is read.
3. No cached recipe starts on its path.
4. 10 seconds after loading (`LOGIN_STEP_WAIT_MS`) it shows no sign-in input
   (`showsSignIn` is false).
5. Its URL carries a [return sign](#return-sign).
6. ADR 0016's other conditions hold unchanged: no generation for the origin and path in
   the last 10 minutes, no path that may carry a token, and no attempt record of the
   origin in the tab ([ADR 0022](0022-login-attempts-per-tab-and-origin.md)).
7. No logout state is kept for an origin of the site in any tab
   (`pateat.login-logouts.v1`, ADR 0021 D). After a logout Pateat never presses an
   entry, in line with 「戻り先つきだけ」 and with #294's fill-without-pressing.

The claim (`sending`, then `sent`) and the `recipe.generate` log entry are ADR 0016's.

### Return sign

The current URL carries a return sign when one of its query values, after URL decoding,
is a path or URL of the same site that is neither `/` nor the current path:

- a value starting with a single `/`, such as `return_to=/bookmark_new_illust.php`; or
- an absolute `https:` URL whose registrable domain is the page's, such as
  `next=https://www.pixiv.net/bookmark_new_illust.php`.

A value starting with `//`, or a URL of another registrable domain, is not a return
sign. Any parameter name counts, as in ADR 0029's E3, whose `reachedReturnTarget`
(`apps/extension/src/login/sign-in-state.ts:50`) reads values the same way but compares
origins rather than registrable domains. The query is read on the device only; the
observation never carries it.

### What the AI sees and answers

The request is ADR 0018's `POST /v1/recipes/generate` with a `LoginObservation` and no
`slots`, since nothing of the vault is offered:

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

The candidates are the visible, enabled buttons and links with rendered text, outside
any form that has fields. A link whose `href` leaves the site (another registrable
domain, or a query value naming a URL of another site) is dropped on the device, so the
icons that sign in through another service usually never reach the model. Candidates in
`<header>`, `<nav>`, `role="banner"` or `role="navigation"` come first, then the rest in
document order, up to the observation's 48 candidates; the rest are left out without
making the observation incomplete, since one control is all an entry page needs. Labels
are redacted as in every observation (`[email]`, `[masked]`, `[number]`). The path goes
without its query, and no `href` is sent.

The model's output format gains one decision beside `plan` and `abstain`:

```json
{ "result": { "decision": "entry", "entry": "c2" } }
```

The service resolves `c2` to its candidate's target and saves the [entry
recipe](#entry-recipe). An abstention is saved and logged as today. A request without
`slots` whose answer is `plan` fails `invalid-output` with the plan check's code.

The generation instructions gain one sentence, described by meaning only:

> If the page has no sign-in fields, name in `entry` the one control that opens sign-in
> to an existing account for a visitor who is not signed in; never one that creates an
> account or signs in through another service; otherwise abstain.

### Checks just before the press

The content script reports the target ready when it shows within 10 seconds. The
background then presses only when all of these hold, and otherwise logs why and presses
nothing:

- The press is bound to the document that reported the target ready, as a login step
  is; a reload, a new document or a cancelled document drops it.
- Neither the page's site nor the link's destination site is excluded.
- The vault is unlocked and an item's URI matches the page's origin.
- The recipe is the current cached revision, is not revoked and is not
  [blocked on this device](#checks-after-the-press).
- The document is the tab's top frame. A frame never presses an entry.
- Exactly one element matches the target, and it has rendered text (not only an image
  `alt`).
- A link's `href` resolves to `https:` on the page's registrable domain (computed as
  `domainKey` does), and none of its query values names a URL of another registrable
  domain, `//` included. A button without `href` passes this check; where it leads is
  checked after the press.
- The current URL still carries a [return sign](#return-sign).
- The tab holds no ADR 0022 attempt record for an origin of the site, ended or not. A
  tab that already ran a login there, failed or not, is not sent back to the login page.
- No tab holds the site (ADR 0022's holding rules), and no logout state is kept for an
  origin of the site in any tab.
- The tab has had no entry press in the last 10 minutes.

The press is kept per tab in `chrome.storage.session` until the tab closes, so the
10-minute limit and the check after it survive a worker restart. Field names are settled
in the implementation; the shape is:

```json
{
  "tabId": 812,
  "origin": "https://www.pixiv.net",
  "recipeId": "entry-01",
  "revision": 1,
  "pressedAt": "2026-10-12T07:30:00.000Z"
}
```

The press is not an ADR 0022 attempt record: it holds no origin, starts no login and is
not a signed-in state for ADR 0021 D, so the entry page showing "Login" again later is
never taken as a logout.

### Checks after the press

Within 10 seconds of the press, the tab's next top-level page must:

- be on the same registrable domain as the entry page;
- show a sign-in sign: `showsSignIn` holds, or a cached recipe's first step is ready on
  it; and
- show no sign-up sign: a shown `autocomplete="new-password"` input together with a
  second shown password input, or two or more shown password inputs in one form.

When they hold, that page goes on as any login page: its own recipe starts, or it is
generated under ADR 0016. When one fails, the entry recipe is blocked on this device
until the service has a newer revision of it, the page that failed is not sent for
generation, and a warn-level entry is logged. The block is kept in
`chrome.storage.local`:

```json
{
  "recipeId": "entry-01",
  "revision": 1,
  "reason": "sign-up",
  "blockedAt": "2026-10-12T07:30:04.000Z"
}
```

`reason` is `left-site`, `no-sign-in` or `sign-up`. The log event is `login.entry`, with
the origin, recipe ID and revision and an outcome: `pressed` (info), `refused` with the
failed pre-press check (debug), or `blocked` with the reason (warn).

## Consequences

- No new permission: the page is already reachable under
  [ADR 0009](0009-install-time-https-site-access.md), and the press is one click in the
  top document.
- Nothing of the vault is read on the entry page beyond ADR 0016's URI match. The
  username, password and other fields are read only on the login page the press leads
  to, by that page's own recipe.
- The service and Anthropic see, once per entry page, its origin, its path without the
  query, its title and headings, and the text of its buttons and on-site links, redacted
  as every observation is. That is more ordinary browsing than a login page shows; it is
  sent only for vault-matched sites whose URL carries a return sign.
- A call costs about $0.007, like a login page. It is bounded by ADR 0016's 10-minute
  window per origin and path and by the service's daily and monthly limits; once the
  entry recipe exists, the page is not sent again.
- A visitor who opens the bare top page, or who logged out by hand, is never signed in
  by this; Pateat acts only where the site itself asked for a sign-in.
- A wrong answer that leads to a sign-up or another page blocks the recipe on the device
  after one press; it does not repeat in that tab for 10 minutes, and a tab that already
  tried a login on the site never presses.

## Alternatives

- **Continue across origins.** Extend ADR 0018's continuation so one recipe spans
  `www.pixiv.net` and `accounts.pixiv.net`. Rejected: a recipe holds one origin, the
  assembler refuses `origin-mismatch`, an attempt that leaves its origin ends by ADR
  0022, and a recipe that carries vault fields across origins weakens the
  account-origin-tab scope of every login.
- **Reuse ADR 0028's chooser.** The chooser is for a list of accounts, compares the
  chosen item's username on the page and keeps branches of steps. An entry page has no
  account and no branches, and needs no vault read. The two share only the start-only
  member of the recipe contract.
- **Navigate to a learned URL.** Save `https://accounts.pixiv.net/login` and send the
  tab there. Rejected: recipes hold no URLs (`loginTargetSchema` allows locators only),
  a saved URL drops the site's own return target and other state, and Pateat would
  choose where the tab goes instead of the site.
- **A device-local cache.** Find the button with a local word list and keep it only on
  the device. Rejected by the owner (04:36 UTC): the AI judges, recipes are held by the
  service ([ADR 0013](0013-service-held-recipes-and-settings.md)), and a word list ties
  Pateat to languages.
- **Press on every signed-out visit to the top page.** Rejected by the owner (06:53
  UTC): it would undo a manual logout that lands on the top page.

## Delivery

1. The login page first: until `accounts.pixiv.net/login` logs in, pressing "Login"
   gains nothing. Done on 2026-10-12 07:24 UTC, build `e9144a6`, as described in
   [Context](#context).
2. The start-only recipe member in the contract, the service and the extension's recipe
   cache, delivered once and shared with ADR 0028's `chooser`.
3. The entry press: sending entry pages, the `entry` decision and prompt line, the
   checks before and after the press, the per-tab press record, the device block and the
   `login.entry` log. Verified on pixiv's top page in the owner's Chrome; the paid
   generation calls that needs were approved by the owner on 2026-10-12 at 06:28 UTC.

## Not covered

- A sign-in button that opens a form on the same path or in a modal, without a new page.
  The page then shows a sign-in input only after a click, which ADR 0016 does not send.
- Pressing a sign-in entry on a bare top page with no [return sign](#return-sign).
- Signing in through a social or SSO provider, which waits for
  [ADR 0026](0026-sign-in-through-identity-providers.md).
