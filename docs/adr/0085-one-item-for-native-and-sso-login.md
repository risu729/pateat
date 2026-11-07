# ADR 0085: One vault item for a site account's password and SSO sign-ins

Status: accepted by the owner on 2026-11-07 (12:51 UTC: the proposal of
[#1380](https://github.com/risu729/pateat/issues/1380) "can be applied as written"); not
implemented. Amends [ADR 0026](0026-sign-in-through-identity-providers.md) (the item
format, which item may be used on the identity provider's pages, and password logins of
an item with `SSO`) and [ADR 0027](0027-per-account-login-routes.md) (the `sso` fact and
the route order of the `sso` route, delivery 5). The `sso` route itself is still
unimplemented, so nothing here changes current behavior.

Date: 2026-11-07

## Context

ADR 0026 gives a site that signs in through an identity provider (IdP) its own Bitwarden
item: an empty password, the IdP account's username as its Username and a Text or
Hidden custom field `SSO` holding the IdP's origin. It also rules that an item with
`SSO` is never used by a password recipe, even with a password, and is never a
candidate on the IdP's pages.

Many site accounts accept both their own password and one or more IdPs, such as
LeetCode (password, Google and GitHub). Under ADR 0026 each such account needs one item
per sign-in method, so the account picker
([ADR 0021](0021-account-choice-outside-settings.md)) shows one account several times,
and an item that is both a site account and an IdP account (GitHub, signed in to with
Google and used to sign in to LeetCode) cannot be both. The owner's vault already holds
such separate method-only items, as seen on LeetCode
([#1373](https://github.com/risu729/pateat/issues/1373)) and Devpost
([#1374](https://github.com/risu729/pateat/issues/1374)); those observations do not show
whether the items reach the same account or caused the stalls.

## Decision

### Item format

One Bitwarden login item per site account holds every way of signing in to that
account. Pateat never needs a second item for the same account.

- **SSO-only, one IdP: unchanged.** Username is the IdP account's username, Password is
  empty, and one Text or Hidden field `SSO` holds the IdP's origin, read as in ADR 0026.
  This URL-valued `SSO` field means the item has no password sign-in of its own: its
  Username is not a site username.
- **A site password and SSO, or several IdPs.** The item keeps its own Username,
  Password, TOTP, passkeys, URIs and other fields, and gets one Text or Hidden field per
  SSO method:

  | Field name | Value                         |
  | ---------- | ----------------------------- |
  | `SSO`      | `[GitHub] github-user`        |
  | `SSO 2`    | `[Google] person@example.com` |

  - The text in brackets is the IdP's label, as a person reads it on the site's button
    ("Continue with GitHub"). It is not a domain and need not be the IdP item's name.
  - The rest of the value is the username of the IdP account, stored in the IdP's own
    item. It is always written, even when it equals the site's Username, and is never
    taken from the site's Username.
  - Further methods are `SSO 3` and so on. The value is parsed locally by fixed syntax,
    never by a model, and never rewritten.
  - An SSO-only account with several IdPs uses the bracket form with an empty password,
    still as one item.
- One item never mixes the URL form with the bracket form.

| Account                                      | Username / Password              | Fields                                                                  |
| -------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------- |
| SSO-only site (unchanged)                    | `person@example.com` / empty     | `SSO` = `https://accounts.google.com`                                   |
| Devpost: own password and Google             | `devpost-user@example.com` / set | `SSO` = `[Google] person@example.com`                                   |
| LeetCode: own password, Google and GitHub    | `coding-user` / set              | `SSO` = `[Google] person@example.com`, `SSO 2` = `[GitHub] github-user` |
| connpass: own password, GitHub and X         | `events-user` / set              | `SSO` = `[GitHub] github-user`, `SSO 2` = `[X] x-login@example.com`     |
| GitHub: own password and Google, also an IdP | `github-user` / set              | `SSO` = `[Google] person@example.com`                                   |

All identifiers are fictional; the services only illustrate the format.

### Which method is used

- The site account is chosen first (ADR 0021), then one of its methods. Methods are
  never shown as separate accounts.
- The automatic order stays passkey, then SSO, then the site password (ADR 0027). The
  automatic SSO method is the unsuffixed `SSO`; `SSO 2` and later are explicit choices
  and never a list to retry. Neither the fields' order in the item nor the buttons'
  order on the page chooses a method. The person can choose the password or another IdP
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
2. A known, unambiguous mapping from label to IdP item and origin is reused. An unknown
   or ambiguous one is chosen by the person among their saved IdP accounts and origins;
   the site's text or a model cannot set it.
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

- The site password route uses the site item's own Username and Password; an item with
  the URL form has none.
- An SSO route uses the field's mapping and the chosen IdP item's own credentials.
- An item with bracket `SSO` fields stays a candidate on its own site and, as an IdP,
  for direct sign-in with its passkey or password. During LeetCode → GitHub, the GitHub
  item is used for GitHub's own sign-in, and its `SSO` = `[Google] …` route is not
  offered: an IdP that signs in through another IdP still stops (ADR 0026).

### Field rules

- The names `SSO` and `SSO <number>` on Text and Hidden fields are reserved. Such a
  field is never a fill binding or a custom-field offer, never read for a Text shape,
  never generated as a slot, never filled into a page and never sent to the service or a
  model. Excluding such a field from automatic fill
  ([ADR 0023](0023-synced-vault-policy.md)) turns that method off.
- The login stops on: brackets that do not parse, an empty label or username, a
  duplicate field name or method number, two methods that resolve to the same IdP
  account, the URL and bracket forms on one item, and a mapping that does not resolve.
  The message and diagnostics name the field and the error, never its value.
- Username matching ignores surrounding spaces and letter case, as in ADR 0026; the
  implementation records the exact whitespace and label rules with its tests.
- Permission and account creation pages still stop, and success is still the site's own
  signed-in state.

## Alternatives

- A separate provider field and username field per method, or JSON in one field:
  rejected by the owner; one readable value per method is easier to keep by hand.
- One item per method (ADR 0026 as written): splits one account across items and
  shows it several times in the picker.
- Field order or page order as the method order: an edit in Bitwarden or on the site
  would change the method silently.

## Consequences

- Until the `sso` route ships, Pateat does not understand either form, and an item in
  the bracket form is used like any other item. The new format should not be applied
  to live vault items before the implementation, and redundant method-only items stay
  until then.
- After the implementation, consolidation is done on a small confirmed example first,
  keeping native credentials, TOTP, passkeys, URIs and match rules, notes, other fields
  and the account's defaults and bindings. A matching domain, email or IdP grant alone
  does not prove two items are the same account: each method is checked to reach the
  same existing account before the redundant item goes to Bitwarden's recoverable
  trash. No grant is revoked and no password overwritten on the way. Implementation,
  consolidation and real-site checks are reported separately.
- The tests cover the URL form, site and IdP usernames that differ, several IdPs,
  unknown and ambiguous labels, IdP items with several URIs, excluded fields, invalid
  syntax, stale mappings, an item used both as a site account and an IdP, no nested IdP
  sign-in and no unsafe fallback.
- Real-site checks need real accounts and separate owner approval, as in ADR 0026.
