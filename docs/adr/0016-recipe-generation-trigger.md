# ADR 0016: Automatic recipe generation on pages with a vault match

Status: accepted by the owner on 2026-10-11. Amends
[ADR 0009](0009-install-time-https-site-access.md); amended by
[ADR 0018](0018-recipe-generation-route.md), by the owner's account-switch decision
of 2026-10-11 ([Pages where no recipe starts](#pages-where-no-recipe-starts)) and by
the owner's username shape decision of 2026-10-11 ([Username shape](#username-shape)).
Implemented in the extension
([Background execution](../architecture.md#background-execution)), including that
amendment; the service route enforces the 24-hour rule as well
([API README](../../services/api/README.md#recipe-generation)).

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
   `autocomplete="username"` or `autocomplete="one-time-code"`.
4. No generation was attempted for the same origin and path in the previous 24 hours,
   whatever its outcome (a recipe, an abstention or a failure).

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

- Only a page that shows such an input within 10 seconds of loading is sent, the same
  wait a login step gets; a form shown later, for example after a click, is not.
- The vault match is checked only once the input shows, and only matching items'
  built-in fields decide which of the `username`, `password` and `totp` slots are
  offered.
- The extension remembers a page as attempted when it sends it. It forgets the attempt
  only when the service could not be reached or answered `busy`, since no model call
  was made.
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
fill from (an excluded or quarantined item, or one awaiting custom-field review) are not
matching items here either. When an enabled connection could not answer, an item's URI
rules could not be evaluated, a username read fails, or a username is too long to shape
(over 1,024 characters), no shape is sent. The username itself never leaves the
extension.

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
