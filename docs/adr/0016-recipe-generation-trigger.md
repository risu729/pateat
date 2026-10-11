# ADR 0016: Automatic recipe generation on pages with a vault match

Status: accepted by the owner on 2026-10-11. Amends
[ADR 0009](0009-install-time-https-site-access.md); amended by
[ADR 0018](0018-recipe-generation-route.md). Implemented in the extension
([Background execution](../architecture.md#background-execution)); the service route
enforces the 24-hour rule as well
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

A top-level HTTPS document without a cached recipe for its origin is observed and sent
for recipe generation automatically when all of these hold:

1. The site is not excluded.
2. The vault has at least one item whose URI matches the origin under the existing
   provider URI rules. This is the only vault access a document without a recipe gets;
   it needs an unlocked vault and does not read field values.
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
- Frames are not sent; only the tab's own page is.

## Consequences

The service and the provider see the login pages of sites the owner has vault items
for, as structure and labels, once per page per day at most. Other pages are never
observed, except the page shown right after the first sign-in with a generated recipe
(ADR 0018). A locked vault, a site without a vault item, or a login page that shows its
fields only after a click gets no automatic generation.

## Alternatives

- Manual: send a page only when the owner clicks the toolbar icon. Discloses only chosen
  pages but needs a click on every new site.
- Automatic on every page with a password input, without the vault match: also covers
  sites the vault does not know, but sends far more pages.
