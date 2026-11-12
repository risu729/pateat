# ADR 0026: Signing in to a site through an identity provider

Status: accepted by the owner on 2026-10-11 (12:20 UTC) as policy; the scoped
coordinator is implemented on a branch, with synthetic verification recorded in
[the implementation PR](https://github.com/risu729/pateat/pull/1532), following account
choice and the local discovery / declarative generation foundations
([2026-11-12 amendment](#amendment-2026-11-12-declarative-sso-entry-generation)). The
owner initially set it as low priority; the current implementation is described in the
[coordinator note](#implementation-2026-11-12-scoped-coordinator).
Builds on [ADR 0022](0022-login-attempts-per-tab-and-origin.md). Amended on 2026-10-11
by [ADR 0027](0027-per-account-login-routes.md): SSO is one of a recipe's start-page
routes, chosen after a passkey route and before a password route. Amended on 2026-10-12
by [ADR 0033](0033-no-site-specific-features.md) (owner, 13:46 UTC): no fixed list of
identity providers or of their pages; the IdP's origin comes from the item and its pages
are handled as any site's. Amended on 2026-11-07 by
[ADR 0085](0085-one-item-for-native-and-sso-login.md) (owner, 12:51 UTC;
[amendment](#amendment-2026-11-07-one-item-for-password-and-sso)). Researched from
public documentation only; no real site or account has been used.

Date: 2026-10-11

## Context

Many sites offer "Continue with Google" or "Sign in with Microsoft" instead of, or next
to, their own password form. The owner wants Pateat, on such a site's login page, to
press the entry the owner uses for that site and to carry on through the identity
provider (IdP), without granting anything new.

Today Pateat cannot do this. A recipe needs at least one slot and one step
(`loginRecipeSchema` in `packages/contracts/src/login.ts`), and neither `siteDefaults`
nor a vault item can say "this site signs in with Google". Links are clicked only as a
recipe's `accountSwitch`. An IdP page that is the first login of its tab, such as a
popup, already works like any other site with its own recipe and vault item.

Public documentation of Google, Microsoft, GitHub, Okta, Auth0, Keycloak, LINE, Apple
and Yahoo! JAPAN shows:

- With an existing grant and session most IdPs return to the site without any page.
  Pages that do appear are account choosers (Google "Choose an account", Microsoft "Pick
  an account"), "Stay signed in?" (Microsoft, Okta), LINE's "次のアカウントでログイン"
  and Apple's Face ID or password check, which is operating system UI.
- A site can force the permission page on every sign-in with `prompt=consent`; it then
  looks the same as a first grant.
- Some sites create an account on the first return without any page, such as a Slack
  workspace whose admin set up Google Workspace sign-in.
- A content script's click carries no user activation, so SSO buttons that open a popup,
  Google's button inside its iframe, One Tap and FedCM (Chrome's own dialog) are out of
  reach (expected; not checked in Chrome).

## Decision

The owner chose, on 2026-10-11:

- **The per-site choice lives in Bitwarden.** The site gets its own item with an empty
  password, the IdP account as its username and a text or hidden custom field named
  `SSO` holding the IdP's origin:

  | Item          | URI                           | Username            | Password | Custom field                          |
  | ------------- | ----------------------------- | ------------------- | -------- | ------------------------------------- |
  | Notion        | `https://www.notion.so`       | `taro@gmail.com`    | empty    | `SSO` = `https://accounts.google.com` |
  | Google (taro) | `https://accounts.google.com` | `taro@gmail.com`    | set      | none                                  |
  | Google (work) | `https://accounts.google.com` | `taro@corp.example` | set      | none                                  |

  The IdP item used is the one matching the IdP's origin whose username equals the site
  item's username, ignoring surrounding spaces and letter case. None or several stop the
  login. The IdP origin's `siteDefaults` entry is neither used nor saved by such a
  login, so direct logins to the IdP keep their own default. Several site accounts are
  several site items, chosen as today
  ([ADR 0021](0021-account-choice-outside-settings.md)).
- **Field rules.** Exactly one `SSO` field; its value is read as a URL and reduced to
  its origin; an unreadable value or a duplicate field stops. The value is never filled
  into a page or sent to the service or a model. An excluded `SSO` field means no SSO.
  An item with `SSO` is never a candidate on the IdP's pages and never used by a
  password recipe or by recipe generation, even when it has a password. (Amended on
  2026-11-07: an item with a password keeps its password login.)
- **Any IdP the item names** (ADR 0033 amendment). Pateat keeps no list of IdP origins;
  the IdP's origin is the item's `SSO` value. Before the amendment, the first IdPs were
  Google and Microsoft, with their origins fixed in Pateat.
- **On the site.** The site's recipe lists its SSO buttons or links per IdP. Pateat
  presses one only when the chosen item has `SSO` for that IdP, exactly one element
  matches, on the same path, within 10 seconds, and it navigates the same tab. A link is
  pressed only when its `href` origin is the site's or the IdP's; a button that submits
  a form only when the form's target origin is the site's or the IdP's. Entries that
  open a new window are never pressed. SSO that first asks for a work email or company
  domain on the site is out of scope.
- **On the IdP.** After the press, Pateat remembers the tab, the site and IdP origins
  and the username while the tab's top-level page stays on the IdP's origin. There it
  handles the IdP's pages as any site's, through the recipe generated for the IdP's
  origin and the AI's judgment, with no fixed per-IdP page list (ADR 0033 amendment):
  - the login form, filled from the IdP item above;
  - an account list ([ADR 0028](0028-account-chooser-login-pages.md)), where only the
    entry whose email equals the username exactly (no partial match, stricter than ADR
    0028's masked addresses) is chosen; a list
    that says the account's details will be shared with the site stops until it has
    been checked in Chrome;
  - a page that only asks whether to stay signed in or to continue as that account,
    such as Microsoft's "Stay signed in?" or LINE's "次のアカウントでログイン", which is
    pressed through.
- **Everything else stops**: any permission page, including one forced by
  `prompt=consent`; Apple's "Share My Email / Hide My Email"; account creation pages on
  either side; chains where the IdP itself signs in through another IdP.
- **Success** is the site's own login check after the return.

## Alternatives

- Keep the per-site IdP and account in Pateat's settings (the service web UI). Rejected:
  the owner wants it next to the other credentials in Bitwarden.
- Short IdP names such as `google` in the field. Rejected: they cannot name a company's
  own IdP such as `https://example.okta.com` later.
- Continue through permission pages that were granted before. Rejected: a forced
  `prompt=consent` page cannot be told apart from a first grant.

## Consequences

- Until SSO logins are implemented, an item in this shape is otherwise used like any
  other item: a pick or the only match runs a password route, which stops with
  `no-route` when the item holds no password and no passkey. Before 2026-11-07 a site
  with both its own item and an SSO item asked which account to use instead of logging
  in.
- A site that creates accounts without asking still does so if the item's username is
  not an account the site already knows.
- Left to implementation: the recipe shape for SSO-only sites (no slots), generating SSO
  entries (ADR 0016's input condition replaced by an item with `SSO`), how a generated
  recipe or the judge tells a stay-signed-in page apart, how long the remembered press
  stays valid, and `origin-busy` on IdP pages.
- IdP password pages that ask for the email first need recipe continuation after an
  `advance` step ([ADR 0018](0018-recipe-generation-route.md)).
- An IdP whose sign-in moves across several origins, as personal Microsoft accounts move
  from `login.microsoftonline.com` to `login.live.com`, is followed only on the item's
  origin since the ADR 0033 amendment; following such a move is left to implementation.
- Real-site checks need real accounts and therefore separate owner approval.

## Amendment 2026-11-07: one item for password and SSO

Accepted by the owner on 2026-11-07 (12:51 UTC) with
[ADR 0085](0085-one-item-for-native-and-sso-login.md); not implemented. The accepted
text above is kept; these parts change:

- **Item format.** The site item above, with `SSO` = `https://accounts.google.com`,
  stays the format of an SSO-only item with one IdP. A site account that also has its
  own password, or several IdPs, is one item with `SSO` = `[GitHub] github-user`,
  `SSO 2` = `[Google] person@example.com`, … and keeps its own Username and Password.
- **Which IdP item is used.** For the bracket form, the IdP item comes from the field's
  label and username, resolved locally to one saved IdP item and a permitted origin from
  its URIs, not from the site item's Username.
- **Field rules.** "Exactly one `SSO` field" becomes one field per method. The value is
  still never filled into a page; only its label may be sent to the model, to find the
  site's button for that IdP. "Never a candidate on the IdP's pages and never used by a
  password recipe or by recipe generation" becomes ADR 0085's rules per route: an item
  with bracket-valued fields is used for its own password sign-in and recipe generation,
  with its `SSO` fields left out, and, as an IdP, for direct sign-in, while a chain
  where the IdP signs in through another IdP still stops.

## Implementation 2026-11-07: SSO-only items in the account choice

Implemented on 2026-11-07 for [#1374](https://github.com/risu729/pateat/issues/1374),
where Devpost's own item and an SSO-only item both matched and the tab asked which
account to use instead of logging in. An item signs in only through an IdP when it has a
usable Text or Hidden field named `SSO` or `SSO <number>` (2 or more), in either form of
ADR 0085, and no usable login password (`signsInOnlyThroughProvider` in
`apps/extension/src/vault/site-candidates.ts`). When several items match a page with no
saved default, such items are not counted (`ownLogins` in
`apps/extension/src/login/runtime/choice-save.ts`), so the site's own item logs in. When
two or more of the site's own items match, the tab asks among those only; when every
match is such an item, nothing changes. Picks, saved defaults, the lists the tab asks
later or a paused site offers, hidden usernames and the chooser's comparisons still see
every match. Until the `sso` route exists, a pick or the only match of such an item runs
the password route, which stops with `no-route` when the item holds no password and no
passkey.

## Amendment 2026-11-12: declarative SSO entry generation

Implementation detail chosen by an agent within ADR 0085. A recipe document now accepts
an `sso` sibling holding its start path and up to three layouts of `{label, target}`
entries. A document may hold SSO alone or beside its native form and chooser layouts.
These entries are not `LoginStep` clicks, native route projections or credential grants.
The existing executor cannot act on them. Native route selection is unchanged.

A dedicated `kind: "sso"` generation request contains a value-free page observation and
labels for the chosen RP account/method, never a vault-wide label inventory, IdP
username, IdP origin, item reference, comparison proof or local mapping. The role
returns only requested labels and observation-local candidate references. Local checks
require one observed button or link per label, reject duplicate targets, and retain no
invented label or candidate in the request log. Generic registration/permission evidence
and the role's page classification refuse consent, sharing, account creation and unclear
pages, even when a matching provider button shows. The later coordinator must check
these boundaries again on the live document.

The service stores entries with the existing conditional revision write, spend limits,
request log and generation retry/repair windows. This is a generation call, not a
post-login judgement; it does not consume a judgement quota. SSO and native writes keep
each other's siblings, with one bounded conditional rebase when only the other family
changed. A native-only update does not discard a pending SSO repair. Layout-key
collisions are renamed together with the generated provenance and the successful call's
inference-log layout; ordinary native and repair log scope remains unchanged. The
winning document must still match the requested recipe ID, origin and start path. SSO
targets cannot overlap native form, chooser or handler controls. SSO layouts have their
own provenance units and participate in layout keys, removal and start-path validation.
Individual SSO layouts age under the same idle retention as native forms and account
lists: an idle family is removed while another family remains, and the whole recipe
retains its existing last-layout revocation rule. They never acquire fill slots or a
native submission.

The method chooser, local mapping UI, same-tab RP/IdP coordinator, IdP intermediate-page
handling and final RP authentication remain the next required implementation. This
amendment does not claim end-to-end, packaged-browser or real-account compatibility.

## Implementation 2026-11-12: same-tab operation primitives

The coordinator now has separate content inspection, preparation and single-use commit
commands, a memory-only parent-flow model and a secret-free session intent journal. An
intent is durable before a commit can authorize a click; restored intents only hold an
interrupted tab and never recreate execution authority. Inspection refuses new browsing
contexts, unsafe account-creation or permission pages, and non-HTTP destinations. IdP
account comparison requires a complete local identifier without masked or folded
aliases. Continue and stay-signed-in are finite local classifications with exact account
evidence, never authorization inferred from a Continue label alone.

The scope checks both selected vault snapshots, current source and mapping, current
top document and policy, and a synchronous recipe-cache fence after awaited work.
Each origin retains its own item's full-URI destination rule; only the prepared RP
entry may cross to the one selected IdP origin. Concurrent requests consume an intent
once. Child-attempt identity is immutable and survives parent cancellation so late
callbacks can remain excluded from IdP default and authentication-proof writes.

These are lower-level primitives and recipe/generation adapters. Admission, parent/child
lifecycle integration and confirmed RP-return completion are still being implemented;
this checkpoint enables no automatic SSO effect. Synthetic checks are separate evidence
from packaged execution and real-account compatibility, neither of which is claimed.

## Implementation 2026-11-12: scoped coordinator

The extension now connects the local method chooser to a same-tab coordinator. Its
parent stores the original RP account, selected method and exact IdP account/origin in
memory; the native execution map contains only the IdP child. The child retains its
ordinary account/document origin invariant, full URI rules and credential checks. An
immutable child identity suppresses IdP defaults, account picks, authentication proofs,
login history success and automatic relogin counts even after the parent is cancelled.

The coordinator resolves the mapping before pressing an entry. Account selection
includes SSO-only items. Automatic method order is passkey, unsuffixed SSO, then
password; numbered methods require an explicit choice. A current-page manual request
offers an explicit method choice. It may use SSO only under existing automatic
permission on both origins and without a pause; its one-page grant never expands to the
IdP. Frames, extra origins, new contexts, nested SSO, consent, sharing and account
creation stop the flow.

IdP account choices require the full exact identifier. Continue and stay-signed-in need
finite local evidence tied to that identifier. Only the original RP's positive identity
or freshly observed signed-in marker completes the parent. The URL form's username is
an IdP identifier and is never treated as the RP's own identity. Its return therefore
needs an RP marker or a marker learned by the dedicated RP-return judge. The judge uses
the existing provider abstraction and atomic daily judgement quota; it receives only a
redacted RP observation and recipe/layout identity. Its marker is stored separately from
SSO entry provenance and rechecked locally. A cached verdict alone is insufficient.

Each effect rechecks policy, pauses/private-window settings, source and selected item,
vault snapshots, session and exact document, recipe epochs and observed destinations.
Pointer events and the final click have separate single-use authorizations; policy,
vault and recipe epochs are checked again after the pointer's awaited page tasks.
Unknown acknowledgements and worker restart never replay an entry. Persisted intents
become interrupted holds. Cancellation withdraws authority, while the child association
remains available to suppress late callbacks. Its opaque parent/attempt exclusion tag is
durable without restoring authority. An allowed RP return detaches that child and
releases its IdP origin hold while retaining submission diagnostics; it supplies no
ordinary IdP recent success, default or authentication proof. Native fill-only and
confirmation flows start no SSO effect.

Packaged synthetic checks exercise popup mapping, the actual RP entry, encrypted IdP
passwords and passkeys, finite intermediate pages, service generation/cache and original
RP completion. They also check interruption and refusal without changing the IdP default
or creating an IdP authentication proof. Exact revisions, results and independent review
are recorded in [the implementation PR](https://github.com/risu729/pateat/pull/1532).
This evidence does not establish real-account or installed-user-browser compatibility.

## Review hardening 2026-11-12: finite IdP actions and local labels

A prepared finite IdP action carries the selected native username and action kind only
in short-lived content-script memory. Preparation and every pointer/final-click guard
repeat the exact account reading and target comparison. This evidence is never stored
in a journal, diagnostic, mapping, service request or recipe. An IdP operation without
that expectation is refused, and an RP entry cannot carry it.

An observed URL-form entry label passes through the same local username redaction as the
RP observation before cache lookup or generation. Only the selected target's safe
redacted label is used, while the exact locally selected target remains bound through
cached and repaired layout selection. Ambiguous or unredactable labels stop the flow.
Bracket-form provider labels remain the explicitly approved public-label exception. A
repaired layout executes only after current local inspection, newest first; an old
retained layout or an uninspectable new target cannot win by array position.

A native child detaches its execution authority before a finite IdP action. On the same
document a narrow attempt cancellation withdraws pending native mutations without
cancelling SSO inspection or clicks; a different document can still be fully cancelled.
Scope checks both the original RP pause and selected IdP pause in the original cookie
partition. A pause request withdraws affected SSO flows before awaiting persistence or
popup/badge work, so a later native or SSO grant cannot slip through that interval.
