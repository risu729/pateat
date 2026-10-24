# ADR 0053: Generation on passkey-only start pages

Status: accepted by the owner on 2026-10-19, implemented. The owner brought this phase-4
item into the current work and had ADR 0016 and ADR 0027 amended for it on 2026-10-19
(13:36 UTC, 「今入れる」), and decided its rules through decision cards that day (UTC):
send a page only when a URI-matching item holds a passkey for its RP ID (14:08); keep
生体認証 and widen the passkey button words, "broad is fine" (20:29); give such pages
their own generation instructions (20:30, card), with the standing rule
「指示は汎用化する必要がない、分けてよい」 ("instructions need not be generalized;
splitting them is fine", 20:30); and the recipe shape `passkeyOnly: true`, `slots: []`,
one click (20:31); and, on a page that also shows a sign-in entry or a list of accounts,
the method each item can use (22:44, card 「項目で分ける」, "split by item"). That such
pages share the no-input page wait was decided the same day (20:23). Amends
[ADR 0016](0016-recipe-generation-trigger.md) (conditions 2 and 3) and
[ADR 0027](0027-per-account-login-routes.md) (passkey-only start pages are generated;
wider passkey words). Preserves [ADR 0034](0034-answer-page-passkey-requests.md)'s
delegation of passkey requests on pages without a recipe.

Date: 2026-10-17 (proposed); accepted 2026-10-19

## Context

Generation sends a page without a recipe when it shows a sign-in input (a password,
username or one-time-code input), asks for an account identifier alone
([ADR 0016](0016-recipe-generation-trigger.md)), lists accounts
([ADR 0028](0028-account-chooser-login-pages.md)) or, without any input, holds the
site's sign-in entry ([ADR 0031](0031-sign-in-entry-pages.md)). A start page whose only
way in is a button that signs in with an existing passkey matched none of these, so it
got no recipe even when a matching vault item holds a passkey for the site.

## Decision

Owner decisions of 2026-10-19:

1. **Qualifying page.** ADR 0016 condition 3 also admits a top-level page with no
   input that shows only a button naming a passkey or security key, when a URI-matching
   item holds a passkey for the site. Such pages are now generated, as an exception to
   ADR 0027's "start pages without a password input are never generated"; SSO-only
   start pages still are not.
2. **Vault check.** The page is sent only when an eligible URI-matching item holds a
   discoverable, usable passkey for the page's RP ID: the lookup ADR 0034 uses for a
   popup choice (`passkeyItems`), matched against the same items as the URI match. This
   is a second vault access for a document without a recipe, an exception to ADR 0016
   condition 2. No value or passkey fact leaves the device; the request carries only
   `passkeyOnly: true`.
3. **Wait.** The page is decided in the content script's no-input page wait of
   [ADR 0057](0057-decide-no-input-pages-when-the-dom-is-quiet.md) (once the DOM is
   quiet for a second, at most 5 seconds), by the same decision as identifier-only
   pages, account lists and entry pages; it has no timer of its own. A change to that
   wait applies to it too.
4. **Words.** The words that name a passkey button keep 生体認証 and add Face ID, Touch
   ID, Windows Hello, biometric(s), fingerprint(s), face recognition, 指紋 and 顔認証
   (Latin as whole words, Japanese anywhere). The registration words are unchanged.
   The list is shared with ADR 0027's generated `passkey` route
   ([ADR 0027 amendment](0027-per-account-login-routes.md#amendment-2026-10-19-passkey-only-start-pages-and-wider-passkey-words)).
5. **Instructions.** A passkey-only request has its own generation instructions and
   prompt version (`passkeyOnlyGenerationInstructions`), as an entry request does; the
   generation role's instructions are unchanged. Standing rule: instructions per page
   kind are preferred to generalizing the shared prompt.
6. **Recipe shape.** `passkeyOnly: true`, `slots: []`, one click step on the button
   with purpose `submit`, `maxSubmissions: 1`, and the same button as the `passkey`
   route; there is no `password` route.
7. **Beside an entry or a list.** On a page that shows a passkey button beside an ADR
   0031 sign-in entry or an ADR 0028 list of accounts, including one by names only, an
   item that holds a discoverable passkey for the RP ID uses the passkey button, and
   another uses the entry or the list exactly as on a page without the button, so
   every item logs in with the method it can use, with no site rule
   ([ADR 0033](0033-no-site-specific-features.md)). How this applies to the page's one
   recipe is an implementation detail below.

What happens to such a recipe once its items lose their passkey is separate work, not
part of this decision.

Implementation details chosen by the agent, not confirmed by the owner separately:

- The passkey lookup runs only once an item's URI matched (the lookup itself is per RP
  ID, not per item); with no match the page logs `no-item` and the like, as other pages
  do.
- The extractor (`extractPasskeyObservation`) qualifies a page with no fillable,
  unsupported or shadow-root field (since
  [ADR 0070](0070-shadow-roots-as-page-content.md), a shadow tree's field is the page's
  own) and one to 48 enabled, locatable buttons whose label or locator names a passkey
  and not a registration; it sends only those buttons, in the same value-free
  observation as other pages. A list of accounts by email or an identifier input goes
  first; a list by names only, or an address that is no account entry (such as a heading
  or a support address beside the button), does not hide the passkey page. The content
  script announces the passkey page together with the list and entry it would announce
  without the button, and the runtime chooses: the passkey lookup first, then the list
  and entry handling unchanged, logged as such rather than as `no-passkey`. A page with
  neither logs `no-passkey`.
- Decision 7 on a shared recipe: a page has one recipe for all its items, and an item
  without a passkey cannot run a passkey-only one (it gets `no-route`, and ADR 0058 A
  would revoke it and regenerate the same page while another item still holds a
  passkey). So a page that also shows an entry or a list is sent as a passkey-only page
  only when every URI-matching item holds a discoverable passkey for the RP ID;
  otherwise its entry or list is sent, which every item can use. A page with only the
  button keeps decision 2: one such item is enough, since there is nothing else to
  send.
- The page right after a submitted password form is not sent, by the existing
  post-submission guard; a manual passkey exchange without a password form is not seen
  as a submission.
- The request has no `base` or `branch` and its observation no fill field or account
  list. The plan check accepts only `fields: []` and one `submit` action on a `button`
  candidate that names a passkey and not a registration, also named as `passkeyButton`.
- A recipe is used through the ordinary account choice and the `passkey` route: an item
  without a discoverable passkey gets `no-route` and never presses the button.
- After a logout ([ADR 0021](0021-account-choice-outside-settings.md) D), the start page
  showing again in the tab asks for an account and presses nothing, as for any passkey
  route (covered by a runtime test).
- For an item with a password and no discoverable passkey,
  [ADR 0058](0058-automatic-recipe-removal.md) A, as amended by
  [ADR 0041](0041-repair-stale-recipes.md), claims a repair of a passkey-only recipe
  for the `password` route (once per device and route in 3 days). The start page is
  sent as the list of accounts it shows beside the button, which a chooser then serves
  for every item as decision 7 asks, or as a sign-in form it shows by now. A page with
  only the button, or the button beside an entry, is refused with `no-route` and the
  claim given back: decision 7's entry is not yet used for such an item. The button is
  never pressed.

## Consequences

No permission, provider capability, site rule or account operation is added. A
conditional passkey request alone never qualifies a page or authorizes a signature, and
pages without a recipe still delegate their requests. Each such page costs one
generation call at most once in ADR 0016's 10-minute window. A page with a passkey
button beside an entry or a list checks the vault for passkeys before the list or
entry is handled, and its sent recipe depends on which items match on the device that
sent it first. The wider words also widen
what ADR 0027's generated `passkey` route keeps. Only local fake-model and synthetic
tests cover this; no real site, paid inference or deployment is claimed.

## Alternatives

- Keep passkey-only generation in phase 4, with manual recipes only.
- Generate from every page that makes a conditional passkey request: exposes ordinary
  pages and lacks a clear sign-in intent.
- Store the passkey button as a `password` route: a password-only item would press a
  button it cannot complete.
- Add a passkey line to the generation role's instructions (as the first implementation
  did): changes the shared prompt for every page; the owner preferred a separate text.
