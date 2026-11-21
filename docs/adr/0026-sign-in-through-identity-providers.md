# ADR 0026: Signing in to a site through an identity provider

Status: accepted by the owner on 2026-10-11 (12:20 UTC) as policy; the scoped
coordinator is implemented and checked with synthetic packaged fixtures, following
account choice and the local discovery / declarative generation foundations
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
[amendment](#amendment-2026-11-07-one-item-for-password-and-sso)). Amended on 2026-11-18
by an agent, its waiting rule approved by the owner on 2026-11-19 (01:37 UTC): the IdP's
own login is logged and goes on past its submit
([amendment](#amendment-2026-11-18-the-idps-own-login-is-logged-and-goes-on-past-its-submit)).
Amended on 2026-11-20 by an agent: the RP return waits for the RP's own evidence and the
IdP's login ends with its true state
([amendment](#amendment-2026-11-20-the-rp-return-waits-for-the-rps-evidence)), and a
return to another origin of the RP's site completes on that origin's evidence
([amendment](#amendment-2026-11-20-a-return-to-another-origin-of-the-rps-site)).
Researched from
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
passkey. Since the `sso` route exists, such items are counted again only where it can
log in by itself (`ssoRunsOn`): with SSO on, on a top-level sign-in page set to **Auto**
that is not a confirmation page, not only filled and not paused. Elsewhere they still
are not counted, so the site's own item logs in rather than the tab asking.

## Amendment 2026-11-12: declarative SSO entry generation

Implementation detail chosen by an agent within ADR 0085. A recipe document now accepts
an `sso` sibling holding its start path and up to three layouts of `{label, target}`
entries. A document may hold SSO alone or beside its native form and chooser layouts.
These entries are not `LoginStep` clicks, native route projections or credential grants.
The existing executor cannot act on them. Native route selection is unchanged.

A dedicated `kind: "sso"` generation request contains a value-free page observation and
labels for the chosen RP account/method, never a vault-wide label inventory, IdP
username, IdP origin, item reference, comparison proof or local mapping. A label must
be one local discovery can read
([ADR 0085](0085-one-item-for-native-and-sso-login.md#amendment-2026-11-12-local-method-discovery-and-mapping-validation)):
trimmed, at most 128 UTF-16 units, with no bracket, control, format, line or paragraph
separator character. Labels are compared ignoring letter case, so a request's labels
that differ only by case name one entry and the first spelling is kept. A request names
at most eight labels. The role names each one by its index in the request and each
entry by an observation-local candidate ID, so its answer is ASCII and stays within the
role's 1,024 output tokens. Local checks require one observed button or link per label,
reject an answer that names one button for two labels, and retain no invented label or
candidate in the request log.
Targets are compared canonically, so member order never tells two apart. The role's
page classification refuses consent, sharing, account creation and unclear pages, even
when a matching provider button shows. Locally, only a title or main heading that
clearly grants access, shares account data or only creates an account refuses the page,
and the chosen candidate's own label must not sign up, register, create an account,
authorize, grant, allow or agree. A page that offers signing in beside signing up, a
cookie banner's heading and a personal detail field beside the provider buttons are left
to the role. The later coordinator must check these boundaries again on the live
document. Claude answers the request alone: Clef answers only sign-in forms with slots
([ADR 0083](0083-clef-first-for-sign-in-forms.md)), and an SSO request has none. As with
the other generation requests, a paired device with its own key makes the call through
the device-model protocol and a device without a pairing makes it itself
([ADR 0040](0040-running-without-the-service.md)).

The service stores entries with the existing conditional revision write, spend limits,
request log and generation retry/repair windows. This is a generation call, not a
post-login judgement and does not count toward a recipe's 20 judgements a day. A request
whose labels each have an entry in some layout is answered from the stored recipe
without a call. New labels join the newest SSO layout, an entry of the same label being
replaced, so asking for one label after another grows one layout instead of a layout
each. A label answered on a button another stored label already names is kept beside it,
as two of an item's methods may sign in through one provider's button: neither replaces
the other's entry, so asking for them in turn changes the stored entries once and the
retry window below then holds. A layout that new labels join takes the call's time as
its creation time, so idle retention counts from its newest entries. Its provenance unit
is the whole layout and names the call that last changed its entries; each earlier
call's request log row keeps the layout's key. A repair, whose entries no longer worked,
adds the newest layout's entries with its new ones as another layout, the least recently
used going past three. The 10-minute retry window of a request is keyed by its branch,
`sso:` and a digest of the recipe's stored SSO entries, at base revision 0, whatever
labels it names. Varying the labels, as with labels the page does not show, buys no
further call: one call per window until a write of new SSO entries opens it again, and a
native write, which leaves them alone, does not. A device that learns its labels one at
a time gets a call for each label the page shows, and none once they are stored; after
an abstained answer, its next label waits for the window. The request log records the
same branch, with the page `sso`, which the dashboard does not count as a recipe
generated. A device repairs a recipe's SSO entries and its native routes once a UTC day
each: `recipe_repairs` keys a repair by its family, `native` or `sso` (migration 0038),
and a device without the service keeps the same keys.

SSO and native writes keep each other's siblings, with one bounded conditional rebase
when only the other family changed. A native-only update does not discard a pending SSO
repair. SSO entries do not run yet, so they give way to a native route: a native write
drops each SSO entry on an element the route uses, a layout left empty and the family
with its last layout, and the SSO role is never offered such an element. A native
answer of a confirm or unclear page beside SSO entries alone is written beside them, as
on a page with no recipe. Layout-key collisions are renamed together with the generated
provenance and the successful call's inference-log layout; ordinary native and repair
log scope remains unchanged. The winning document must still match the requested recipe
ID, origin and start path. SSO targets cannot overlap native form, chooser or handler
controls. SSO layouts have their own provenance units and participate in layout keys,
removal and start-path validation; the management page lists each one's entries, label
and target, with the same control that removes a native layout. Individual SSO layouts
age under the same idle retention as native forms and account lists: an idle family is
removed while another family remains, and the whole recipe retains its existing
last-layout revocation rule. They never acquire fill slots or a native submission.

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
offers an explicit method choice (since 2026-11-18, except where the automatic order
decides a mapped SSO entry the request's scope reaches:
[ADR 0088](0088-popup-manual-login.md#amendment-2026-11-18-a-sign-in-method-choice-for-log-in-now)).
It may use SSO only under existing automatic
permission on both origins and without a pause; its one-page grant never expands to the
IdP. Frames, extra origins, new contexts, nested SSO, consent, sharing and account
creation stop the flow.

IdP account choices require the full exact identifier. Continue and stay-signed-in need
finite local evidence tied to that identifier. Only the original RP's positive identity
or freshly observed signed-in marker completes the parent. The URL form's username is an
IdP identifier and is never treated as the RP's own identity. Its return therefore needs
an RP marker or a marker learned by the dedicated RP-return judge. The judge uses the
existing provider abstraction and the per-recipe daily judgement limit; it receives only
a redacted RP observation and recipe/layout identity. Its marker is stored separately
from SSO entry provenance and rechecked locally. A cached verdict alone is insufficient.

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
or creating an IdP authentication proof. This evidence does not establish real-account
or installed-user-browser compatibility.

## Review hardening 2026-11-12: finite IdP actions and local labels

A prepared finite IdP action carries the selected native username and action kind only
in short-lived content-script memory. Preparation and every pointer/final-click guard
repeat the exact account reading and target comparison. This evidence is never stored
in a journal, diagnostic, mapping, service request or recipe. An IdP operation without
that expectation is refused, and an RP entry cannot carry it.

An observed URL-form entry label passes through the same local username redaction as the
RP observation before cache lookup or generation. Only the selected target's safe
redacted label is used, while the exact locally selected target remains bound through
cached and repaired layout selection. Ambiguous or unredactable labels stop the flow. A
redacted account placeholder reads in parentheses, as `Continue as (account)`, since a
provider label never holds brackets. Bracket-form provider labels remain the explicitly
approved public-label exception. A repaired layout executes only after current local
inspection, newest first; an old retained layout or an uninspectable new target cannot
win by array position.

A native child detaches its execution authority before a finite IdP action. On the same
document a narrow attempt cancellation withdraws pending native mutations without
cancelling SSO inspection or clicks; a different document can still be fully cancelled.
Scope checks both the original RP pause and selected IdP pause in the original cookie
partition. A pause request withdraws affected SSO flows before awaiting persistence or
popup/badge work, so a later native or SSO grant cannot slip through that interval.

## Review hardening 2026-11-12: pause intents during method choice

A pending method choice has no parent flow to cancel yet. Before awaiting a pause
write, the runtime therefore installs a bounded local SSO intent guard for the site's
cookie partition. Both original RP and selected IdP guards participate in the final
synchronous authority fence. A successful write hands enforcement to the persisted
pause; a failed write keeps SSO blocked until a successful explicit resume or retry.
The guard is memory-only and ordinary native pause-store behavior is unchanged.
Concurrent writes retain their own pending tokens, so one completed write cannot
release another pending intent. These guards carry no credentials or mappings.

## Review hardening 2026-11-12: in-place IdP path changes

An IdP document already held by the parent keeps reporting its existing path-change
signal after its native child finishes. For the exact active top document, token and
cookie partition, that signal requests normal re-admission with the browser's current
URL. A one-use refresh permits replacing the same document's old native URL while its
child is still awaiting a result. Concurrent signals coalesce; they grant no click or
credential authority. The refreshed page must pass the ordinary SSO scope and finite
IdP identity checks before the old native execution is detached. Other documents and
ordinary native logins retain their existing admission rules. DOM-only transitions use
the existing page-change signals; this adds no polling or separate DOM observer.

## Review hardening 2026-11-15: refused passkeys and vault notices

A passkey the method chooser picked and the site then refused does not go back to the
password route of [ADR 0034](0034-answer-page-passkey-requests.md) rule 6 when the item
has `SSO` methods. That native login ends without filling or clicking anything, its
record and origin hold are dropped, and the same top document is asked to announce
itself again. The tab's next automatic choice for that account, once and whichever
document, leaves the passkey out, so it lands on the preferred SSO method or stops with
that method's reason; an item without a preferred SSO method still gets the password. A
passkey the person picked in the popup for a manual sign-in, and an IdP's own native
login during a hop, fall back as before: the manual request's grant has already been
used, and the person chose that route over the SSO method. The
[ADR 0085 review of 2026-11-16](0085-one-item-for-native-and-sso-login.md#review-hardening-2026-11-16-a-refused-passkey-the-person-picked)
stops the person's own pick on an item with SSO methods instead.

A vault notice cancels an active parent flow only when the settings revision or the
vault catalog differs from the one the flow started with. A status read that changes
nothing keeps the flow, as it keeps a pending method offer.

## Review hardening 2026-11-16: finite IdP steps named by the page

An IdP page is a finite step only when its own title or heading names one: an account
list (such as "Choose an account" or アカウントの選択), an account confirmation (such as
"Confirm your account" or "Continue as" the selected account) or a stay-signed-in
question. A button label such as Continue or Next never makes a page one, so a "Verify
it's you" challenge or any other page waits for nothing and stops. Wording that shares
the account with an app or grants it access stops the flow on such a page in any tense
or order: share, shares, shared or sharing, wants to access, access to your, allow an
app to, to continue to an app, and 共有, 許可, アクセス or an app に移動 in Japanese. An
account list that names its destination app is therefore a sharing list. The IdP's own
sign-in form is still read as its native login first.

A word list cannot name every way of saying what an app receives, so an account
confirmation is also checked by what else it shows. Besides the heading that names it,
the account's identifier, the control pressed, one language picker and a few controls
that stand alone and offer another account, leaving, or the IdP's help, privacy and
terms, it may show only a few letters, such as "Not you?" or a short footer line. Those
are set aside as whole elements, never by matching their words elsewhere, and a control
inside a sentence leaves the sentence whole. The control pressed is set aside whole
only when it says no more than a label and the account; otherwise only its label is. A
language picker is a closed dropdown or combo box showing one short choice; a list box
shows every option, so its options count. Any more text makes it no finite step,
whatever it says and wherever it is: another heading, or a link or an element that acts
as a button with any other label. Text the page shows outside its own text cannot be
counted, so it stops a confirmation outright: generated content or a list marker whose
quoted strings have letters, also on an element with no box of its own, quotation marks
set with letters, a counter in a lettered style such as lower-alpha or upper-roman, a
shadow root with letters, a visible frame, an image that failed and shows its
alternative text, an image button with alternative text, or an input button with any
other label. Only quoted strings count in generated content, so an icon drawn with
url(), a numbered counter or the usual quotation marks do not. An image still loading
shows nothing yet; the page is read again just before the press, which catches one that
fails by then.

The allowance is 16 letters. It is room for the short lines real confirmations show,
such as "Not you?" or a copyright line, not a reading of them, so a phrase as short as
"Gets your email" still passes. That is accepted: the page has already named the account
in its heading, sharing and access wording is caught by the word list, and an app's
list of what it receives does not fit in 16 letters.

An account list's entry is read as rendered, so a tile's name, account and state lines
stay apart. Receive, provide, send and get access, and 取得, 受け取, 提供 and 送信 in
Japanese, count as sharing wording too. "Welcome back" and "Use this account" are not
confirmation headings, since neither names the account. Stay-signed-in questions and
account lists keep their own rules.

## Review hardening 2026-11-16: interrupted holds

An ended flow leaves an interrupted hold only when it may have spent its entry: a click
intent was made durable or pressed, or the tab had already reached the IdP. A flow that
stopped before that, as when preparing its entry failed, leaves none. After a worker
restart every flow the journal still names becomes a hold, since what it did last is
unknown; a flow that was still running is held from the restart, not from when it was
written. A hold waits only for automatic logins on the flow's RP and IdP origins in that
tab; other origins and frames are not held. It ends when the tab's top document goes to
another origin, when the person starts a login there, when the tab closes or is
replaced, or ten minutes after it was made. The session journal
keeps at most 100 records: a fuller journal on restart keeps its newest records, and a
write drops the oldest holds instead of failing.

## Review hardening 2026-11-16: the RP return comes after the IdP

An RP page is the flow's return only once the tab has reached the IdP. Before that, the
original page and any RP page on the way to the IdP wait, and a new RP page before the
entry was pressed ends the flow. The original RP document showing again after the IdP
was reached comes back from the back/forward cache: the person left, so the flow ends
and no longer holds the RP and IdP in other tabs.

An IdP with an existing grant and session often sends the tab straight back with no page
of its own, so no IdP document is ever seen. Once the RP entry's click was spent, a new
RP page is therefore a possible return even before the IdP was reached. It completes
only on the page's own evidence, and the RP-return judge is not asked there. Nothing
showed which IdP account signed in, and the IdP may hold another of the person's
accounts, so a bracket-form method needs the RP to show the selected identity itself;
a marker alone is not enough. A URL-form method, which has no RP identity to compare,
may complete on a native or learned marker, but only as an unconfirmed sign-in: it
saves no account choice or default, keeps no session pick
([ADR 0063](0063-switch-accounts-from-the-popup.md)) and leaves no confirmation proof.
Without such evidence the flow keeps waiting, as on an RP page on the way to the IdP. A
page that shows the site's sign-in again (its SSO entry, a password form or a rejected
sign-in) or another account means the IdP refused at once, as a failed silent sign-in
or a revoked grant does, and ends the flow. Only an entry read as shown counts: a page
that cannot be read, as one moving on while it is read, keeps the flow waiting. A **Log
in now** the person starts on the RP also ends it, so an RP page never waits for a flow
the person has moved past; the page that asked is not cancelled and goes on with that
login. The popup offers it on the flow's top RP page only while the flow just waits:
its entry was spent and the tab came back, or its IdP login finished, and no entry,
step or admission of the page is in flight. While the tab is at the IdP, or something
is in flight, the request is refused as a running login
([ADR 0088](0088-popup-manual-login.md)).

## Review hardening 2026-11-16: settings an SSO flow depends on

A settings change or a vault notice ends an active parent flow only when something the
flow depends on changed: either account's eligibility, item or connection snapshot, the
RP and IdP pages' sign-in permission, exclusion, allow list or master-password ask,
private-window pausing, or the two origins' saved defaults. A newer revision that
changes none of these, as another site's account choice or a sync of unrelated settings,
carries the flow over to it, and each scope check compares the same things rather than
the revision. Every effect still checks the current settings before it acts. The IdP's
own native login, while it runs, stops on any settings change as every native login
does ([ADR 0027](0027-per-account-login-routes.md)), which ends the flow with it.

## Amendment 2026-11-18: the IdP's own login is logged and goes on past its submit

Status: accepted. An agent made every decision below and implemented it. The owner
approved decision 3, that an IdP page with nothing to choose waits and presses nothing
instead of stopping the flow, on 2026-11-19 at 01:37 UTC (「待つ(何も押さない)」); the
other decisions are the agent's.

On 2026-11-18 at 18:02 UTC, in the owner's Chrome, the flow of
[#1687](https://github.com/risu729/pateat/issues/1687) pressed "Sign in with IBMid" on
`flow.idp.hashicorp.com/login` by itself, and the tab reached `login.ibm.com`. The local
log, at every level, shows the IdP's own login start on `/authsvc/mtfim/sps/authsvc`
(`login.start`, route `password`, no `startStep`) and its recipe use, then nothing for
83 seconds, then `login.refused` `sso-idp-stop` on `/risk/v3.0/authz/pages/compute`, the
parent's `login.attempt` `blocked` `cancelled` with reason `sso-idp-stop` (`personMs`
0), and `login.refused` `sso-interrupted` on the IdP's method chooser
("Verify your identity", two method buttons, no input). The owner did not touch the IBM
pages.

What the code shows (agent's reading, 2026-11-18):

- **The IdP showed its identifier step.** A new login starts only once its document
  reports a first step of the recipe ready
  (`apps/extension/src/login/runtime/admit-recipe.ts`, the check before
  `startsFor`), and a later start logs `startStep`. So the identifier input was ready
  when `login.start` was logged; the IdP did not skip it on that page.
- **The IdP's own login logged nothing.** `reportAttempt` returned at once for an SSO
  child (`attempt.ts`), so its every `login.attempt` line was dropped, and a page that
  resumes a login logs no `login.start`. A child that filled the identifier, advanced,
  filled the password and submitted, as the same recipe did on its own on 2026-11-17
  before the method chooser, logs exactly what the 18:02 log holds. The log therefore
  cannot tell that run from one that filled nothing, and the code cannot rule out that
  Pateat typed the identifier and the password; it makes it the likely course.
- **A step's wait is bounded.** Every fill and click waits for its elements at most
  `LOGIN_STEP_WAIT_MS` (10 seconds) in the page (`login.await`) and ends
  `elements-timeout` with the check that still failed; that line was dropped too.
- **A second silent path.** A step of the child whose parent's scope no longer held,
  as when the tab's URL changed before its document announced it, returned unauthorized
  without a change or a line (`allowed` in `plan-2.ts`).
- **Why `sso-idp-stop`.** The flow reads every IdP page before the tab's ordinary
  admission (`ssoAdmit` in `sso/flow.ts`). A page that reads as neither the IdP's
  sign-in form nor an account list, confirmation or stay-signed-in question reads
  `unknown` (`readSsoIdp` in `content-sso.ts`). So does an account confirmation whose
  other text is over its allowance of 16 letters (`CONFIRM_TEXT_LETTERS`), which is no
  finite step. Such a page ended the flow, also while the IdP's own login had just
  submitted. The risk check has no input and names no step, so it ended the flow before
  the child could read it.
- **The next stop in line.** A child whose result settled as unknown, or that is watched
  after a challenge ([ADR 0027](0027-per-account-login-routes.md)), ended the flow
  (`ssoChildChanged`), although the watch is how a direct login enters a handler on a
  page such as the method chooser.
- **No start at a handler.** A login starts at the first step or, under
  [ADR 0049](0049-start-at-a-later-step.md), at a later `fill` step that shows;
  never at a handler. Handlers are entered only after an effect step, when its result is
  read or during the watch.

Decisions (3 approved by the owner, the others the agent's):

1. **The child's lines are logged.** Each `login.attempt` line of the IdP's own login
   carries `ssoChild` and goes to the local log only: not to the badge, the first-login
   result, the login records or the recipe use, where the parent stands for the login,
   and not to the service as a problem line (`LOCAL_ONLY_FLAGS`,
   [ADR 0066](0066-problem-lines-sent-to-the-service.md)). A child the flow detaches
   before a finite step or on the RP return logs its end too (`sso-detached`, and its
   release as a repeat, `sso-released`), so every child that ends has an end line. A
   step its parent's scope no longer authorizes logs `login.refused`
   `sso-scope-changed` with detail `idp-step`: at info the first time for its document
   and path, and at debug for each repeat there. The info line goes to the service as a
   problem line, as every `login.refused` does (ADR 0066); a debug line never does. The
   flow's ten minutes bound the wait.
2. **A page that is no step belongs to the running child.** An IdP page that reads
   `unknown` while the IdP's own login runs (it has neither signed in nor stopped) is
   admitted with that login's record, so the login reads it as a direct login of the IdP
   reads its next page: its handlers, its markers, its wait for the site and its watch.
   That includes an account confirmation over its text allowance, which before stopped
   the flow: the child's ordinary admission acts only on its own recipe's targets, never
   on the page's confirmation control.
3. **Otherwise only a page with nothing to choose waits.** Each `unknown` reading says
   whether the page offers the person a visible control of its own: a button, a link, a
   field, a list, a frame or an element with such a role, with an area greater than
   zero (`controls`, from `offersControls` in `content-sso.ts`, read also when the
   page's observation is incomplete). An IdP page that reads `unknown` with no control,
   before the IdP's own login began, as an interstitial on the way to the sign-in form,
   or after that login signed in, as a page on the IdP's way back to the RP, refuses
   `sso-in-progress` and the flow waits for the tab's next page, bounded by the flow's
   ten minutes (`sso-expired`). Nothing is pressed or filled on it, and only the RP's
   own evidence completes the flow. An `unknown` page that offers its own choices at
   those times, as a browser-identity button, a link to another provider, a "Verify
   it's you" page with its Next button or a method chooser no login of the IdP reads,
   still stops the flow with `sso-idp-stop`, as under the
   [hardening of 2026-11-16](#review-hardening-2026-11-16-finite-idp-steps-named-by-the-page):
   the flow cannot tell which choice the person wants, and a page with choices does not
   move on by itself. So do a page that reads `unsafe` and an `unknown` page after the
   child ended `blocked`, including one the flow detached before a finite step. While
   the child runs, decision 2 holds whatever the page offers.
4. **A watched child keeps the flow.** Only a child that ended `blocked` ends the flow
   (`sso-idp-child-stopped`). One whose result settled as unknown or that is watched
   after a challenge keeps it: its watch may enter a handler on the IdP's next page, and
   the RP return, which needs the RP's own evidence, completes the flow.

Proposed, not implemented (needs the owner's decision): **a start at a handler**. Where
the IdP shows a later state of the recipe with no first step, as a method chooser after
a remembered session, the smallest general change is a third start beside the first step
and ADR 0049's later step: a page on the recipe's path that shows none of its first or
later steps, and shows the target of one of its handlers whose fact the item holds,
starts the login with that handler entered, as if the last effect step had just led
there. It would prefer a `passkey` handler, then the page's own passkey request answered
with the item's passkey ([ADR 0034](0034-answer-page-passkey-requests.md)), then an
`authenticator` or `totp` handler. It needs a new start kind in the attempt contract and
its record, and no recipe revision for handlers the recipe already holds; a `passkey`
handler for a button such as a security-key or platform-authenticator method exists only
where the judge named it (`passkeyButton`, which an
[ADR 0081](0081-authenticator-method-button.md) `authenticator` handler never is), so a
recipe without one needs a new revision from the judge, which is a paid call.

Checked with local runtime tests only
(`apps/extension/src/login/runtime-tests/sso-idp-later-page.test.ts`), not on the real
sites.

## Amendment 2026-11-20: the RP return waits for the RP's evidence

Status: accepted. An agent made these decisions within this ADR and implemented them.

On 2026-11-20 from 14:33 to 14:37 UTC, in the owner's Chrome (build `1f892101`), HCP
signed in through IBMid by itself: the IdP's own login filled the email and password,
went through the risk check, picked the authenticator on the method chooser with its
handler, filled the TOTP, and the tab came back to HCP's dashboard. The records said
otherwise: the parent ended `blocked` `cancelled` with `sso-return-unconfirmed`
(`personMs` 0), the IdP's login `blocked` `cancelled` with `sso-detached` and
`sso-released` at 14:35:28, and about 40 `sso-scope-changed` `idp-step` refusals came
62 ms apart from 14:35:24.5 to 14:35:26.9, with more at 14:33:59 and 14:34:05.

What the code showed (agent's reading, 2026-11-20):

- **The return ended at the first RP page.** Once the tab had reached the IdP, the first
  RP page after it completed the flow or ended it with `sso-return-unconfirmed`
  (`ssoAdmit` in `sso/flow.ts`), also when it only proved nothing yet, as the RP's own
  callback, a page still loading or one whose URL the site changed in place does. An
  instant return already waited on such a page
  ([hardening of 2026-11-16](#review-hardening-2026-11-16-the-rp-return-comes-after-the-idp)).
- **The IdP's login was cancelled before the RP was read.** The RP return detached it
  and recorded it `blocked` `cancelled` before reading the page, so a login whose TOTP
  led to the sign-in was logged as cancelled.
- **A step's reads went on in a document the tab had left.** After an effect step, a
  login reads its page every 50 ms for up to three seconds (`reconcileBounded` in
  `sign-in.ts`), checking the flow's scope each time (`hopScope` in `plan-2.ts`). That
  scope needs the tab's URL to be the document's (`ssoScope`), so once the submission's
  next page committed, or the page changed its URL in place, every round was refused
  until the three seconds ran out: the lines after the TOTP, the password (14:33:59) and
  the risk check (14:34:05). Only the first line per document and path was info. The
  refusal itself was right, as the tab no longer showed that document; the steps on the
  method chooser and the TOTP page had been authorized.
- **The 14:34:04 line**, `reconciling` `unknown-submit` on
  `/risk/v3.0/authz/pages/compute`, is the IdP's login resuming on the risk check after
  its password submit (decision 2 of 2026-11-18): its submission's result is not known
  yet there, which is no end. It is unchanged.

Decisions:

1. **An RP page that proves nothing yet waits.** After the IdP, an RP page completes the
   flow on its own evidence as before. One that shows the site's sign-in, another
   account or a page that is never a return (`unsafe-return`: a permission, sharing or
   account creation page, also after an IdP that showed none) ends it with
   `sso-return-unconfirmed`. A page that is still loading, cannot be read, shows nothing
   yet (`blank` in the `login.observe` reading: no visible text, also in its shadow
   trees, and nothing the signed-in extractor would describe, as the RP's own callback
   or a portal still rendering in place) or changed its URL in place refuses
   `sso-in-progress` with detail `rp-return`, and the flow waits for the tab's next page
   or the page's next reading, bounded by its ten minutes. Any other loaded page that
   proves nothing ends the flow `sso-return-unconfirmed` once no judge can confirm it:
   none can be asked (no generation service, or a page that cannot be described or
   sent), or the judge answered for that page and path with anything but `signed-in`. A
   code or CAPTCHA page ends it too. Each of these ends it only while the page is still
   the one read: one whose URL moved meanwhile, as a callback replacing itself while it
   is described, refuses with detail `rp-return:unscoped` and is read again where it
   went. Narrowed the same day from "any other page waits": the packaged-extension specs
   end such a page blocked (`sso-flow.spec.ts`'s wrong-account and unidentified returns,
   `sso-generation.spec.ts`'s fresh RP document without its learned marker), and a
   ten-minute wait on a page that proves nothing is the experience the owner had
   complained of.
2. **The RP-return judge once per RP document and path**, not once per flow, and only on
   a page that shows something, so the RP's blank callback does not use up the question
   its signed-in page needs. Each question still counts toward the recipe's daily
   judgements. A `signed-in` answer has the page read again as a fresh return, which
   completes only on its own evidence or the learned marker and otherwise ends.
3. **The IdP's login ends with its true state.** The RP return withdraws its authority
   at once and records its end only when the flow ends: `authenticated` when the RP
   showed the sign-in, else as its state machine ends a login whose tab left its origin:
   `blocked` `left-origin` after a submission it awaited, `blocked` with the outcome it
   had while watched (as `challenge`) or once its result settled as unknown
   (`unknown-submit`), and `interrupted` before any step; a login that had already
   ended keeps its end (corrected by the amendment below). It is released from its IdP
   hold either way and logged once with
   `sso-released`, and still gives no IdP default, account pick or authentication proof.
   A login the flow detaches before a finite step still ends `cancelled` with
   `sso-detached`.
4. **A step stops reading a document the tab left.** When the flow's scope refuses a
   step of the IdP's login and the tab's URL is no longer the document's, the login
   reads that document no more (`leftDocument`) and waits for the tab's next page. The
   document is asked once to announce again (`login.reconnect`), so a URL it changed in
   place is admitted again through the
   [refresh of 2026-11-12](#review-hardening-2026-11-12-in-place-idp-path-changes). The
   refusal is logged once. An IdP document whose URL is no longer the tab's when it
   announces, or by the time its scope is checked, as one that answers that request only
   after the flow pressed its finite step there, refuses `sso-in-progress` with detail
   `idp:left` and ends nothing: the tab's next document is read instead. One that is
   still the tab's document, as an IdP's own routing replaced its URL while it was read,
   is asked once to announce again, so it is read at its new URL.

Checked with local runtime tests only
(`apps/extension/src/login/runtime-tests/sso-idp-totp-return.test.ts`), not on the real
site.

## Amendment 2026-11-20: a return to another origin of the RP's site

Status: accepted. An agent made these decisions within this ADR and within the
[same-site return of ADR 0085](0085-one-item-for-native-and-sso-login.md#amendment-2026-11-18-an-rp-return-on-another-origin-of-the-same-site),
and implemented them.

In the same run (build `1f892101`), the tab came back from IBMid to
`portal.cloud.hashicorp.com`, another origin of the site of the flow's broker page
`flow.idp.hashicorp.com`, which has no recipe of its own. The flow ended there with
`sso-return-unconfirmed` five seconds after the IdP's login was detached, with no
`recipe.judge` line. What the code showed (agent's reading, 2026-11-20):

- **The RP-return judge refused any origin but the recipe's.** `judgeSsoCompletion`
  (`packages/generation/src/generate/sso-completion.ts`) answered `null` for a page
  whose origin is not the SSO recipe's, which the service sends as 400 and the device as
  no answer. The extension logs no line for the RP-return judge, so its absence in the
  log does not show it was not asked.
- **The RP's markers were read for the RP's origin only.** The return read the RP's
  native markers learned on the RP's own origin, never those its native login learned on
  the page's origin (ADR 0022), so a portal's marker never counted there.
- **A page that changes its URL in place was not read again**, the known limit of the
  amendment above, which an SPA portal's callback hits.

Decisions:

1. **The judge judges a page of the RP's site.** The RP-return judge accepts a page of
   any origin a login of the recipe's origin may move to (`loginMoveFits`, before a
   second factor), as the native completion judge does. The extension asks it only for a
   page `ssoReturnOrigin` admits, which also needs the RP item to match.
2. **Markers of the page's origin first.** The return reads the RP's native markers
   learned on the page's origin, then, on another origin of its site, the RP origin's
   own. A marker the RP-return judge learns on another origin of the site keeps that
   origin in the SSO layout (`origin`, as native markers do) and counts only there, in
   the judge's checks and in the extension's reading alike; one without counts on the
   recipe's own origin, and a recipe whose marker names that own origin is refused. An
   older extension that does not know the field refuses such a recipe, so the service
   release goes with the extension's.
3. **An RP page that changes its URL in place is read again.** When the tab's URL of a
   waiting RP page changes in place, or differs from its announcement when admitted, the
   page is asked to announce again (`login.reconnect`), as the IdP's left documents are
   in decision 4 above, and its admission refuses with detail `rp-return:moved`. A page
   being read is asked only after its reading, so a URL it replaces while its sign-in is
   written does not replace the document that write holds.
4. **One reading of an RP page at a time.** A second announcement waits for the reading
   in progress and is then read afresh, or answers `sso-completed`, so a flow completes
   once.
5. **Why the return waits is logged.** The `sso-in-progress` refusal's detail is
   `rp-return:` and its reason: `unscoped`, `unread`, `loading`, `incomplete`,
   `unobserved` (a page that shows nothing yet) or `moved`, and before the IdP also
   `code`, `captcha` or `no-evidence`. An
   `unsafe-return` reading now ends the flow on the instant path too; any other refusal
   of the identity check, as `cancelled`, is an unread page that waits.
6. **A page rendered in place is read again.** The judge's question is used once per RP
   document and path, and only once the judge is asked. A waiting RP page that shows
   nothing yet is asked, at most three times per document and never past the flow's ten
   minutes, to say once it no longer does, by the same rule (`login.extract.watch` with
   `shown`); it is then asked
   to announce again, so a portal that renders its signed-in view in the same document
   and at the same URL is read as it now shows.
7. **The site's sign-in ends the wait.** A waiting page holds the RP's and the IdP's
   origins in the tab's other logins' way for up to ten minutes, so after the IdP a page
   that is the site's sign-in ends the flow with `sso-return-unconfirmed`: besides a
   password form, one without the RP's evidence whose identifier input asks for the
   account (`signInIdentifier`: the page's only input to type into, as a page asking for
   the email first, or one with a password input in its form), and one the judge reads
   as `rejected`. An email input beside other inputs, as a newsletter or invite field,
   does not end it by itself: such a page goes to the judge, which refuses a page with a
   text field as `not-judgeable`, and that answer ends the flow as any other but
   `signed-in` does (decision 1 of the amendment above). Before any IdP page (the
   instant path), such a page is the RP's own way to its IdP, as one asking for the work
   email to find the provider, and waits. A rejected sign-in's `alert` or an invalid
   field is never read on a return page, as `login.state` reads them only after a
   submission in the same document.
8. **A completion that cannot be recorded ends the flow.** When the page or the flow's
   scope changes while the signed-in record is written, the parent is recorded
   `cancelled` (`sso-scope-changed`, or the reason that ended the flow meanwhile) and
   the flow ends, rather than waiting with its timer cleared. Once recorded, the IdP's
   login is released signed in at once, before the RP default is saved, and the flow
   ends whatever a later write does; a flow ended after its parent's record was written
   releases that login signed in too and holds nothing as interrupted. A flow ended
   while that record is still being written releases it as any ended flow does, as the
   record then fails its check and the parent is recorded `cancelled`.
9. **A restart leaves the IdP's login no hold.** The RP return stores the IdP's login
   released at once, as the flow holds both origins while it runs and its interrupted
   hold does after a worker restart; its end is still recorded with the flow's. After a
   restart that end line is not written. A released login holds nothing through its
   watch either.

The judge's change reaches service-backed devices only with a service release. Checked
with local tests only (`sso-idp-totp-return.test.ts`, `sso-completion-backend.test.ts`),
not on the real site.

## Amendment 2026-11-21: an IdP step's operation counts from its delivery

Status: accepted. An agent made this decision within this ADR and implemented it.

On build `0cf49d81`, the IdP's own login of an SSO flow through IBMid filled the email
and pressed Continue, then logged its password fill at 10:21:08 UTC and ended
`cancelled` (`not-authorized`) at 10:21:24, with `checkMs` 47,300 of its 80,968 ms. The
flow ended `sso-idp-child-stopped`, with no `sso-scope-changed` line. A direct login of
the same recipe at 10:33 filled the password and signed in. What the code showed
(agent's reading, 2026-11-21):

- **The page's authorization came after the operation expired.** A step's operation is
  valid for 15 seconds from when the worker builds it. Before delivering it, the worker
  checks the step's policy and reads its values from the vault; the page then asks for
  its authorization, which checks the policy again (`allowed`) before it checks the
  operation (`validateLoginOperation`). A check that ends past the operation's 15
  seconds answers `false`, which the page reports as `not-authorized`.
- **An IdP login's checks are the slow ones.** Each policy check of an SSO hop's login
  checks its flow's scope twice (`hopScope`), and each scope check reads the flow's SSO
  mapping from the vault again (`validate`). A fill thus waits for four vault reads of
  the mapping and its own value reads, where a direct login waits for its value reads
  only. In that run each policy check took about six seconds.

No change of the 2026-11-20 amendments was found on this path; the checks above were
already there on `1f892101`, where the same fill went in, presumably with faster vault
reads.

Decision: **an operation's 15 seconds count again from its delivery.** The worker
delivers the operation it built with its time set to 15 seconds from then
(`deliverLoginOperation`), after the step's policy check and vault reads, and keeps that
delivered operation as the one the page's authorization, destination and keypad checks
validate. The page's own authorization still checks the policy, the flow's scope and the
operation at once before the step acts, and the bound still ends a step whose page never
acts. It applies to every login's steps, not only an IdP's.

Checked with a local test (`sso-idp-operation-time.test.ts`), whose scope checks and
vault reads take 16 seconds before the page's authorization ends: it fails without the
change. Not checked on the real site.

## Known limits 2026-11-16

- **A layout full of unseen markers.** An SSO layout keeps at most four RP-return
  markers. When all four are kept and a return shows none of them, the page is no longer
  sent to the RP-return judge, so no fifth marker is learned. A URL-form method, whose
  return needs a marker, then never completes on that layout until its recipe is revoked
  or ages out and is generated again. A bracket-form method still completes on the
  selected identity.
- **A portal judged while it shows part of its content** (added 2026-11-20). An RP page
  after the IdP that shows some text but not yet its signed-in view, as a portal still
  rendering or a path it routes on from, is read (and judged, where a judge can be
  asked) as it shows then, and the flow ends `sso-return-unconfirmed` when that proves
  nothing; it is not read again once the page completes in place. Only a page that
  shows nothing at all, as an empty root or a spinner without words or controls, waits
  for that. Conversely, an RP page whose content is only in an iframe or a canvas reads
  as showing nothing, as neither the reading nor the extractor sees into them, and waits
  until `sso-expired`.
- **An IdP on the RP's own site** (added 2026-11-20). An RP return may land on any
  origin of the RP's site but the selected IdP's own. Where the IdP shares that site,
  its other origins, as a second host of the same IdP, read as the RP's return too,
  still only where the RP item matches them. Excluding the IdP's whole site would forbid
  every same-site return for such setups.
- **Settings changes during the IdP's own login.** The IdP's native login stops on any
  settings change, as every native login does
  ([ADR 0027](0027-per-account-login-routes.md)), and the flow ends with it, even when
  the change does not touch anything the flow depends on.
