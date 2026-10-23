# ADR 0007: Assert existing passkeys through a fail-open bridge

Status: accepted for M5. On 2026-10-10 the owner chose to set UP and UV on every
claimed assertion without a user gesture, knowingly departing from the WebAuthn
ceremony; this amends the truthful UV/UP condition in
[ADR 0001](0001-local-login-boundary.md). A per-site setting is planned later.
Also on 2026-10-10 the owner chose the official Bitwarden client's item rule:
search every live login item by RP ID, and use the site default only to choose
among several matches (see [Item selection](#item-selection)). After the official
Bitwarden extension was found wrapping `get` outside Pateat, the owner chose on the same
day to keep Pateat's wrapper outermost whatever the extension order (see
[Bridge topology](#bridge-topology)). Also on 2026-10-10 the owner chose to register the
bridge in the production build on every top-level HTTPS page and to sign wherever the
item selection allows on sites that are not excluded, rather than only on sites with a
synced recipe. Amended on 2026-10-11 by the owner's
[compatibility before release](../development.md#compatibility-before-release)
decision: settings holding a site default saved with a `connectionId` are rejected as
invalid. Amended on 2026-10-11 by
[ADR 0021](0021-account-choice-outside-settings.md): several matches with no default
open a Pateat chooser window instead of delegating at once, and so do username-less
requests after Pateat signed in the same tab.
Amended on 2026-10-11 by [ADR 0027](0027-per-account-login-routes.md): during a login
that has not ended, a request from its tab and origin uses that login's own item
(implemented).
Amended on 2026-10-12 by [ADR 0034](0034-answer-page-passkey-requests.md): a top
document's `conditional` request is answered through a Pateat login of that document,
with UP and UV set as for `optional` requests, and otherwise handed on (implemented).
Amended on 2026-10-12 by the owner's choice at 19:32 UTC: a `required` request, as
Wise's "Log back in" makes, is claimed as an `optional` one is, since a passkey request
shows the browser's prompt either way and any page that can make one can make the
other. As for `optional`, Pateat skips the person's confirmation the site asked for
(implemented).
Amended on 2026-10-12 by the owner's choice at 20:56 UTC (that Pateat declines, option C
of the proposal reviewed with the owner): `navigator.credentials.create` is wrapped as
`get` is, and Pateat refuses a registration that lists a passkey of the vault within
five minutes of its own sign-in to that site in the same tab; every other registration
is handed on (see [Registration after a sign-in](#registration-after-a-sign-in);
implemented, and confirmed on Wise in the owner's Chrome on 2026-10-13).
Amended on 2026-10-13: the owner chose the `DER` helper of `@noble/curves` for the
signature wrapper (see [Alternatives](#alternatives)).
Amended on 2026-10-14: Chrome 149's Immediate UI asks with `uiMode: "immediate"` instead
of `mediation: "immediate"`. The owner chose at 06:44 UTC to keep delegating these
requests for now and to consider answering them later: the page relays such a request
as `immediate` mediation, which delegates and is logged as `immediate` (implemented).
Amended on 2026-10-19 by [ADR 0052](0052-immediate-ui-stored-passkeys.md) (owner, 13:36
and 20:48 UTC): Immediate UI requests are answered like other get requests, and the page
relays `uiMode` beside `mediation` instead (implemented).
Amended on 2026-10-14: finding and signing with a stored passkey also ignore
Bitwarden's master password re-prompt (`reprompt: 1`), as filling does
([vault adapter](../architecture.md#vault-adapter)). Settings for UP/UV and for
re-prompt are planned for [phase 3](../plan.md#phase-3-public-release) (owner,
2026-10-13 21:57 UTC); until then both stay as they are.
Amended on 2026-10-23 to match the code since
[ADR 0021](0021-account-choice-outside-settings.md): [Bridge topology](#bridge-topology)
said navigation does not cancel a request, but leaving a document cancels its pending
requests. The owner accepted (option A) that a signature finishing just before that
cancel arrives still counts as a sign-in ([plan](../plan.md#passkey-progress)).

Amended on 2026-10-12 under the owner's passkey-first policy of 13:58 UTC
([ADR 0034](0034-answer-page-passkey-requests.md)), after a log from the Grok Bot's
browser (20:37 UTC, build `f2c68aa`): Google's sign-in asked with a 2,056-byte
challenge, which the first bound of 1,024 bytes handed on (`invalid-request`, `invalid`
`challenge`). WebAuthn sets no upper bound, so the bound is now 4,096 bytes, the size
the page's copy of a buffer already allows. A larger challenge is still handed on, by
the page before any log (implemented).

Amended on 2026-10-14 by
[ADR 0029](0029-local-sign-in-state.md#amendment-unconfirmed-completion-2026-10-14):
only confirmed completion counts as a successful sign-in (implemented); see the dated
amendment below.

Amended on 2026-10-17: the bridge snapshot relays `timeout`, which only bounds the
chooser window ([ADR 0021](0021-account-choice-outside-settings.md)); see the dated
amendment below.

Amended on 2026-10-23 by the owner's request at 12:15 UTC: as in the official Bitwarden
extension, the chooser can hand a site's passkey requests to the browser for good, and
the person can undo that later on the settings page; Pateat then answers no passkey
request on that hostname (see the dated amendment below; implemented, unit and synthetic
component tests only).

Date: 2026-10-10

## Context

[ADR 0001](0001-local-login-boundary.md) puts existing zero-counter software
passkeys in initial scope, subject to truthful UV/UP and interoperability gates.
The [architecture](../architecture.md#existing-passkeys) requires a document-start
MAIN-world bridge and native admission checks. The
[dated research](../research/2026-10-10-passkeys.md) records the WebAuthn
requirements, pinned Bitwarden behavior and the SDK surface this design relies on.

## Decision

### Bridge topology

Register a MAIN-world wrapper for `navigator.credentials.get` at document start in
top-level frames only, as a static content script on `https://*/*` (and, since
[ADR 0050](0050-http-pages-for-http-items.md), `http://localhost/*`) under the
install-time access of [ADR 0009](0009-install-time-https-site-access.md), with an
isolated-world relay on the same pages. It snapshots the request, forwards a bounded
copy to the isolated content script, and either returns a Pateat assertion or calls the
browser's original `get` with the original arguments. Delegation is the default for
every case Pateat does not claim, so excluded or unsupported requests keep ordinary
browser behavior, including other installed passkey providers.
`navigator.credentials.create` is wrapped the same way, with the accessor and fallback
rules below kept apart from `get`'s. Pateat never answers it with a credential: it only
refuses a registration as
[Registration after a sign-in](#registration-after-a-sign-in) describes, and hands every
other one on with the caller's original arguments.

Pateat stays outside other passkey providers' wrappers. Chromium decides the order in
which different extensions' MAIN-world document-start scripts run, and Pateat cannot
choose it. The official Bitwarden extension (browser-v2026.6.1 `fido2-page-script.ts`)
saves the current `get` and then assigns its own. When it runs after Pateat, its wrapper
sits outside and answers first: for public-key requests it rejects with `Error`, or
holds the request while its vault is locked, instead of delegating, so Pateat never sees
them. Pateat therefore installs `get` as an accessor property on `navigator.credentials`
whose getter always returns Pateat's wrapper. Assigning another function, such as that
provider's wrapper or its later restore of the function it saved, only replaces the
function Pateat delegates to; assigning a non-function or Pateat's own wrapper is
ignored. A provider that redefines or deletes the property, or patches
`CredentialsContainer.prototype.get`, is not covered.

A provider that falls back calls the function it saved, which is Pateat's wrapper. A
call with the same `mediation` as a request Pateat is still delegating, and either the
same options object or the same `publicKey` object, is treated as such a fallback and
goes straight to the function present when Pateat installed itself, normally the
browser's original. The `publicKey` match covers shallow copies such as
`{ ...options, signal }`, which Bitwarden passes for conditional requests. A call made
synchronously while Pateat is calling the function it delegates to also goes to the
install-time function, so a page shim that rebuilds the options (for example with a new
challenge) before calling its saved `get` runs once. A call that arrives while four
delegations with the same `mediation` are already in flight may still be claimed, but if
Pateat does not claim it, it goes to the install-time function instead of the next
wrapper. This stops a wrapper that rebuilds the options asynchronously after at most
four rounds. Pateat only ever sees the options such a shim received, so on a page whose
shim converts unreadable options (for example base64 strings into buffers) Pateat never
claims. Delegations count against the limit until the wrapper settles them, so a
provider that never settles abandoned requests makes later unclaimed requests of that
mediation skip it. The owner chose both rules on 2026-10-11 after such a wrapper was
shown to loop
([wrapper detectability](../research/2026-10-11-passkey-wrapper-detectability.md#page-side-wrappers)).
Other calls are handled normally, including a new modal request while a provider holds a
conditional or unclaimed one. If a provider injected before Pateat, the install-time
function is that provider's wrapper, even after it restores the browser's own.

The page and MAIN world are untrusted. The isolated script independently checks
`window.top === window`, `isSecureContext` and the `publickey-credentials-get`
permissions policy (`publickey-credentials-create` for a registration) before relaying,
and for `get` reports whether the document has transient user activation. The background
derives origin, tab, frame and document from the browser-supplied sender, never from
page data, and accepts only frame 0 of an `https:` origin or `http://localhost`. Each
`get` request has a short-lived operation ID bound to that document, and one document
may hold only a few at once. Abort, timeout, a settings change and leaving the document
(the relay sends a cancel on `pagehide`) cancel it; a late result is discarded. A
registration check is not cancelled: the background runs at most 16 at once across all
tabs and hands any further one on as `busy`, and an abort or the page's 15-second limit
only stops the page waiting. A lock or connection replacement during signing makes the
Worker's signature unavailable, so the request is delegated as a failed assertion. Pages
on an excluded site, or with no enabled connection, are answered from the settings
metadata without reading the vault catalog, so they do not restore a vault. If signing
finishes just before a left document's cancel arrives, the sign-in still counts: the tab
is recorded as signed in, the login and the registration check are told and a chosen
default is saved, while Chrome drops the response to the replaced document. The owner
accepted this few-millisecond race on 2026-10-23. The wrapper delegates if the relay
does not acknowledge a request promptly, so an invalidated extension does not hold
callers.

The background selects the credential and builds client data. Signing runs in the
crypto host Worker that owns the decrypted vault session, so the private key is
imported as a non-extractable WebCrypto key there and never crosses a message
boundary. Only the assertion fields return to the page.

### Registration after a sign-in

In the owner's Chrome on build `1df2d38` (2026-10-12, 20:17 to 20:43 UTC), Wise signed
in with the Wise item's passkey through Pateat (`passkey.request` `assertion`, for both
`conditional` and `required` requests). Afterwards the official Bitwarden extension
(browser-v2026.6.1) sometimes opened its "Save passkey" window with "A passkey already
exists for this application." and the Wise item. Bitwarden shows that text
(`passkeyAlreadyExists`) only on the `navigator.credentials.create` path, and only when
the request's `excludeCredentials` lists a passkey its vault holds. So Wise asks to
register a passkey after sign-in and lists the one Pateat just used. After the window is
closed, Bitwarden rejects the request. In the owner's Chrome on build `fdf57ef`
(2026-10-13, 02:25 UTC) Wise's call was `conditional` (Chrome's automatic passkey
upgrade) and came two seconds after Pateat's passkey sign-in, listing one credential:
Pateat declined it (`passkey.create` `declined`, `listed`), the login reached signed in,
no further registration came in the next minutes and no Bitwarden window was reported.

The owner chose on 2026-10-12 at 20:56 UTC that Pateat refuses such a registration. The
MAIN-world wrapper asks the background only for a `this === navigator.credentials`
public-key request with a non-empty, well-formed `excludeCredentials` (at most 64
entries), a string or absent `rp.id`, the members the browser requires (a challenge,
`rp.name`, a user ID, `user.name`, `user.displayName` and a `pubKeyCredParams` list), a
known or absent mediation, a genuine signal not yet aborted, and no other credential
type; every other request goes on at once, so a malformed one still gets the browser's
`TypeError`. The relay checks the document as
for `get`, with the `publickey-credentials-create` policy. The background refuses the
request only when all of these hold:

- it comes from frame 0 of the tab, and its RP ID is valid for the sender's origin
  under [Admission](#admission);
- in that tab, within the last five minutes, Pateat signed in there: it returned an
  assertion for that RP ID or to a page of an origin the RP ID covers, or a Pateat login
  of such an origin reached signed in on any route. These records are kept per tab in
  session storage, so they outlive a service worker restart but not the browser session;
  a closed tab's records go;
- `excludeCredentials` lists, by credential ID, a passkey of the vault that Pateat could
  sign with for that origin and RP ID, found by the same lookup a sign-in uses.

The page then gets `NotAllowedError` with Chrome's own message, as when Chrome's own
prompt is dismissed. A page that aborts while the check runs gets the abort reason, as
the browser gives. A locked vault, a failed or slow lookup, an excluded site or any
other case hands the request on unchanged. Like `get`, the own `create` accessor hides
later `CredentialsContainer.prototype.create` patches; a provider's non-configurable
`create` is left as it is, unchecked. Each checked request logs a value-free
`passkey.create` entry
([development](../development.md#why-a-passkey-request-was-delegated)).

Not chosen: answering `InvalidStateError` ("already exists"), which WebAuthn returns
only after the person confirms and which the site does not see today; and creating
passkeys in the vault, which is passkey registration and stays later work.

### Admission

Pateat claims a request only when all of these hold; otherwise it delegates:

- `publicKey` is the only credential type requested and mediation is absent,
  `optional` or `required`. Silent and immediate mediation delegate, and so does a
  request with `uiMode: "immediate"`; a request with any other `uiMode` is left to the
  browser. Amended on 2026-10-19 by [ADR 0052](0052-immediate-ui-stored-passkeys.md): a
  request with `uiMode: "immediate"` is admitted as a modal request. Conditional
  mediation is admitted only for the login runtime to decide, which answers it through
  a login of the document and hands it on otherwise
  ([ADR 0034](0034-answer-page-passkey-requests.md)).
- The caller is a top-level document, so `crossOrigin` is false and `topOrigin`
  is absent. Cross-origin frames, opaque
  origins and related origin requests delegate.
- The effective domain is a valid domain, not an IP address. An explicit RP ID is
  already in canonical lowercase ASCII form and is equal to, or a registrable
  domain suffix of, the effective domain according to tldts with private
  suffixes. A trailing dot is significant.
- The challenge is 16 to 4,096 bytes and at most 64 allowed credentials are
  given. Under the initial policy `userVerification` may take any value.
- The site is not excluded and [item selection](#item-selection) yields exactly
  one eligible credential.

Unknown extensions are ignored as the client algorithm permits; client extension
results are empty. PRF, large blob, AppID and hints are not interpreted, and the
bridge snapshot drops `timeout`, `hints` and `extensions` before relaying.

### Item selection

Follow the pinned official Bitwarden client
([`findCredentialsByRp` and `findCredentialsById`](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/platform/services/fido2/fido2-authenticator.service.ts)):
search every live login item, not only the site default, and do not use the item's
saved URIs. Skip disabled connections and excluded items. An item is a match when
its single stored credential is eligible as below. Then:

1. Exactly one match: use it. No site setting is needed.
2. Several matches: use the item in `siteDefaults` for the page's exact origin if it
   is one of them.
3. Several matches and no such default: Pateat never picks one. It opens its chooser
   window ([ADR 0021](0021-account-choice-outside-settings.md)) and delegates when the
   user closes it, picks the browser, or no window opens (incognito, a hidden or
   unfocused page, or another request holds it).

A request with no allow list for an RP ID that Pateat already signed for in the same tab
skips steps 1 and 2: it opens the chooser for one or more matches, the default first,
and never signs unasked (ADR 0021 part D). If a connection or item could not be
searched, it is delegated even when the default is among the matches.

Matches are counted after the request's allow list, or its discoverable-credential
requirement, narrows them. A passkey-only item with no fields is eligible; an item whose
fields the owner excluded is not. If an enabled connection could not
be searched, or an eligible item's passkey could not be read, a single match is not
used, since the unread item might also match; the site default is still used when it is
among the matches. This mirrors how the login flow refuses an automatic account choice
while any connection or item is unevaluated.

For example, two items each store a credential with `rpId` `github.com`, and
`https://github.com/login` requests `rpId` `github.com` without an allow list. With
`siteDefaults: [{ origin: "https://github.com", provider: "bitwarden", userId, itemId }]`
naming one of them, Pateat signs with that item; without it, the browser handles the
request. An allow list usually narrows the matches to one before this step. As for
logins, a default resolves to the one local connection of that provider account. An
account that is connected twice, or not connected here, gives no default.

### Credential eligibility and assertion

Map Bitwarden `fido2Credentials` in the Bitwarden package into a strict local
form: `public-key`, `ECDSA`, `P-256`, a non-empty PKCS #8 key, a GUID or
`b64.`-prefixed credential ID, a base64url user handle, `discoverable` of `true`
or `false`, and a decimal counter. The credential's RP ID must equal the request
RP ID exactly. With an allow list, its ID must be listed; without one, it must be
discoverable and have a user handle. A nonzero counter is reported as
`unsupported-counter` and never signed, because an assertion would require a
counter write to the vault. Zero counters stay zero.

Serialize `clientDataJSON` exactly as WebAuthn specifies, from the sender origin
and the request challenge. Authenticator data is the SHA-256 RP ID hash, flags,
and a zero counter, without attested data or extensions. Set BE and BS, matching
the synced credential registered by Bitwarden. Sign authenticator data followed
by the client data hash with ECDSA P-256 SHA-256 and return the DER signature.
Return the credential ID bytes, `authenticatorAttachment` `platform`, and the
stored user handle when present. Response objects mimic the native prototypes and
`toJSON` output.

### Presence and verification

The owner decided that Pateat sets UP and UV on every assertion it claims,
including page-load and executor-triggered requests without a user gesture and
requests whose `userVerification` is `required`. Pateat performs no presence test
or user verification; automatic vault unlock and the standing per-site account
choice are the only authorization. This does not satisfy the WebAuthn ceremony
and tells the relying party that verification occurred when it did not. Pateat
documents it as an owner-chosen deviation, not as verification.

The flags come from a `PasskeyPolicy` with two settings: presence `always` or
`activation`, and verification `always` or `never`. The initial policy is
`always` for both. Under `activation`, requests without transient user
activation delegate; under `never`, UV stays clear and requests requiring UV
delegate. Admission records the UV decision so signing cannot diverge from it. A
later per-site setting supplies the policy without changing admission or
assertion code; until then every claimed request uses the initial policy.

## Alternatives

- UP only with user activation and UV always clear: follows the ceremony, but
  page-load, executor-triggered and UV-required requests fall back to the
  browser and cannot complete unattended. Kept as a policy for the later
  per-site setting.
- Drive or depend on the official Bitwarden extension: inherits its prompts and
  focus requirements and is not an independent adapter.
- Use an SDK authenticator: the pinned WASM exposes none.
- Add an ECDSA or CBOR library: WebCrypto already provides ECDSA P-256 and SHA-256.
  Assertions need no CBOR, and the DER signature wrapper is a fixed structure
  tested against the WebAuthn vectors. No dependency is added.
  Amended 2026-10-13: the owner chose the DER helper of `@noble/curves`
  (`DER` from `@noble/curves/abstract/der.js`, not the `p256` curve) for the
  DER signature wrapper; `p1363ToDer` and `derToP1363` now call it, with a check
  that each scalar fits in 32 bytes. Signing stays WebCrypto. The change is low
  value (about 50 lines removed) and may be reverted if bundle size matters.
- Show a Pateat chooser or prompt: conflicts with the no-page-UI rule until an
  explicit later UI design exists. Reversed for an extension window by
  [ADR 0021](0021-account-choice-outside-settings.md); in-page UI stays rejected.
- Rely on extension injection order: the order follows extension IDs, which Pateat
  does not control for the owner's unpacked or store builds.
- Let the outer provider answer and claim the request only after it rejects:
  Bitwarden first shows its own "No passkeys found" window, and its generic `Error`
  cannot be told apart from a refusal the page should see.

## Consequences and verification

Pateat never blocks a WebAuthn request it does not claim, so failures surface as the
browser's ordinary passkey UI, or as another installed provider's UI or rejection.
Because Pateat answers first, a claimed request never reaches another provider such as
the official Bitwarden extension. A page's own assignment to `get`, such as a polyfill
or telemetry wrapper, likewise sees only requests Pateat does not claim, and reading
`get` back does not return it. Page script and other extensions can detect the accessor.
A page call that reuses the options or `publicKey` object of a request still being
delegated with the same `mediation` goes to the browser's original `get`, skipping later
providers. Claimed requests
complete unattended, and relying parties receive UV that no authenticator performed; any
script running in a top-level page of a site with a stored passkey, including injected
script, can obtain a verified assertion for that site without any Pateat site setting.
For five minutes after Pateat signs in to a site in a tab, a registration there that
lists the vault's passkey is refused, so deliberately adding another authenticator to
that account (Windows Hello, a phone or a security key) fails in that tab during that
time; another tab, or later, still works. The site gets Chrome's own `NotAllowedError`,
as when Chrome's prompt is dismissed. The check reads the vault only as a
sign-in does, writes nothing and needs no new permission.
Registration, nonzero-counter writeback, cross-origin frames, related origins and
extensions remain later work; conditional mediation is answered through a login under
[ADR 0034](0034-answer-page-passkey-requests.md).

Verify with the WebAuthn Level 3 ES256 vectors, HTML registrable-suffix cases,
credential mapping vectors, signature verification by an independent verifier,
and probe-build browser tests covering unattended claims, delegation, abort, timeout
and a synthetic relying party. Real-site interoperability and
coexistence with the official Bitwarden extension are separate gates.

## Amendment: confirmed login records for registration refusal (2026-10-14)

The owner's decision at 07:24 UTC in
[issue #546](https://github.com/risu729/pateat/issues/546), recorded in
[ADR 0029](0029-local-sign-in-state.md#amendment-unconfirmed-completion-2026-10-14),
amends "Registration after a sign-in": a login reaching `authenticated` counts as
"Pateat signed in here" only when its completion is confirmed. An undecided completion
with `unconfirmed: true` adds no sign-in record, so it cannot cause a later registration
request to be refused. A request with no qualifying record is handed on. Records from
Pateat's returned assertions and confirmed logins still count under the same origin,
RP ID, tab and five-minute rules. The earlier accepted text above remains as history.

## Amendment: the relayed `timeout` (2026-10-17)

Admission above says the bridge snapshot drops `timeout`. Since
[ADR 0021](0021-account-choice-outside-settings.md) the snapshot keeps a numeric
`timeout` of 0 to 2^32 - 1 milliseconds, truncated to an integer, and the background
uses it only to bound how long the chooser window may keep the request open. `hints`
and `extensions` are still dropped. This records the implemented behavior; no decision
changed. The earlier accepted text above remains as history.

## Amendment: sites whose passkey requests go to the browser (2026-10-23)

The owner asked on 2026-10-23 at 12:15 UTC (in Japanese; paraphrased): like the
official Bitwarden extension, let the choice to hand a passkey request to the browser be
remembered; it must be undoable; it is shared across the account (synced settings); the
settings page only needs to remove it, not add it.

- The chooser window's "Use the browser or another extension" opens a menu, as
  Bitwarden's "Use device or hardware key" does: "Just once" hands this request on, as
  before; "Always for this site" hands it on and then adds the requesting page's exact
  hostname (Bitwarden's `Utils.getHostname`, not the registrable site, and no
  subdomains) to the synced `passkeyBrowserSites` list.
- On a listed hostname Pateat answers no passkey request: every `get`, whether modal,
  `required`, `conditional` or Immediate UI, is handed on with `browser-site`, and so is
  every bridged `create`, which is then never refused. The list is read alongside the
  first lookups, so a request's deadline runs as it would without it, and nothing is
  signed, no chooser opens and no login is waited for before the list is known. Each of
  those steps asks again, so a hostname listed while a request waits, as a parked
  conditional one does, holds for it too. The worker keeps the list it read until the
  settings change. A failed read of the list
  hands the request on too (`assertion-failed`, cause `browser-site-lookup`).
- A login on such a page treats its item as holding no passkey: it takes a `password`
  route or refuses, never the `passkey` route, and a passkey-only page there is not sent
  for generation (ADR 0053). This follows from Pateat answering nothing there (the
  agent's reading, not confirmed by the owner).
- The extension's settings page lists the hostnames under "Sites whose passkey requests
  go to the browser", each with only a Remove button. A removal is a settings save, so
  the next request on that host is answered again without a reload.
- The chosen hostname holds at once, for passkey requests and for logins. It is kept in
  `storage.session`, so it also holds after a worker restart, which resumes its write
  while it was still waiting and within the wait limit. A write that had started is
  never repeated, so a removal on the settings page wins. The write waits up to two
  minutes for a running login, which a settings write would stop, as a settings sync
  does (the agent's addition, not confirmed by the owner). It is then written with the
  cause `passkey-browser-site`, which a save conflict on the settings page treats as
  background work (ADR 0025), and uploaded. The hostname leaves `storage.session` once
  the write lands or is refused. A full list of 1,000 keeps its entries.
- The refusal of an item without a password on a listed hostname names the list in the
  popup, not a missing passkey, since its passkeys are not read there
  (`password-empty:passkey-browser-site`).
- Under [ADR 0024](0024-settings-profiles.md) the list is a profile part, like
  `excludedSites` (the agent's assignment, not confirmed by the owner); with one
  profile it syncs to every paired device.
- Settings stored before the list existed read it as empty, in the service and in the
  extension (an exception to
  [compatibility before release](../development.md#compatibility-before-release),
  chosen by the owner on 2026-10-23 at 21:13 UTC).

Differences from Bitwarden are listed in
[Differences from Bitwarden](../bitwarden-differences.md#passkeys). The earlier
accepted text above remains as history.
