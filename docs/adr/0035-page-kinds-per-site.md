# ADR 0035: Page kinds, and how far Pateat goes on each, per site and profile

Status: accepted by the owner on 2026-10-12: the request at 15:54 UTC ("classify, and
let profiles hold permissions", "per site"), then 21:11 to 21:30 UTC in the design
thread (`sign-in` can be limited to filling, login-time values belong to `sign-in`,
re-verification is not split by kind for now, Pateat never presses on it, logs for
evaluation, and the answers to the proposal's seven questions). The proposal was
reviewed against the code by subagents before each round. Delivery 1 is implemented
([below](#implementation-of-delivery-1)); deliveries 2 to 4 are not, so no page is
`page-off` yet and only `confirm-unsupported` pages carry the evaluation fields. Amends
[ADR 0012](0012-inference-request-log.md) (retention of evaluation rows) and
[ADR 0024](0024-settings-profiles.md) (two more profile parts). Amended on 2026-10-18 by
[ADR 0012](0012-inference-request-log.md#amendment-2026-10-18-rows-for-a-real-page-corpus)
([below](#amendment-2026-10-18-request-log-rows)): the request log's recipe ID and
revision are implemented ahead of delivery 1, and every row is kept one year; and by
[ADR 0019](0019-local-diagnostics-and-logs.md#amendment-2026-10-18-first-login-results-for-evaluation)
([below](#amendment-2026-10-18-login-results-on-the-service)): the first login result of
each revision reaches the service.

Amended on 2026-10-23 by [ADR 0062](0062-log-in-again-after-a-logout.md) (owner,
implemented): `excludedSites` pauses automatic login until the rule is removed. It still
stops observation, generation and filling by Pateat itself, but a popup pick logs in and
the person's own passkey request is answered through the chooser; no setting keeps a
site's pages from the vault any more.
Amended on 2026-10-23 by [ADR 0060](0060-recipe-layouts.md) (layouts accepted by the
owner on 2026-10-23 at 11:41 UTC; implemented on a branch, local tests only): `pageKind`
moved from the recipe to each of its layouts, every layout of a recipe has the same
kind, and a layout generated with another kind replaces the recipe's layouts (the last
two not confirmed by the owner). A chooser branch stays `sign-in`.

Date: 2026-10-12

## Context

Pateat has no rule for prompts a site shows while the person is already signed in,
such as ポイントインカム's secret question before `/my/my_profile_change.php` opens,
GitHub's "Confirm access" before a settings change, or a bank's transaction password
before a transfer. It reacts to some of them as to a login (recorded in the
[plan](../plan.md#phase-4-issues-and-work-as-needed) on 2026-10-12): it signs a passkey
request that names its credentials, logs in on a form shaped like a recipe's first step
in a tab without a login of the origin, and sends a password page on a path without a
recipe for generation, whose recipe then fills and submits it at once.

The button on such a page often both confirms and performs the action: pressing
"振込実行" next to the transaction password sends the money. A wrong press cannot be
undone. The owner also wants to use Pateat as plain autofill on some browsers or sites,
with the person pressing every button, and to choose all of this per site and per
settings profile.

## Decision

### Kinds of page

A page that asks for something Pateat could fill has one of three kinds:

| `pageKind` | Pages | Values |
| --- | --- | --- |
| `sign-in` | A login and the pages that continue it: second factors, account lists, sign-in entries, values asked during the login such as エポスNet's card security code or a birth date, and a sign-in again after a session expired | `auto`: fill and press, as today. `fill`: fill only |
| `confirm` | A verification asked while signed in, before an action: a secret question, a password asked again, a transaction password | `fill`: fill only. `off`: nothing |
| `personal-details` | Personal data in a form other than a login, such as a registration, address or profile form | `fill`: fill only. `off`: nothing |

- Pateat never presses a button on a `confirm` page (owner, 21:21 UTC). Splitting
  `confirm` into actions that cannot be undone (transfers, orders, account deletion, a
  changed email address or password, turning off two-step verification) and the rest,
  and pressing on the rest, is proposed again only after the evaluation below shows
  that the kinds can be told apart (owner, 21:13 UTC: whether the AI can tell them
  apart is doubtful).
- Filling `personal-details` is not built; it is the personal-data autofill item under
  [Research](../plan.md#research). Only the kind and its setting are decided here; which
  pages count and what is filled are decided with that feature.
- A page that asks for nothing, such as GitHub's "Verify your two-factor authentication
  settings", has no kind here.

### Classifying a page

No site list is kept ([ADR 0033](0033-no-site-specific-features.md)).

- Recipe generation answers the kind in the same model call: the `plan` decision gains
  `pageKind`, `sign-in`, `confirm` or `unclear`, judged from the page's structure (a
  session-expired sign-in form is `sign-in`; "enter your password before this action"
  is `confirm`). The service stores it on the recipe, so a later visit decides without
  a call. `unclear` is handled as `confirm` (owner, 21:29 UTC).
- The extension adds `signedIn` to the generation request as a hint: true when the
  recipe's learned signed-in marker or the username of a URI-matching item shows in the
  header or navigation, read as [ADR 0029](0029-local-sign-in-state.md)'s E1 and E2. The
  page text and username stay on the device; the flag reaches the service, the model
  and the request log.
- Entry recipes ([ADR 0031](0031-sign-in-entry-pages.md)) and chooser recipes
  ([ADR 0028](0028-account-chooser-login-pages.md)) are always `sign-in`. A continuation
  ([ADR 0018](0018-recipe-generation-route.md)) keeps the first page's kind.
- A page set to `off` is still sent for generation, so its kind is stored once; a site
  whose pages must not be sent at all is excluded (`excludedSites`), as today.
- A `confirm` recipe never starts a login, never counts as a logout (ADR 0021 D) and is
  never filled by the fill after a logout.
- When recipes are shared later, a shared recipe's kind is not trusted; the receiving
  side classifies again ([ADR 0013](0013-service-held-recipes-and-settings.md)).
- Recipes stored before this change are generated again rather than marked `sign-in`,
  because one may already be a `confirm` page.

Known limits: a secret-question input of `type="text"` does not meet
[ADR 0016](0016-recipe-generation-trigger.md)'s trigger, frames are not sent (most
3-D Secure pages), a tab with Pateat's own login of the origin sends nothing, and a
re-verification on the login page's own URL keeps its `sign-in` recipe.

### Passkey re-verification

A passkey request that names its credentials, from a tab whose Pateat login of the
origin finished with no logout detected since, is `confirm` (owner, 21:29 UTC). Under
`off` it is handed to the browser or Bitwarden. Under `fill` it is handed on too: an
answer completes the verification as a press would, and Pateat never presses on a
`confirm` page (derived from that rule, not asked separately). The same request after a
login made in another tab or before a browser restart cannot be told apart and is
answered as today.

### Fill only (`sign-in` set to `fill`)

Pateat works as autofill: it fills each page of a login and presses nothing. It builds
on the fill after a logout (ADR 0021 D), which fills the first page's leading fields
once, with these differences:

- Every page of the login is filled, including the password page after the person
  pressed "Next". This needs a new way to accept that the page or the person moved the
  login on, since an advance is confirmed today only by Pateat's own click. A
  single-page site that moves on in place is filled once per step; a value the person
  changed is never overwritten.
- No click of any kind: sign-in, next, an account list entry, a sign-in entry, a passkey
  button, a code's submit button, an account switch. When another account is shown, the
  fill stops.
- Fields the recipe marks as advancing or submitting are left empty, as in ADR 0021 D.
- The account is the saved default or the only URI match. With several, the person
  picks in the popup, and that pick logs in with presses as today (owner, 21:29 UTC).
- An item is filled on its password route even when it has a passkey; a passkey-only
  item is not filled. A passkey request is answered only when it follows a user
  activation; one issued on load or for conditional mediation
  ([ADR 0034](0034-answer-page-passkey-requests.md)) is handed on, since answering it
  signs in.
- No judge call and no logout detection. Handlers are not learned in this mode, since
  they are learned when a page is judged; learned ones are used.
- A page after the person's press with no recipe is sent for generation as a
  continuation, as under `auto` (owner, 21:29 UTC).

### Settings

The profile parts of the settings document (ADR 0024) gain two entries; the service
stays the source of truth and the extension caches them:

```json
"pagePermissionDefaults": { "sign-in": "auto", "confirm": "fill", "personal-details": "fill" },
"sitePagePermissions": [
  { "hostname": "pointi.jp", "includeSubdomains": false, "permissions": { "confirm": "off" } },
  { "hostname": "smbc.co.jp", "includeSubdomains": true, "permissions": { "sign-in": "fill" } }
]
```

- The defaults are `sign-in` `auto`, `confirm` `fill` and `personal-details` `fill`
  (owner, 21:29 UTC). `pagePermissionDefaults` always holds all three keys.
- A site row overrides only the kinds it names. Rows match the page's hostname like
  `excludedSites`: one row per hostname, at most 1,000, and when several match, the
  longest hostname wins for each kind. A row for a site does not cover its identity
  provider's pages, such as `accounts.google.com`.
- `excludedSites` stays: it stops observation, generation and filling, while `sign-in`
  `fill` still fills.
- The toolbar popup edits the current site's row (without subdomains, as it adds
  exclusions), and the settings page edits the defaults and all rows.

The decision is taken when a recipe is selected for a new login (before logout
detection and the fill after a logout), on each page of a fill-only login, on account
list pages and their branches, on a popup pick, when a stopped login asks again, when a
continuation is used, when a passkey request is answered or a passkey route chosen, and,
once built, when personal details would be filled.

### Logs and evaluation

Local log entries ([ADR 0019](0019-local-diagnostics-and-logs.md)), with no values or
page text:

- `recipe.generate` adds the answered `pageKind` and the `signedIn` sent.
- `login.start` adds `sign-in-fill` and which setting decided (`site` or `default`) to
  `fillOnly`; each fill-only page ends `login.attempt` `fill-only`, with
  `sign-in-fill` instead of `login.refused` `logged-out`.
- `login.refused` gains `page-off` (origin, recipe ID, kind, `site` or `default`), and
  `not-started` with detail `confirm-unsupported` while filling `confirm` pages is not
  built.
- `passkey.request` names `confirm-off`, `confirm-fill` or `sign-in-fill` when it hands
  a request on.

For the evaluation that decides whether `confirm` can be split (owner, 21:22 UTC):

- The model also answers `irreversible` (`yes`, `no` or `unclear`) for every page. It is
  kept in the service's request log only, never on the recipe, and changes nothing.
- The request log gains the recipe ID and revision, so its rows can be joined with the
  local log.
- On `page-off` and `confirm-unsupported` pages, the local log adds the recipe ID and
  revision, the kind, whether an amount (`¥`, `円`, `$` with digits) shows inside the
  form (`amount`, never the amount), E1 and E2, the previous path, and whether the
  person submitted the form themselves (`personSubmitted`, from a trusted `submit`
  event the content script reports to the worker before the page leaves; no button text
  or value). For a `confirm` page sent with `signedIn` false, it also records whether
  the tab's next page shows E1, which would suggest a sign-in page.
- Pages that look like re-verification but are not sent (a `type="text"` answer, a
  frame) are counted by reason.
- Rows whose kind is `confirm` or `unclear`, or that were sent with `signedIn` true, are
  kept past ADR 0012's 90 days until they are labelled, for at most one year, and the
  delete-all action still removes them (owner, 21:30 UTC). A thread labels them from the
  logged observation and the owner checks the doubtful ones; labelled pages join the
  real-page corpus under ADR 0012's review.

## Delivery

1. Right after phase 1 (owner, 21:29 UTC): `pageKind` and `irreversible` in generation,
   `pageKind` on recipes, `confirm` recipes neither run nor count as logouts, passkey
   re-verification handed on as above, the evaluation logs and retention, and
   regeneration of existing recipes.
2. The settings entries, the popup and settings page, and fill-only `sign-in`.
3. Filling `confirm` pages: run in a tab whose login finished, use that login's
   account (not the site default or a pick), and never take the page as a logout.
4. `personal-details`, with the personal-data autofill feature.

## Amendment 2026-10-18: request log rows

By the owner's decision of 2026-10-18 at 06:08 UTC
([ADR 0012](0012-inference-request-log.md#amendment-2026-10-18-rows-for-a-real-page-corpus)),
the request log's recipe ID and revision landed ahead of delivery 1, so rows can already
be joined with the local log by `recipe` and `recipeRevision`. Every row is now kept one
year, which covers this ADR's year for rows of `confirm` or `unclear` pages and rows
sent with `signedIn` true; delivery 1 needs no retention rule of its own. `pageKind` and
`irreversible` get their columns when they are built.

## Amendment 2026-10-18: login results on the service

By the same decision ("送る",
[ADR 0019](0019-local-diagnostics-and-logs.md#amendment-2026-10-18-first-login-results-for-evaluation)),
the outcome, cause and step of each recipe revision's first login reach the service's
`login_outcomes` table. For those codes the corpus joins request log rows with that
table by recipe, branch and revision instead of with the local log, which keeps them 14
days. The local log fields this ADR adds for `page-off` and `confirm-unsupported` pages
(the kind, `amount`, E1 and E2, the previous path, `personSubmitted`) still stay on the
device.

## Implementation of delivery 1

Implemented on 2026-10-23 (phase exception, as the owner allowed for the open PRs), with
these readings of the text:

- `signedIn` is sent exactly with a recipe's first page that lists no accounts (a form
  or a passkey-only page), the only pages whose kind is stored; the service refuses it
  on any other request. E1 reads the signed-in markers of every route recipe of the
  origin, `confirm` ones and chooser branches included; E2 looks for at most eight
  matching items' usernames.
- The plan answers `pageKind` and `irreversible` in the generation and passkey-only
  instructions; an entry or a list of accounts answers neither. The request log keeps
  them in `page_kind` and `irreversible`, and the hint in `signed_in`
  ([migration 0026](../../services/api/migrations/0026_inference_log_page_kinds.sql)).
- A recipe stored without `pageKind` fails the recipe contract, so the service reads it
  as revoked and generates its page again as the next revision; devices drop it on sync.
- A page on whose path a `confirm` or `unclear` recipe starts is not sent again, not
  logged in to and only watches, logging `login.refused` `not-started` with
  `confirm-unsupported` and that recipe's ID, revision and kind, also when the page
  announces a start read before its recipe was generated again. The popup names it and
  points to revoking the recipe in the web UI. Such a recipe never runs, so never
  reports use, and is never revoked as unused
  ([ADR 0058](0058-automatic-recipe-removal.md)), like an entry recipe.
- "A Pateat login of the origin finished" is read as the tab's record for the origin
  being `authenticated` and not fill-only. A logout detected since forgets that record;
  a control that logs out clicked on the RP ID's site in the tab also counts as one. A
  conditional request is left to ADR 0034, since it belongs to a sign-in field. The
  request is handed on as `confirm-fill`, the default setting for `confirm` pages.
- The benchmark report counts the kind each plan answered (`pageKinds`); every corpus
  page is a sign-in page.

The evaluation fields of `confirm-unsupported` pages and the counts of pages not sent
followed the same day, all local, with these readings:

- The content script reports a page's `shown` as soon as the first step of its `confirm`
  or `unclear` recipe shows, which the worker names in its answer, instead of after the
  10-second step wait; an origin with only such recipes otherwise never reported it.
  Once reported, the page stops watching its DOM and follows only its path. A move off
  the path in place is announced, so the worker logs the visit as left and reads the new
  path as the next page; a return to the path in place reports the step and the person's
  submit again, a new visit.
- `amount`: whether the rendered text of the forms that hold that step's elements shows
  `¥`, `円` or `$` (full-width forms too) beside a digit; never a control's value. It is
  absent when those elements are in no form.
- E1 and E2 are read as the `signedIn` hint reads them, as `e1` and `e2`, but up to
  five times a second apart until either shows or the page goes, since a header can
  render after the form; both come from the last reading. Both are absent when the page
  went before its first reading, and `e2` when no vault item matches or a username
  cannot be read.
- The previous path (`previousUrl`, sanitized like `url`) is the tab's previous top page
  of the same origin, or the same document before an in-place path change. A page of
  another origin, or one Pateat did not admit in between (an excluded site, no site
  access), leaves it out; a page where no content script runs, such as a browser error
  page, is not seen. A document restored from the back-forward cache after a page not
  admitted keeps the previous path of its first load.
- `personSubmitted` counts a trusted `submit` of a form that holds the step's elements,
  sent once per visit in `login.document.person-submitted`. A page script's
  `requestSubmit()` is trusted too, so it counts. It is logged in a follow-up entry,
  `login.confirm-left`, when the tab's next top page arrives, a page Pateat does not
  admit loads, or the tab closes; a discarded tab that loads again is not a leave. The
  worker keeps the visit in memory only, so a worker restart drops that entry.
- "Sent with `signedIn` false" would need the hint the page's generation request
  carried, which the device keeps only in the 14-day log, possibly on another device. It
  is read as the inputs of that hint on this visit: E1 read and false, and E2 not true
  (false, or absent with a locked vault, no match or no reading). Then
  `login.confirm-left` adds `nextE1`:
  whether the next page shows a signed-in marker of the origin's recipes, read up to
  five times a second apart. It is absent when the next page went before its first
  reading, was not admitted, or the tab closed. `confirm` covers `unclear` here.
- Counted pages are those that would otherwise be sent, a vault item matching:
  `text-answer` when a page offered for generation ends its offer window with a visible
  writable `type="text"` input whose name or label pairs a secret word (`secret`,
  `security`, `memorable`, `challenge`) with an answer word (`answer`, `question`,
  `word`, `phrase`), or holds a phrase such as `合言葉`, `秘密の質問` or `質問の答え`,
  and no sign-in reason holds; short texts beside its button are then not read as a
  list of accounts. The case the count exists for, a person who signed in earlier, is
  counted. On the tab's next document after a password submit the page is part of that
  sign-in and logs `nothing-offered` `after-sign-in`; after Pateat's own login of the
  origin in the tab it is not offered for generation, so not counted. `frame` counts
  when a frame whose page would be sent now shows
  a sign-in input or such an answer at one of five readings within the step wait. Each
  logs `recipe.generate` `skipped` with that reason at info, and the bug report counts
  them over 24 hours, like passkey delegations.

## Consequences

- A browser or site can use Pateat as autofill only.
- Once delivery 1 lands, pages generated as `confirm` are no longer filled and submitted
  as logins, and passkey re-verification after Pateat's login in the tab is no longer
  answered. A re-verification form shaped like a `sign-in` recipe's first step is still
  taken as a login or a logout, as in ADR 0021's known gaps.
- Every generated page costs a slightly longer answer; a page set to `off` still costs
  one generation (about $0.007).
- A session-expired sign-in misclassified as `confirm` or `unclear` is only filled, and
  the person presses the button.

## Alternatives

- Split `confirm` now into account changes, payments and others: rejected for now,
  since the AI's accuracy is unknown (owner, 21:13 UTC).
- Press on `confirm` pages for non-irreversible actions, or only right after the
  person's own click: deferred until the evaluation (owner, 21:21 UTC).
- Leave `sign-in` out of the settings and use `excludedSites` to stop logins: rejected,
  since autofill-only use needs filling without pressing (owner, 21:11 UTC).
- Count login-time card codes and birth dates as `personal-details`: rejected; they are
  part of the login (owner, 21:12 UTC).
