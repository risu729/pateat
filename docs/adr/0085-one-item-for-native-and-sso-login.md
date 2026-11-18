# ADR 0085: One vault item for a site account's password and SSO sign-ins

Status: accepted by the owner on 2026-11-07 (12:51 UTC:
「これはそのまま反映していいです」, the proposal of
[#1380](https://github.com/risu729/pateat/issues/1380) applied as written); not verified
on real accounts; the scoped route is implemented and checked with synthetic packaged
fixtures. Amended on 2026-11-12 by the local discovery
[amendment](#amendment-2026-11-12-local-method-discovery-and-mapping-validation);
the
[local mapping and method choice](#amendment-2026-11-12-local-mapping-and-method-choice)
adds the popup boundary; the
[coordinator integration](#implementation-2026-11-12-coordinator-integration) connects
execution. Also amended by the
[label-only generation implementation](#amendment-2026-11-12-label-only-declarative-route-generation),
and on 2026-11-16 by the owner's decision that
[SSO mappings sync with the settings](#amendment-2026-11-16-sso-mappings-sync-with-the-settings).
Amended on 2026-11-17 by an agent's fix that
[keeps an open method offer over settings it does not read](#amendment-2026-11-17-an-open-offer-outlasts-settings-it-does-not-read),
and on 2026-11-18 by an agent's fix that
[ends a Log in now method offer with its request](#amendment-2026-11-18-a-log-in-now-offer-ends-with-its-request).
Amended on 2026-11-18 by the owner (03:01 UTC,
[below](#amendment-2026-11-18-a-broker-pages-provider-entry)): a URL-form method with a
saved mapping presses a broker page's provider entry automatically; and by an agent's
choice the same day, a flow's
[RP return may land on another origin of the same site](#amendment-2026-11-18-an-rp-return-on-another-origin-of-the-same-site).
Amended again on 2026-11-18 by the owner (14:14 UTC,
[below](#amendment-2026-11-18-sso-starts-automatically-on-the-login-page)): SSO starts
automatically on the login page, also on a first visit, through the entry whose label
names the mapped IdP.
The owner asked for the format itself: keep the SSO-only format, keep a mixed account's
own credentials, one readable value such as `[GitHub] github-user` per SSO method, and
no separate provider and username fields or JSON. The selection and validation rules
below were written in [#1380](https://github.com/risu729/pateat/issues/1380) as proposed
implementation details and were accepted with it. Amends
[ADR 0026](0026-sign-in-through-identity-providers.md) (item format, which IdP item is
used, field rules and item-wide exclusions) and
[ADR 0027](0027-per-account-login-routes.md) (the `sso` fact, the route order, the
custom-field offers and what the model receives), each in a dated amendment section. The
`sso` route is now implemented (ADR 0027 delivery 5), with real-account compatibility
still open; the reserved field names are implemented
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
   IdP username and credential values stay local. The mapping syncs with the settings,
   as the owner decided on 2026-11-16
   ([amendment](#amendment-2026-11-16-sso-mappings-sync-with-the-settings)), and never
   goes to inference. A learned button never changes the chosen IdP account.
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

## Amendment 2026-11-12: local method discovery and mapping validation

Implementation details chosen by an agent within the accepted format; these do not
change the owner's item format or authorize a real-account operation. This foundation
implements local discovery only. The SSO route, generation, popup choice and coordinator
remain unimplemented until their dependent delivery; native route selection is
unchanged.

- Reserved field recognition uses `isSsoFieldName`; `ssoMethodName` interprets the same
  NFKC-normalized, trimmed, case-insensitive field name. Unsuffixed `SSO` is method 1;
  numbered alternatives are 2 through 1,000,000. Leading zeroes denote the same number,
  so `SSO 02` and `SSO 2` are duplicates. Reserved suffixes 0 and 1 are invalid methods.
- Values are trimmed around the whole value. Bracket syntax is exactly
  `[label] username`, with white space separating the closing bracket and username; each
  part is trimmed. Labels retain their spelling, up to 128 UTF-16 units. Usernames are
  compared after trimming and `toLowerCase()`, without Unicode compatibility
  normalization or aliases, up to 1,024 units. Brackets in either part refuse. Control
  characters (Unicode `Cc`, including tab and line breaks), format characters (`Cf`,
  such as bidirectional overrides and zero-width characters) and line and paragraph
  separators (`Zl`, `Zp`) refuse anywhere in the raw value, before trimming; surrounding
  other white space is trimmed. A value is at most 4,096 units, and an item has at most
  32 enabled methods. An item whose enabled fields mix the URL and bracket forms refuses
  `mixed-forms` before any one value is checked.
- The URL form is one unsuffixed enabled method with an empty stored password and a
  usable built-in username. Its absolute HTTP(S) URL is reduced to its origin. Any `@`
  in the authority, backslashes, white space and the characters refused above refuse. A
  trailing-dot host keeps its dot, so it names a different origin from the host without
  it, as browsers treat it. No host is inferred from a label, item name, username or URI
  order.
- Concrete IdP origins are enumerated from that IdP item's own non-Never URI rules. A
  rule that can never match a web page is ignored, as the native matcher ignores it: one
  with another scheme, such as the `androidapp:` and `iosapp:` URIs Bitwarden's mobile
  apps add, and a malformed one. A bare host such as `accounts.example.com` is read as
  `https://` for a Domain or Host rule, which match it on any scheme, and ignored for a
  StartsWith or Exact rule, which compare raw text that never begins a page URL. A Regex
  rule, an unavailable default match and an unsupported mode are reported, never
  silently treated as no match: they refuse discovery, but validation of a chosen origin
  that is among the item's own concrete origins does not depend on them.
- An IdP account never signs in through an IdP itself (ADR 0026). Only a Text or Hidden
  `SSO` field with a value counts, so an empty one or a Boolean or Linked field with
  that name changes nothing. An item with such a field not in the bracket form (enabled
  or not), or with an enabled one in the bracket form and neither a password nor a
  passkey of its own, is passed over in discovery and refused when chosen. A matching
  IdP item with an unreadable custom field, which could hide such a field, refuses
  discovery and validation with `field-unreadable`. The site account is never its own
  IdP account either.
- Methods are read from decrypted items for one call, then discarded. No new decrypted
  field cache is added to ADR 0080. The source operation returns an opaque username
  comparison proof under the existing offscreen document's HMAC key, domain-separated
  for SSO. The background holds that proof in memory for the call and passes it to each
  IdP connection's Worker, which compares it locally. Proofs are transient, are invalid
  when that offscreen key changes, and never go to storage, a popup or the service. A
  full decrypted native username confirms the cache's shortlist so a truncated display
  username cannot identify a different account.
- Public method descriptors contain only method number, form, automatic status and
  optional bracket label. A source reference contains the account, method number and
  SHA-256 of the encrypted source item; it contains no decrypted field value. The
  encrypted-source hash conservatively invalidates a saved mapping on any source change.
  Snapshot-bound field IDs and comparison proofs are not persistent method references.
- `createVaultSsoSource` checks current settings eligibility, exclusions, quarantine,
  timeout, durable vault state and snapshots. Discovery does not count as vault use.
  Validation rereads the source and exact chosen IdP item, compares usernames, checks
  that the chosen origin is in that item's own concrete URIs, then checks policy and
  snapshot continuity. Discovery checks every connection it considered again at the end,
  including vaults that gave no candidate, so a sync that adds a matching item is not
  missed. A candidate URI is no credential-release grant. Unknown mappings still need
  the local chooser of the
  [local mapping amendment](#amendment-2026-11-12-local-mapping-and-method-choice); a
  label alone never selects an IdP account. This foundation validates one method at a
  time; the mapping layer refuses when two enabled methods resolve to the same IdP
  account, before any click.
- A partly unreadable custom field can hide even the preferred method's name. Discovery
  conservatively refuses such a source rather than treating it as having no SSO. Errors
  contain fixed reason codes and the canonical field name, `SSO` or `SSO <n>`, never the
  field's stored spelling or value.

The URL form has no label to send to generation. Its future executor first looks for an
unambiguous local entry whose observed destination is the selected origin. Otherwise the
local popup must explicitly choose an observed entry and its displayed label, including
JavaScript-only buttons. Neither the origin nor the local mapping is sent to the
service. This is an agent's implementation detail, not a new owner decision.

## Amendment 2026-11-12: label-only declarative route generation

Implementation detail chosen by an agent. A bracket method's label from the local method
descriptors is the only method data a dedicated label-only generation mode accepts; it
writes separate SSO recipe layouts, documented in the
[ADR 0026 amendment](0026-sign-in-through-identity-providers.md#amendment-2026-11-12-declarative-sso-entry-generation).
The request accepts a label only as local discovery reads it, so no value refused above
reaches the service. The generation request has no fields for an IdP account, username,
origin, comparison proof or mapping. The label is the permitted exception; a native
route never receives an SSO custom field as a fill slot. Nothing calls this mode yet:
automatic route selection remains unchanged until the same-tab coordinator integrates
this foundation with the mapping chooser below. No live vault format has been migrated
and no real-account compatibility has been established.

An entry recipe ([ADR 0031](0031-sign-in-entry-pages.md)) holds no SSO entries: an
SSO request on its path is refused as a recipe conflict before any call. The entry
recipe is a document of its own with no layouts, so SSO entries beside it would need
their own layout removal, retention, provenance and entry rewrite rules. Neither the
entry nor the SSO entries run yet, and whether a site's SSO buttons are found on its
entry page or on the login page the entry opens is for the coordinator to decide.

## Amendment 2026-11-12: local mapping and method choice

Implementation details chosen by an agent within the accepted decision. The extension
has a local chooser controller, strict popup messages and a popup section for one
already chosen site account. This is a seam for the same-tab coordinator, not an enabled
SSO login: nothing calls it yet, so existing account cards and native admission keep
their behavior. A coordinator requests a choice, awaits an opaque, one-use choice ID,
then consumes it with fresh validation just before its own document-scoped operation.

- **Where mappings live.** In the synced settings, as the owner's `ssoMappings`, since
  the
  [amendment of 2026-11-16](#amendment-2026-11-16-sso-mappings-sync-with-the-settings).
  This section first kept them in a record on each device, which made a reinstall or
  another device choose each mapping again.
- **What a mapping holds.** The site account and method number, and the selected IdP
  account with its concrete origin. Both accounts are named by provider, server, user
  and item ID, as synced settings name accounts
  ([ADR 0023](0023-synced-vault-policy.md)), never by a per-device connection ID, so a
  reconnected connection or another device resolves the same mapping through whichever
  open connection holds the item; item IDs compare without letter case. A mapping holds
  no username, comparison proof, field ID, decrypted label, item evidence or vault
  snapshot. Every use validates both items again, as the amendment says, and
  validation is never a stored credential-release grant.
- **Choosing a mapping.** A saved mapping is validated directly, without discovery, so
  another item that refuses discovery cannot hold it back; the person can still ask to
  list other accounts. A method without one lists the person's saved IdP accounts and
  origins, and needs an explicit choice; the popup also replaces or removes one, even
  one whose items this device cannot resolve. The
  site's own account or origin is never its own IdP, and an account the catalog cannot
  identify refuses `vault-unavailable`.
- **Choosing a method.** Automatic selection takes a passkey, then the enabled `SSO`
  method, then, only for an item without an enabled `SSO` method, the `password` route.
  A malformed, unmapped or unresolved preferred method never falls back: the choice
  stays open with its reason, or stops. An SSO route validates its own method again and
  refuses when another mapped method names the same IdP account, even through two
  connections to one provider account. A native route needs no SSO method to be mapped
  or valid, so an explicit passkey or password stays available beside an unresolved
  one; only a site item whose SSO fields cannot be read or parsed blocks every route. A
  numbered method or an
  explicit native choice applies only to this sign-in and saves no site or IdP default.
  During an IdP hop only that account's native routes are offered.
- **A refused passkey.** [ADR 0034](0034-answer-page-passkey-requests.md) rule 6 goes
  back to the password when the site refuses a passkey. For an item with an enabled
  `SSO` method, this ADR's order puts that method before the password, so the
  coordinator requests a new automatic choice without the passkey route: it lands on
  the validated preferred SSO method, or stops with that method's reason. Only an item
  without an enabled `SSO` method goes back to the password as rule 6 says.
- **The URL form.** It has no label. The coordinator supplies the entries it observed on
  the page by opaque ID with a freshness check: at most 100, each with a unique ID and a
  label of at most 200 characters, or the request refuses `entry-invalid`. The popup
  chooses one with its displayed label; a bracket method takes no entry. The exact
  target stays with the coordinator, and the entry is checked again when chosen and
  when consumed.
- **Offers and receipts.** They hold no credentials and stay in worker memory for at
  most ten minutes. Cancelling, a settings change other than an SSO mapping saved or
  removed, closing the tab, a vault notice after
  which the offer's accounts no longer match the catalog, and a new document or path in
  the offer's own frame or the top frame withdraw them. Paths are compared as observed,
  so a new query or fragment and a vault status read that changes nothing keep an
  offer. A request that fails while preparing ends with `unavailable`, and the popup
  sees an offer only after its automatic decision. A worker restart discards them.

This layer itself performs no click, navigation, credential release, service request or
real-account operation; the coordinator below does, under its own fences.

## Implementation 2026-11-12: coordinator integration

The local chooser now feeds the same-tab coordinator described in
[ADR 0026](0026-sign-in-through-identity-providers.md#implementation-2026-11-12-scoped-coordinator).
The bracket form keeps the RP account's native credentials and identity. The URL form
keeps its legacy IdP-username meaning and requires positive RP marker evidence on
return; that username is not a guessed RP identity. One exact observed URL entry can be
chosen locally; ambiguous or JavaScript-only entries need the popup's explicit
selection. Only the chosen method's public label and redacted RP candidates reach
generation. Malformed, unavailable or unresolved preferred methods never silently choose
a native password. Completion stores only the RP's confirmed account choice and proof. A
passkey the automatic choice picked and the site refused ends that native login without
the password, and the tab's next choice leaves the passkey out, as **A refused passkey**
above says. A passkey the person picked explicitly kept rule 6 until the
[review of 2026-11-16](#review-hardening-2026-11-16-a-refused-passkey-the-person-picked).

Synthetic packaged execution uses encrypted fixtures. The owning plan retains the
installed-user-browser and real-account gates. Implementation does not migrate an
account, create an account, or authorize a new grant.

## Review hardening 2026-11-16: a refused passkey the person picked

Chosen in review, not confirmed by the owner. On an item with SSO methods, a passkey
the person picked for **Log in now** and the site refused no longer goes back to the
password either: that native login stops without filling or clicking anything, and the
popup's next method choice for that account leaves the passkey out, so the person
chooses an SSO method or the password again. Nothing chooses a method by itself after
the person's own pick. Only an item with no SSO method, and an IdP's own login during an
SSO hop, keep [ADR 0034](0034-answer-page-passkey-requests.md) rule 6. Either way, only
the login the native choice itself started counts: the choice names that login when it
starts on the choice's own document, and a later login of the same account in the tab
falls back as any native login does.

## Amendment 2026-11-16: SSO mappings sync with the settings

The owner decided on 2026-11-16 that SSO mappings sync in full, the IdP origin included,
through the normal settings sync like every other setting, so that no device has to
choose them again. The rest of this section is implementation detail chosen by an agent
within that decision.

- **Why it may sync.** The service already knows which vault item signs in where: an
  account binding and a site default name a site's origin with its vault item by
  provider, server, user and item ID, and every setting syncs
  ([ADR 0013](0013-service-held-recipes-and-settings.md)). A mapping adds which of the
  person's own saved items an SSO method of a site item uses, and that item's own
  sign-in origin. It holds no username, credential, decrypted field value or proof, so
  point 4 of
  [From a label to an IdP account and origin](#from-a-label-to-an-idp-account-and-origin)
  still keeps every value local. The service is the source of truth for mappings as for
  the rest of the settings.
- **The setting.** `ssoMappings` is an owner part shared by every profile, as `bindings`
  and `detailLinks` are ([ADR 0024](0024-settings-profiles.md)). Each entry names the
  site item, the method number, and the IdP item with its origin; the schema refuses
  any other field. There are at most 200, one per site item and method, with item IDs
  compared without letter case. One takes about 300 bytes, so a full list stays near
  half of the 120 KiB settings document. Sync merges them per site item and method, as
  bindings merge, and a profile switch keeps them; a settings export carries them and
  counts them as other settings.
- **Nothing stays on the device.** Offers and receipts are per-login runtime state, not
  settings, and stay in worker memory as before. The connection that holds an item is
  found at each use. The device record `pateat.login.sso-mappings.v1` is no longer read.
- **No stored evidence.** A mapping keeps no hash of the site item: every use validates
  it again before anything is clicked. The site item must still have that method,
  ready and parsed now; the IdP item must be eligible, active, not quarantined, not
  signing in through an IdP itself, with a username equal to the method's username now
  and the mapped origin among its own URI origins now; and a URL-form method's address
  must still be that origin, on an item whose password is still empty. A credential
  therefore only ever goes to an origin of its own item, for a username the site item
  names now. An edit that keeps all of that, such as a bracket label renamed on a site
  item whose method still names the same username, keeps the mapping; the person
  replaces or removes it in the popup. A hash of the encrypted item, as the device
  record kept, changed on any edit of the item, so a moved folder or a favorite
  withdrew the mapping on every device.
- **A relabel to another IdP with the same username.** When `[GitHub] alice` becomes
  `[GitLab] alice`, the mapping to the GitHub item still validates: the username and
  the GitHub item's own origin still fit, and nothing records which IdP the label
  named. The flow presses the site's GitLab entry, the tab reaches the GitLab origin,
  which is not the mapped origin, and the flow stops there (`sso-forbidden-origin`)
  without releasing anything: credentials only go to the mapped origin
  (`ssoCurrent`, `ssoAdmit`). In automatic mode every later sign-in with that method
  stops the same way until the person replaces the mapping in the popup, as nothing
  marks the method as failing. A record of the stopped method would have to outlive a
  worker restart to help, so this is left to the person for now.
- **Saving.** A choice in the popup writes the mapping to the settings at once, with
  the `sso-mapping` cause, and uploads it as an account choice is uploaded. A save
  refuses before it writes when the list or the settings document would be full
  (`mapping-limit`), and a write that fails says so (`mapping-save-failed`); the popup
  never shows a mapping that was not saved. Removing one is never refused for size, and
  saving one as it is, or removing one already gone, writes nothing.
- **Running work keeps such a revision.** A login or SSO flow holds the IdP account
  and origin it was given and never reads the mapping again, and an open method offer
  holds its own copy of its site item's mappings, which it compares on every check.
  `sso-mapping` is therefore one of the choice-only causes
  ([choice-only revisions](../architecture.md#choice-only-revisions)): a settings
  revision whose recorded causes since the one something was authorized with are all
  choice-only (`onlyChoicesSince`) keeps running and resumed logins, open method
  offers, SSO flows and their scope checks, passkey requests, confirmation fills,
  binding reviews, detail fills and the account choice a login saves. Any other cause,
  or a revision whose cause the 16-entry history no longer holds, stops them as
  before. A sync that brings another device's mapping is a settings sync and stops
  them as every sync does.
- **Another tab's mapping.** An open offer whose site item's mappings another tab, or
  another device through a sync, saved or removed since it was made is withdrawn on
  its next check, and a write that finds them changed in the store refuses
  (`scope-changed`), so no tab chooses with, or overwrites, a mapping it did not show.
- **A running flow keeps its account when its mapping is removed.** The mapping only
  chose the IdP account and origin of that one sign-in. A flow already running keeps
  them; it validates that selection again at each step and releases credentials only
  on the selected origin (`work.selected.origin`). The next sign-in reads the settings
  again and finds no mapping.
- **Deleted items.** A vault sync drops the mappings whose site or IdP item this
  account's previous accepted snapshot held and the new one no longer lists. An item
  this device cannot read, as one of an unknown organization, of an unsupported type
  or malformed, is still listed and keeps its mappings. A first sync, or a previous
  snapshot of another user, drops nothing, and nothing else prunes mappings: a device
  without a connection or item keeps them for the devices that have one.
- **Mappings no device can resolve.** The service cannot tell that an account is gone
  from every device: devices do not report their vault connections, and one offline
  for months may still hold one. So nothing prunes a mapping by account. The service's
  Vaults page lists every mapping by item ID, says when no vault settings name its
  account, and removes one, which needs no vault; the popup removes one on its site.

## Amendment 2026-11-17: an open offer outlasts settings it does not read

Chosen by an agent to fix
[#1687](https://github.com/risu729/pateat/issues/1687), not confirmed by the owner. On
`flow.idp.hashicorp.com`, a URL-form method waiting for the person's mapping and entry
ended with `settings-changed` a few seconds after each page load, with no vault edit in
between: every settings change, synced from the service or saved on the device, withdrew
every open method offer, and an offer's own checks withdrew it after any revision whose
cause was not choice-only. A sync of another site's account choice, the theme or a vault
check therefore ended the choice the person was about to answer.

- **What an offer reads.** An open offer, its receipt and a request still reading the
  settings now depend on what they read, as an SSO flow already does
  (`ssoScopeDependencies`): the site account's eligibility, item and connection, and
  that of each method's selected IdP account and of the IdP account each saved mapping
  named when the offer was made; the sign-in page permission, site rules and
  master-password asks of the site and of those IdP origins; the saved defaults of the
  site and of those IdP origins, which the flow that follows reads too, so an offer no
  longer outlives an IdP default that would end the flow at its start; and
  private-window pausing. A mapping refused for its IdP account's settings therefore
  ends its offer once the person changes those settings, and the next sign-in tries
  it again. The site item's mappings stay the offer's own copy, as above, and the
  catalog is still compared as a whole. The passkey policy is not among them: only a
  passkey assertion reads it, at signing time.
- **A settings change.** It withdraws only the offers whose dependencies changed, with
  `settings-changed`; any other offer stays open and is checked against the new
  settings. A request whose settings read a change outran reads them again, ends with
  `settings-changed` when the newer read changes what it reads, and otherwise builds its
  offer from the newer read.
- **The coordinator's own read.** The coordinator chooses the site account and admits
  the page under its own settings read, before it requests the method choice. It hands
  that read to the request, which ends with `settings-changed` when its own read
  changes what it reads, so a change between the two reads cannot leave a native
  route on an account the newer settings would not choose.
- **Revisions.** An offer no longer compares revision causes (`onlyChoicesSince`): a
  revision of any cause, or one whose cause the history no longer holds, keeps it
  unless it changed what the offer reads. Running logins and the other work fenced on
  a settings revision keep the rules of the
  [amendment of 2026-11-16](#amendment-2026-11-16-sso-mappings-sync-with-the-settings).

## Amendment 2026-11-18: a Log in now offer ends with its request

Chosen by an agent to fix [#1687](https://github.com/risu729/pateat/issues/1687), where
the owner expects **Log in now** to work on a page whose method offer expired; not
confirmed by the owner. The popup side is in
[ADR 0088](0088-popup-manual-login.md#amendment-2026-11-18-a-sign-in-method-choice-for-log-in-now).

- The method offer **Log in now** opens for the person's explicit choice is bound to
  that request (`signal`): the request ending withdraws it with `cancelled`, and the
  request ends at once with the reason of an offer that ends first, such as
  `settings-changed` under the
  [amendment of 2026-11-17](#amendment-2026-11-17-an-open-offer-outlasts-settings-it-does-not-read).
- `request` says whether the offer it made still waits for the person (`waiting`), so
  the request is marked `choosing` only then, never for an offer already decided or
  refused.
- Offers of automatic logins are unchanged: they still wait up to ten minutes, and the
  choice they wait for is the page's own.

## Amendment 2026-11-18: a broker page's provider entry

The owner wrote on 2026-11-18 at 03:01 UTC, about
[#1687](https://github.com/risu729/pateat/issues/1687): 「i opened a new tab but didn't
work. also, pateat should automatically login even if using sso, no?」. The owner's
decision: on a broker page such as `flow.idp.hashicorp.com/login`, Pateat signs in by
itself with the site's item, and where that item's route is SSO through its saved
mapping, it presses that SSO method's entry automatically. The
[URL-form rule above](#amendment-2026-11-12-local-method-discovery-and-mapping-validation)
left such an entry to the person's explicit choice. Every other guard stays: pause,
private windows, the repeated-login limit, master-password re-prompt, the settings scope
and the saved mapping, with no IdP guessed where none is saved.

**The cause in the fresh tab.** The page's provider button submits the page's own form
to its own origin, and the site then sends the tab to the IdP. The automatic choice of a
URL-form method pressed only an entry whose own observed destination is the mapped
origin (`automaticUrl` in `sso-choice.ts`), so it found none, recorded `entry-required`
and waited the offer's ten minutes for the popup's entry choice. A waiting offer writes
no log line until it ends, which matches the fresh tab's log: no `login.start`,
`recipe.generate` or `sso.*` line, and in another tab only `replaced` when
**Log in now** replaced the waiting offer.

The rest of this section is the agent's choice, not confirmed by the owner:

- **Which entry.** An entry whose own destination is the mapped origin is still pressed
  first, as before. Only when there is none, the automatic choice presses the one
  current entry that a flow pressed on this page before and that reached this very
  mapped origin, that an SSO layout of the site's recipe for this page names, and whose
  fresh inspection finds it going nowhere but the page's own origin, or nowhere explicit
  (`entryLearned`). None, or more than one, leaves the choice to the person as before,
  and an entry going to another origin is never pressed this way.
- **Where an entry led.** A layout names a page's entries but not where each one goes,
  and it is shared by every account and method on the page. So when a flow presses a
  URL-form method's entry and the tab then reaches its mapped origin (its URL there, or
  an IdP page admitted there), or the flow completes on the RP's own evidence after an
  IdP with a live session and grant sent the tab straight back without a page, the
  device records that this page's entry reached that origin
  (`pateat.login.sso-entries.v1` in local
  storage, at most 200 records, the newest per entry, with no account, username or
  credential). An entry is pressed by itself only for the IdP origin it last reached, so
  an entry learned for another provider, by this or another account, is never pressed
  for this method. The record stays on the device and is not synced. No settings path
  forgets a site's local login records, so this record has none either; it holds no
  secret and only ever narrows what is pressed.
- **Checked again.** The receipt of such a choice checks the entry against its record,
  the layout and its destinations again just before the flow uses it, as an
  exact-origin entry is checked again.
- **Only with a mapping.** A method without one still waits with `mapping-required`,
  and nothing lists or guesses an IdP account; a URL-form method whose discovery finds
  exactly one IdP item now uses that item as its mapping
  ([amendment below](#amendment-2026-11-18-sso-starts-automatically-on-the-login-page)).
- **Log in now too.** By the owner's later decision the same day, **Log in now** presses
  such an entry too, under its own hop guard, and shows the explicit chooser in every
  other case
  ([ADR 0088](0088-popup-manual-login.md#amendment-2026-11-18-a-sign-in-method-choice-for-log-in-now)).
- **The first visit.** Replaced by the
  [owner's decision below](#amendment-2026-11-18-sso-starts-automatically-on-the-login-page):
  where no entry names the mapped origin and none is learned, the entry whose label
  names the mapped IdP is pressed by itself.
- **Known limit.** An entry that once led to one provider and now leads to another is
  pressed once more for the old one: the flow stops on the other provider's origin
  (`sso-forbidden-origin`) without releasing anything, and the record keeps the old
  origin until a flow reaches the new one.

## Amendment 2026-11-18: an RP return on another origin of the same site

Chosen by an agent for [#1687](https://github.com/risu729/pateat/issues/1687), not
confirmed by the owner. A flow started on a broker page such as `flow.idp.hashicorp.com`
may come back on another origin of the site, such as its portal or its own callback,
rather than on the broker page's origin. Such a page ended the flow with
`sso-forbidden-origin`, so a sign-in that succeeded was not recorded.

- A page on another origin of the RP's registrable site (`siteOf`, Bitwarden's Domain
  match) with the RP's own scheme, and that is not the selected IdP's origin, is now
  read as the RP's return (`ssoReturnOrigin`), on the tab's navigation and on the page's
  admission alike. An https RP never returns to http, and an RP on `localhost` or an IP
  address has no other origin. The return completes only on the same evidence as the
  RP's own origin (`returned`), and the RP item must still match its URL, as items saved
  with a Domain rule do. Where it does not, as under a Host rule, the tab's navigation
  there ends the flow with `sso-forbidden-origin` and the page's admission with
  `sso-scope-changed`.
- **Log in now** on such a page ends a flow that only waits there, as on the RP's own
  origin.
- The attempt keeps its RP document, since an attempt belongs to its account's origin.
- Every other origin stays forbidden.
- **Known limit.** A host that serves many tenants under one registrable domain but is
  missing from the public suffix list reads its tenants as one site. Only the RP item's
  URI match fences them apart there, so an item saved with a Domain rule on such a host
  accepts a return on another tenant's origin.

## Amendment 2026-11-18: SSO starts automatically on the login page

The owner wrote on 2026-11-18 at 14:14 UTC, about
[#1687](https://github.com/risu729/pateat/issues/1687) on
`flow.idp.hashicorp.com/login`:
「そもそもSSOってログイン画面で自動で始まるべきでは？なんで？」. The owner's decision:
SSO starts automatically on the login page. A broker page's first visit no longer needs
the person's entry choice
([amendment above](#amendment-2026-11-18-a-broker-pages-provider-entry)).

The label rule below is the agent's choice, not confirmed by the owner:

- **Which entry.** For a URL-form method with a mapping, on a page where no
  entry's own destination is the mapped origin and the page learned none for it, the
  automatic sign-in and **Log in now**'s automatic mode press the one current entry
  whose visible label names the mapped IdP (`labeled` in
  `apps/extension/src/login/sso-choice.ts`,
  `apps/extension/src/login/sso-entry-label.ts`). The order is: an entry whose own
  destination is the mapped origin, then the entry learned for it, then the label.
- **What names the IdP.** Only local data: the mapped IdP item's name, and the
  registrable labels without their public suffix (tldts, as for passkeys) of the mapped
  origin and of the item's own URIs, as `github` for `https://github.com`, `google` for
  `accounts.google.com`, `microsoftonline` for `login.microsoftonline.com` and `ibm` for
  `login.ibm.com`. Labels and names are compared after NFKC and in lower case, word by
  word: a name's words must appear in order as whole words of the label. A name names
  something only through a word of three letters or more that does not name a way to
  sign in (`SSO`, `Sign in`, `Continue`, `Login`, `Account` and the like), so `SSO` or a
  one- or two-letter name such as `X` names nothing. The page's own site's registrable
  label is left out, from the labels and from the item name's words alike, since the
  page names its own site everywhere.
- **A prefix of the registrable label.** A registrable label of three letters or more
  may also begin a longer word of the label, as `ibm` begins `IBMid`. Never the other
  way: an independent review's probe found `Sign in with Amazon` named by
  `amazoncognito` and `Microsoft account` by `microsoftonline`, so a label word that
  merely begins a registrable label names nothing, and `Sign in with Microsoft` is
  pressed for `login.microsoftonline.com` only when the IdP item is called `Microsoft`.
- **Never a device sign-in.** An entry whose label names a sign-in on the device itself
  (`passkey`, `Hello`, `security key`, `Face`, `Touch`, `fingerprint` and the like) is
  never pressed by its label, as `Windows Hello` would be for `login.windows.net`.
- **Exactly one.** The label must name exactly one of the page's observed buttons and
  links, by any rule, counting those that are never pressed, as a link by `href` or an
  entry whose inspection failed (`otherLabels`). A field's or checkbox's label, as
  `Email or IBMid` or `Remember my IBMid`, is not an entry and is not counted. None, or
  several, leave the chooser as before, with `entry-required`.
- **Guards.** The named entry must, on a fresh inspection, go nowhere but the page's own
  origin, or nowhere explicit, as a learned entry (`entryLearned`). An entry a flow
  learned to reach another IdP is never pressed for this one, so a label never overrides
  what the page learned. The receipt checks the entry's presence, inspection and learned
  record again just before the flow uses it, but not the label match: the labels are
  those of the observation the offer was made from, and a new observation of the page
  withdraws the offer. The pause, private windows, the repeated-login limit, the
  master-password
  re-prompt, `auto` sign-in on both origins and **Log in now**'s `hopAllowed` all stay.
- **A URL-form method without a saved mapping.** The owner's settings hold no SSO
  mapping, so the automatic start above stopped with `mapping-required` before any entry
  was looked at. Following the owner's question above, such a method now uses
  discovery's IdP item as its mapping for the sign-in when discovery finds exactly one
  (`onlyCandidate` in `sso-choice.ts`). Discovery already admits only an item, across
  every eligible connection, whose own concrete URIs hold the method's origin (a
  Regex-only URI refuses discovery with `uri-unavailable`) and whose username equals the
  site item's (`sso-vault.ts`, `crypto/sso.ts`). The item must then pass the same
  validation a saved mapping passes, and the hop guard. The single-candidate rule is the
  agent's choice, not confirmed by the owner: the origin and the username together name
  the account, so nothing is guessed. Zero items, several, a discovery refusal, an
  unreadable field or a refused validation keep `mapping-required` or that refusal, and
  the popup's explicit mapping chooser lists the items with none chosen. A bracket-form
  method's label never selects an account, so it still needs a saved mapping.
- **Resolved every time, never saved.** The agent chose to resolve such a mapping at
  each offer and to write nothing to the settings: no settings revision or sync follows
  a sign-in, and a vault change that adds a second such item, or removes the one, brings
  the person's choice back at the next offer. Saving stays the person's explicit act in
  the chooser.
- **No removal of what is not saved.** Where such an offer waits for the person, the
  popup marks the method as `inferred` and shows no **Remove provider mapping**, which
  would change nothing; a removal sent anyway is refused with `mapping-not-saved`. The
  agent chose the smallest honest way instead: the popup says the account is used
  because it is the only one found and nothing is saved, and the explicit chooser stays,
  so the person can save the mapping, or pick the password or another method for this
  sign-in. To stop SSO starting by itself on the site, the popup names the existing
  setting: the site's sign-in pages set to **Fill only**, under which no automatic
  hop runs.
- **A wrong press.** A broker entry that leads to another provider showing a page
  reaches that provider's origin, which is not the mapped one: the flow stops there with
  `sso-forbidden-origin` before any credential is released, as for a learned entry that
  changed. A provider where the person has a live session and grant, as GitHub's, may
  instead answer with a server redirect alone and commit no page, and the site then
  signs the person in with that provider's identity: the extension cannot stop that, and
  it has no `webRequest` or `webNavigation` permission to see such a redirect (none is
  added). So an entry pressed for its label completes, and is learned, only once the tab
  was seen at the mapped origin: its committed URL there (`tabs.onUpdated`) or an IdP
  page admitted there. Before that, an RP page whose own evidence would complete the
  flow (a check of `returned` that records nothing) ends it with `sso-idp-unseen`. Any
  other RP page, as a "Redirecting" interstitial, a SAML auto-post page or the broker
  drawn again on its own origin before the site sends the tab on, waits with
  `sso-in-progress` as after any press, so the flow goes on at the IdP. On
  `sso-idp-unseen` the flow records no success, no default or account choice is saved,
  no repeated login is counted, nothing is learned and the page stays as the site left
  it. Since nothing was learned, the next visit applies the label rule again.
  **Known limit:** with the mapped IdP itself answering by a redirect alone, a press for
  the label never completes, though the site signs the person in; an entry the person
  picks in the chooser, or one learned, still completes on the RP's own evidence.
- **Recorded as before.** Once the tab reaches the mapped IdP, the press is learned
  (`pateat.login.sso-entries.v1`), and later visits press that entry by what was
  learned. The first press still has the site's SSO layout generated for the entry's
  label, as an explicit choice of the entry has.
- **A restarted worker.** The worker keeps its method offers and the documents it
  admitted in memory only, and a restarted worker asks only the tabs of sites with a
  saved default to announce again, which a first visit has none of. The popup now also
  asks the tab's top page to announce again where the site is not paused, with
  `sign-in` `fill` as with `auto`, and the worker knows no document of the tab, as it
  does for a verification page
  ([ADR 0035](0035-page-kinds-per-site.md#amendment-2026-11-17-fill-after-a-worker-restart)),
  so a sign-in, account choice or method offer the restart lost is offered again.
- **A cancel outlasts the restart.** The agent chose to keep the person's cancel rather
  than to make the popup's re-announcement offer only. Where the person cancels an
  automatic method offer under **Sign-in method**, the document is kept in session
  storage (`pateat.login-sso-cancels.v1`, by tab and document, the 256 newest, dropped
  when the tab closes), so no automatic admission of that document offers SSO again, by
  the restarted worker's or the popup's re-announcement or a later announcement alike;
  it stops with `sso-offer-cancelled`, before the item's methods or the page are read,
  so the tab's passkey refusal stays for the next request. Only the person's own
  **Log in now** offers it again there. A new document of the tab, such as a reload, is
  offered as before.
- **A re-announcement never refills.** A page the popup asks again after a restart is
  admitted as any announcement: a document a fill already ran in is fenced by the
  fill's own record, kept in local storage, so nothing is filled twice, and a sign-in
  fill keeps any field the person typed in before it, as the content script did before
  this amendment.
- **Log in now's start.** Its start waits only for an announcement the page made for the
  request, never for an admission that began before it, as an automatic one that waits
  for its method offer, so the popup answers and shows the request's state at once. A
  page that answers the request's reconnect without announcing for it, which the content
  script does not do, leaves nothing to drive the request, so it ends at once with
  `not-started` rather than showing "Preparing" until its five minutes end.
- **Log in now during an automatic press.** Pressed while the popup's re-announcement
  starts the automatic press, the request replaces that flow before its press, or finds
  the login running: one entry press, never two. **Known limit:** the replaced flow's
  SSO layout generation, a paid call, may already be under way, so the service may be
  asked for the layout twice.
- **Diagnosis of the reported tabs.** The fresh tabs logged only `login.refused`:
  `replaced` where a newer admission of the tab opened its own method offer, as
  **Log in now** does; `cancelled` where the person cancelled the waiting offer under
  **Sign-in method**; and `manual-request-ended` where an admission that waited for
  **Log in now**'s offer found its document announced again or its request ended. No
  timer of about 40 seconds exists on that path. A waiting offer writes no line until it
  ends, so none of the three shows that nothing would be pressed. With this rule the HCP
  page's `Sign in with IBMid` is pressed for its IBMid mapping, saved or the one item
  discovery finds, and `Sign in with SSO` and `Continue` never are.
