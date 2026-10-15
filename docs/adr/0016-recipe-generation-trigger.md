# ADR 0016: Automatic recipe generation on pages with a vault match

Status: accepted by the owner on 2026-10-11. Amends
[ADR 0009](0009-install-time-https-site-access.md); amended by
[ADR 0018](0018-recipe-generation-route.md), by the owner's account-switch decision of
2026-10-11 ([Pages where no recipe starts](#pages-where-no-recipe-starts)) and by the
owner's username shape decision of 2026-10-11 ([Username shape](#username-shape)), by
the owner's retry decision of 2026-10-12 (condition 4), by the owner's identifier-page
decisions of 2026-10-12
([Pages that ask for an identifier alone](#pages-that-ask-for-an-identifier-alone)), and
by [ADR 0027](0027-per-account-login-routes.md) (implemented): each request also offers
the matching items' allowed custom fields by name and position, with the Text shapes all
of them agree on, read just before sending as for the username. Implemented in the
extension ([Background execution](../architecture.md#background-execution)), including
that amendment; the service route enforces the retry window as well
([API README](../../services/api/README.md#recipe-generation)). Amended on 2026-10-13 by
ADR 0021's [site count badge](0021-account-choice-outside-settings.md#site-count-badge)
(implemented on 2026-10-15): condition 2's vault match is no longer the only vault
access a page without a recipe gets.

Date: 2026-10-11

## Context

AI generation is the main way recipes are made
([ADR 0013](0013-service-held-recipes-and-settings.md)). ADR 0009 lets a document
without a cached recipe do nothing: no attempt, observation, policy catalog or vault
access. Generation therefore needs a rule for which pages without a recipe are observed
and sent to the service. Sending every page would disclose browsing to the service and
the provider and spend inference on pages the owner never logs in to; a manual trigger
needs a click on every new site.

## Decision

A top-level HTTPS document without a cached recipe for its origin (since the amendment
below: on whose path no cached recipe starts) is observed and sent for recipe
generation automatically when all of these hold:

1. The site is not excluded.
2. The vault has at least one item whose URI matches the origin under the existing
   provider URI rules. This is the only vault access a document without a recipe gets
   to decide whether it is sent; it needs an unlocked vault and does not read field
   values. Only a page that is about to be sent reads the matching items' usernames,
   for their shape ([Username shape](#username-shape)).
3. The page shows a visible `type="password"` input, or an input with
   `autocomplete="username"` or `autocomplete="one-time-code"`; or, since the amendment
   below, it asks for an account identifier alone
   ([Pages that ask for an identifier alone](#pages-that-ask-for-an-identifier-alone)).
4. No generation was attempted for the same origin and path in the previous 10 minutes,
   whatever its outcome (a recipe, an abstention or a failure). The owner lifted the
   first rule of once in 24 hours on 2026-10-12, so a page can be tried again the same
   day; the 10-minute window, chosen without a new owner decision, keeps a page that
   reloads itself from calling the model on every load.

Example: opening `https://bank.example/ib/login`, with a Bitwarden item whose URI
matches `bank.example` and a visible password input, sends the page's observation to
the service. Generation costs about $0.007 a page (the 16-page benchmark cost $0.108)
and stays under the monthly spend stop of
[ADR 0014](0014-claude-generation-provider.md).

The observation is the value-free `LoginObservation`
(`packages/contracts/src/observation.ts`) built by the extension; an incomplete
observation is not sent.
When the generated recipe is used, and the service route, are decided in
[ADR 0018](0018-recipe-generation-route.md).

Implementation choices that follow from this decision, made on 2026-10-11 without a
new owner decision:

- A page whose path may carry a session ID or another token, such as `;jsessionid=`,
  an encoded query or a long letter-and-digit run, is never observed or sent, so the
  path never reaches the service or the [ADR 0012](0012-inference-request-log.md)
  request log
  ([AI evaluation harness progress](../plan.md#ai-evaluation-harness-progress)).
- Only a page that shows such an input within 10 seconds of loading is sent, the same
  wait a login step gets; a form shown later, for example after a click, is not. Since
  2026-10-12, a page that could be sent but shows nothing to send by then is logged at
  debug level as `nothing-offered` ([architecture](../architecture.md#local-log)). Since
  2026-10-12 (added after this decision, after Vpass's post-logout login page was logged
  as not described), a page whose description is refused, fails its check or is
  incomplete is read again up to twice, one second apart, before it counts as not
  described, since a form rendered in steps may show its password input before the rest
  of it. A cancelled or replaced document stops at once.
- The vault match is checked only once the input shows, and only matching items'
  built-in fields decide which of the `username`, `password` and `totp` slots are
  offered.
- The extension claims a page as `sending` just before it sends it, so another tab on
  the same page does not send it too. The claim becomes `sent`, which holds the page for
  the 10-minute retry window, only when the answer shows the request reached the model:
  a recipe, an abstention, or a `failed` code other than `incomplete-observation`,
  `invalid-request` and `input-too-large`. Every other end frees the page for its next
  visit: an `unavailable` answer (including `busy` and `recently-tried`), a refusal
  before the model, an unreachable service or its request limit, a rejected device, a
  timeout, an unexpected answer and a thrown error. A timed-out request may still have
  reached the model; the service then answers its next send with `recently-tried`, or
  with the recipe it wrote, without another model call. A `sending` claim expires after
  two minutes, longer than the 90-second request timeout, so a request lost with a
  stopped or reloaded service worker frees the page soon after. Condition 4 therefore
  counts a request as an attempt once it reached the model. This replaced the earlier
  claim on 2026-10-12, without a new owner decision, after Moppy and LinkedIn stayed
  claimed for a day by a send that never reached the model; claims in the earlier record
  shape are dropped. A page that continues a recipe after an `advance` step is claimed
  (2026-10-12) under its origin, path and the recipe revision it continues, as on the
  service; when its claim is freed, or it was not sent because no service is paired,
  storage could not be written or the same request is still `sending`, the login gives
  its request back for a later document to send, except after `recipe-revoked` or
  `recipe-conflict`, which any later document would get too
  ([ADR 0018](0018-recipe-generation-route.md#continuing-after-an-advance)).
- Each page offered for generation is logged as `recipe.generate` with its outcome
  (`recipe`, `abstained`, `failed`, `unavailable` or `skipped`) and reason, including a
  page not sent because it is `sending` or `sent`, once per document
  ([local log](../architecture.md#local-log)).
- A page is not offered while its tab holds an attempt record for the page's origin
  ([ADR 0022](0022-login-attempts-per-tab-and-origin.md)), which an executing or
  ended attempt keeps until the tab closes, even when no recipe starts on its path. The
  one exception is an `account-switched` record of the same origin. A generated
  recipe's later pages go through its continuation in ADR 0018 instead.
- Frames are not sent; only the tab's own page is.

## Pages where no recipe starts

Amended by the owner on 2026-10-11, choosing how a login continues after an account
switch. A page is now eligible when no cached recipe of its origin starts on its path,
not only when its origin has no recipe at all. Conditions 1 to 4 still apply, and a page
an attempt in its tab is executing is not observed. The recipe generated there is a
separate recipe that starts on that path, so one origin can hold several generated
recipes, one per start path; this amends ADR 0018's one generated recipe per origin.

Example: the recipe for `https://accounts.example` starts on `/signin/pwd`, a password
page that shows a remembered `myaccount@example.com`. The selected item is
`my2@example.com`, so the executor clicks the recipe's `accountSwitch` ("Use another
account"), which leads to `/signin/id`, an email page. No recipe starts there, so that
page is observed and sent, and the recipe generated for it logs in to `my2@example.com`
([Background execution](../architecture.md#background-execution)).

The extension offers such pages, and the service keeps one generated recipe per origin
and start path ([API README](../../services/api/README.md#recipe-generation)).

## Pages that ask for an identifier alone

Amended by the owner on 2026-10-12, after Resend and Grafana Cloud were never sent:
their first page asks for the email address or username alone, without a password input
or `autocomplete="username"`. Two decision cards, both answered "send" (14:43 and 14:51
UTC), add to condition 3 a page that shows a visible writable input that is:

- an email input, by `type="email"` or `autocomplete="email"` (Resend), or
- the page's only text-like input (`text`, `email`, `tel`, `number`, `url`), of type
  `text` with no `autocomplete` other than `on` or `off`, when a whole word of its name,
  id, placeholder, `aria-label` or label names an identifier: email, mail, user,
  username, userid, login, loginid, account or id, or, anywhere in the text, メール,
  ユーザー, ログイン or アカウント (Grafana Cloud's `name="login"` labelled "Email or
  username"). Names split into words at case changes and punctuation first, so
  `loginId` and `e-mail` match and `hidden` does not.

Neither counts inside a form with a `new-password` input. A search box (`type="search"`,
inside `<search>` or `role="search"`) and an input with a word of another kind of field
(search, coupon, promo, tracking, order, newsletter, subscribe, zip or postal, or
anywhere 検索, クーポン, 注文, 追跡, メルマガ, マガジン, 購読 or 郵便) neither count nor
are counted as text-like inputs beside one, so a login field beside a site search box is
still the page's only one. The word lists are local, as the passkey button words are,
and name no site ([ADR 0033](0033-no-site-specific-features.md)). Conditions 1, 2 and 4
still apply.

Such a page is offered only once the content script's ten-second step wait ends. A list
of accounts by email ([ADR 0028](0028-account-chooser-login-pages.md)) goes first. A
sign-in entry to press ([ADR 0031](0031-sign-in-entry-pages.md)) goes first too, unless
the identifier input is the page's only text-like input, so a newsletter email field
does not hide a site's entry button. A list by short names only, or an email shown
outside any list, is dropped for such a page, which is sent or logged instead. As for
lists and entries, the page right after a submitted sign-in is not sent: the tab's next
document of the origin is logged as `skipped` with `after-sign-in`, and a next path in
the same document is not offered at all, since a profile or settings page that
shows the account's email is no sign-in page. The first visit to such a site therefore
starts generation after ten seconds; once a recipe exists, its first step starts the
login at once.

Known costs, accepted by the owner: on a site with a matching item, a newsletter field
without one of the excluded words, a member-ID lookup page, or a checkout, contact or
profile page with an email input can be sent (about $0.007 a page, at most once in the
10-minute window of condition 4), and the AI abstains there. A landing page whose only
text input is such a field also hides the site's sign-in entry, since a sole identifier
input goes first. Not covered: an identifier input of type `text` beside another text
input (a company code), words in other languages, and compounds not on the list. Since a
later owner decision the same day, a sign-in entry whose press leads to such a page
passes its check ([ADR 0031](0031-sign-in-entry-pages.md)).

## Username shape

Amended by the owner on 2026-10-11. After a page's observation is built and checked,
just before each generation request (a first page, a page after an `advance` step, or a
page reached through an account switch), the extension reads `login.username` of every
item whose URI matches the page, across all enabled connections, and computes its
[ADR 0010](0010-inference-field-hints.md) `valueShape`. The `username` slot carries the
shape only when every matching item with a username gives the same length, character
classes and email form:

```json
{
  "id": "username",
  "kind": "identifier",
  "description": "account username, email address or login ID",
  "valueShape": { "length": 8, "classes": ["ascii-digit"], "email": false }
}
```

Two items with `00001234` and `0000123456` send the slot without `valueShape`. An item
without a username, or with an empty one, does not count, and one whose
`login.username` the user excluded from filling is never read. Items Pateat does not
fill from (for example an excluded, unselected or quarantined item, or one awaiting
custom-field review) are not matching items here either. When an enabled connection
could not answer, an item's URI rules could not be evaluated, a username read fails, or
a username is too long to shape (over 1,024 characters), no shape is sent. The username
itself never leaves the extension.

Note added on 2026-10-12 with the roadmap's redaction of the account's own username
([architecture](../architecture.md#declarative-recipes-and-ai)): the same reads also
hide each username from the page as `[account]` before it is sent. As an implementation
consequence of the roadmap's "never sent", not a new decision, a username read that
fails now sends no page at all, not only no shape, since a username that was not read
cannot be hidden. An item whose username is empty or absent is flagged `empty` in the
catalog and is not read, so it still does not count and blocks nothing.

## Consequences

The service and the provider see the login pages of sites the owner has vault items
for, as structure and labels, once per page per day at most. With them go the length,
character classes and email form of the matching usernames when all agree, which the
request log keeps like the rest of the slots
([ADR 0012](0012-inference-request-log.md)). Other pages are never
observed, except the page shown right after the first sign-in with a generated recipe
(ADR 0018). A locked vault, a site without a vault item, or a login page that shows its
fields only after a click gets no automatic generation.

## Alternatives

- Manual: send a page only when the owner clicks the toolbar icon. Discloses only chosen
  pages but needs a click on every new site.
- Automatic on every page with a password input, without the vault match: also covers
  sites the vault does not know, but sends far more pages.
