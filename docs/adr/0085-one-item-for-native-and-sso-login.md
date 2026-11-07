# ADR 0085: One vault item for a site account's password and SSO sign-ins

Status: accepted by the owner on 2026-11-07 (12:51 UTC:
「これはそのまま反映していいです」, the proposal of
[#1380](https://github.com/risu729/pateat/issues/1380) applied as written); not
implemented. The owner asked for the format itself: keep the SSO-only format, keep a
mixed account's own credentials, one readable value such as `[GitHub] github-user` per
SSO method, and no separate provider and username fields or JSON. The selection and
validation rules below were written in
[#1380](https://github.com/risu729/pateat/issues/1380) as proposed implementation
details and were accepted with it. Amends
[ADR 0026](0026-sign-in-through-identity-providers.md) (item format, which IdP item is
used, field rules and item-wide exclusions) and
[ADR 0027](0027-per-account-login-routes.md) (the `sso` fact, the route order, the
custom-field offers and what the model receives), each in a dated amendment section. The
`sso` route itself is still unimplemented (ADR 0027 delivery 5); the reserved field
names are implemented
([amendment](#amendment-2026-11-07-the-reserved-field-names-implemented)).

Date: 2026-11-07

## Context

ADR 0026 gives a site that signs in through an identity provider (IdP) its own Bitwarden
item: an empty password, the IdP account's username as its Username and a Text or
Hidden custom field `SSO` holding the IdP's origin. An item with `SSO` is never used by
a password recipe, even with a password, and is never a candidate on the IdP's pages.

A site account that accepts its own password and one or more IdPs therefore needs one
item per sign-in method, so the account picker
([ADR 0021](0021-account-choice-outside-settings.md)) shows one account several times.
A GitHub item that is signed in to with Google cannot also be the IdP account for
another site, since an item with `SSO` is never a candidate on the IdP's pages. The
owner's observations on LeetCode
([#1373](https://github.com/risu729/pateat/issues/1373)) and Devpost
([#1374](https://github.com/risu729/pateat/issues/1374)) mention separate password and
SSO items; they do not show whether those items reach the same account or caused the
stalls.

## Decision

### Item format

One Bitwarden login item per site account holds all of that account's password and SSO
methods.

- **The URL form, for an SSO-only account with one IdP: unchanged.** Username is the IdP
  account's username, Password is empty, and one Text or Hidden field `SSO` holds the
  IdP's origin, such as `SSO` = `https://accounts.google.com`, read as in ADR 0026.
- **The bracket form, for an account with its own password and SSO, or with several
  IdPs.** The item keeps its own Username, Password, TOTP, passkeys, URIs and other
  data, and gets one Text or Hidden field per SSO method:

  | Field name | Value                         |
  | ---------- | ----------------------------- |
  | `SSO`      | `[GitHub] github-user`        |
  | `SSO 2`    | `[Google] person@example.com` |

  - The text in brackets is a label a person can read, matching buttons such as
    "Continue with GitHub". It is not a domain and need not be the IdP item's name.
  - The rest is the username stored in that IdP's own item. It is always written, even
    when it equals the site's Username.
  - One method takes one field; further methods are `SSO 3` and so on, never another
    item for the same account. The value is parsed locally by fixed syntax, never by a
    model, and never rewritten.
- One item never mixes the URL form with the bracket form, and a mixed item's IdP
  username is never taken from its own Username.
- Proposed in #1380 and accepted with it: the unsuffixed `SSO` is the automatic method;
  `SSO 2` and later are explicit alternatives, not a list to retry; neither the fields'
  order in the item nor the buttons' order on the page chooses a method. An SSO-only
  account with several IdPs uses the bracket form with an empty password, still as one
  item.

All identifiers below are fictional. The services illustrate the format only; the table
does not claim that these sites work with Pateat today or that the owner's grants reach
the same account. "Set" means the item keeps its existing password.

| Account                                      | Username / Password              | Fields                                                                  |
| -------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| SSO-only site (unchanged)                    | `person@example.com` / empty     | `SSO` = `https://accounts.google.com`                                   |
| Devpost: own password and Google             | `devpost-user@example.com` / set | `SSO` = `[Google] person@example.com`                                   |
| LeetCode: own password, Google and GitHub    | `coding-user` / set              | `SSO` = `[Google] person@example.com`, `SSO 2` = `[GitHub] github-user` |
| connpass: own password, GitHub and X         | `events-user` / set              | `SSO` = `[GitHub] github-user`, `SSO 2` = `[X] x-login@example.com`     |
| GitHub: own password and Google, also an IdP | `github-user` / set              | `SSO` = `[Google] person@example.com`                                   |

### Which method is used

- The site account is chosen first (ADR 0021), then one of its methods. Methods are
  never shown as separate accounts.
- The automatic order stays passkey, then the preferred SSO method, then the `password`
  route (ADR 0027). The person can choose the `password` route or another IdP
  explicitly.
- A configured SSO method that cannot be resolved safely stops with a message saying
  why; Pateat never silently uses another method instead.
- A failed sign-in, malformed fields, a missing or ambiguous IdP account, a permission
  page and an account creation page never make Pateat switch to the password, another
  IdP or another account.

### From a label to an IdP account and origin

A label is not permission to send credentials anywhere.

1. Pateat resolves the label and the username locally to exactly one eligible saved IdP
   item and one permitted origin from that item's own URIs. The username alone does not
   name the IdP, since one email can exist at Google, Microsoft and GitHub. Pateat never
   assumes a label equals an item name, guesses an IdP's domain or takes an item's first
   URI.
2. A known, unambiguous mapping is reused. An unknown or ambiguous one is chosen by the
   person among their saved IdP accounts and origins; the site's text or a model's guess
   cannot set it.
3. The mapping is resolved before anything is clicked. A model may find the site's
   button or link for the label when the recipe is generated, and a valid saved recipe
   is reused without asking a model on every login, but the model never chooses where
   credentials may go. Recipe navigation limits still hold, and the IdP's sign-in page
   must be on the permitted origin before any credential is released.
4. Only the label and the page's candidate elements are sent to infer the route. The
   IdP username, credential values and the mapping stay local. A learned button never
   changes the chosen IdP account.
5. Origin, account, tab, frame and document checks stay as they are; a redirect or a
   permission page grants nothing more.

There is no fixed list of IdPs (ADR 0033): a custom label works once it is mapped to a
saved IdP account and permitted origin.

### Which credentials each route may use

ADR 0026's item-wide exclusions are replaced by rules per route:

- The `password` route uses the site item's own Username and Password. An item in the
  URL form has no `password` route, since its Username is the IdP's (agent's reading of
  ADR 0026 and #1380, not confirmed by the owner).
- The `sso` route uses the field's mapping and the chosen IdP item's own credentials.
- During LeetCode → GitHub, a GitHub item in the bracket form stays a candidate for
  GitHub's own sign-in with its passkey or password, and its `SSO` = `[Google] …` route
  is not offered there: an IdP that signs in through another IdP still stops (ADR 0026).

### Field rules

- Custom fields named `SSO` or `SSO <number>` are reserved. Such a field is never a fill
  binding or a custom-field offer, never read for a Text shape, never generated as a
  slot, never filled into a page and never sent to the service or a model, except its
  label, which goes through the service to the model to find the site's button (point 4
  above). A Linked field that reads such a field is treated the same (agent's addition,
  not confirmed by the owner). Excluding such a field from automatic fill
  ([ADR 0023](0023-synced-vault-policy.md)) turns that method off.
- The login stops on brackets that do not parse, an empty label or username, a
  duplicate field name or method number, two methods that resolve to the same IdP
  account, the URL and bracket forms on one item, and a mapping that does not resolve.
  The message and diagnostics name the field and the error, never its value.
- Whitespace and username normalization must be defined explicitly and consistently with
  account matching (ADR 0026: surrounding spaces and letter case are ignored). The
  exact rules are added to this ADR when the implementation chooses them.
- Permission and account creation pages still stop, and success is still the site's own
  signed-in state.

## Alternatives

- A separate provider field and username field per method, or JSON in one field:
  rejected by the owner.
- One item per method (ADR 0026 as written): splits one account across items and shows
  it several times in the picker.

## Consequences

- Until the `sso` route ships, Pateat does not understand either form, and an item in
  the bracket form is used like any other item. The one exception, since 2026-11-07, is
  an item with an `SSO` field and no password, which is not counted when several items
  match a page
  ([ADR 0026](0026-sign-in-through-identity-providers.md#implementation-2026-11-07-sso-only-items-in-the-account-choice)).
  The new format is not applied to live vault items before then.
- No new method-only item is created for a confirmed site account. Existing mappings
  are reviewed before consolidation: a matching domain, email or IdP grant alone does
  not prove two items are the same account.
- With a supported installed build, a small confirmed example is migrated first, keeping
  its own credentials, TOTP, passkeys, URIs and match rules, notes, other custom fields
  and the account's defaults and bindings. Each method is checked to reach the same
  existing account before a redundant method-only item goes to Bitwarden's recoverable
  trash. No grant is revoked and no password overwritten on the way. Implementation,
  consolidation and real-site checks are reported separately.
- The tests cover the URL form, site and IdP usernames that differ, several IdPs,
  unknown and ambiguous labels, IdP items with several URIs, excluded fields, invalid
  syntax, stale mappings, an item used both as a site account and an IdP, no nested IdP
  sign-in and no unsafe fallback.
- Real-site checks need real accounts and separate owner approval, as in ADR 0026.

## Amendment 2026-11-07: the reserved field names, implemented

Chosen by an agent, not confirmed by the owner, after production generation requests
for `https://leetcode.com/accounts/login/` offered an item's `SSO` field as a fill slot.
`isSsoFieldName` in `packages/contracts/src/recipes.ts` reserves a custom-field name
when, after NFKC normalization and trimming surrounding white space, it is `SSO`, or
`SSO` and a number with any white space between, ignoring letter case: `SSO`, `sso 2`,
`ＳＳＯ　２` and `SSO 1` are reserved; `SSO2`, `SSO-2` and `SSO login` are not.

- `customFieldOffers` never offers such a field, nor a Linked field that reads one, so
  it is never read for a shape or generated as a slot.
- A saved binding that names such a field refuses `sso-field` before any field is read;
  a sibling binding used as a template or a generated slot map that names one is passed
  over, and refuses `sso-field` when no other fits; a `password` variant with such a
  binding is passed over for the next one, as for `field-missing`.
- `givesDetail` never takes such a field as a personal detail
  ([ADR 0061](0061-personal-details-during-a-login.md)).
- A binding saved before this that names such a field now refuses `sso-field` on every
  login of a one-variant recipe; revoking the recipe in the web UI has it generated
  again without the field (ADR 0027).
