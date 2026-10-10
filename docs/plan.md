# Implementation plan

Status: M0 completed in [PR #1](https://github.com/risu729/pateat/pull/1). M1-M4 are in
progress (M4 has a sync skeleton and an offline AI harness slice); M5 has a proposed
design and its first slice; M6 is unstarted. The current foundation is not a working
autologin product or a completed M1 acceptance claim. This plan becomes the single work
tracker until an issue is needed for a concrete slice. Issues and PRs link to these
gates rather than maintaining a second roadmap.

## Foundation progress

Implemented: WXT production shell with no site permissions, human-operated status
page, strict Valibot status contracts, isolated localhost-only probe build,
health-only Worker with typed cf configuration, shared mise/hk checks, CI/CodeQL,
and disabled-by-default manual delivery of a verified main-build artifact.
Mise and Bun dependencies are locked; no native helper or production secrets are
required to build or test.

Local source/Worker tests, typechecks, builds, prebuilt dry-run and emitted-bundle smoke
checks have passed. At head `c24d82a`,
[Linux CI](https://github.com/risu729/pateat/actions/runs/37969704501) passed the
complete check graph, including all three Playwright tests for the production package,
installed shell status, and document-start/inactive-tab identity probe;
[CodeQL](https://github.com/risu729/pateat/actions/runs/37969704219) also passed. The
downloaded Windows Chromium still fails before launch with a missing SideBySide
assembly. The later installed-Chrome synthetic probe passed the early login gate;
broader coexistence remains a separate M1 gate. Code Quality setup remains
unavailable after language detection; see [merging](delivery.md#merging).

## Local settings progress

The first M2 slice provides explicit save/reload controls for local connection,
group/item selection, item/field exclusions, host exclusions and exact-origin
account defaults. Two bundled demo vaults contain display metadata only. There
are no credential values, provider sessions, real vault connections, page
observations or login operations.

Settings use a versioned local snapshot and a worker-owned revision check.
Stale saves fail without overwriting newer restrictions. Invalid stored data
fails closed and is preserved. The settings page retains an unsaved draft on
conflict; explicit reload replaces it with the saved version. Storage is restricted
to trusted extension contexts before settings access. Site policy is checked
before account resolution, exclusions win, and a denied/missing default never
falls back to a different account. This is the selection boundary for a future
executor, not evidence of automatic filling or current-session switching.

Policy/storage unit tests and isolated browser tests cover these boundaries,
including browser restart, stale settings pages and content-script denial.
The settings UI uses the approved React, Tailwind/Base UI and TanStack Form/Query
composition. The draft is independent of the metadata query cache; automatic
refetch/retry is disabled. Browser component tests cover error recovery and
keyboard behavior, while extension tests retain the worker/storage boundary
checks and add automated accessibility inspection.
The first executor slice adds strict bounded recipe, account-binding and operation
contracts, an XState lifecycle, and fixed DOM operations behind the separate
localhost-only probe build. It uses explicit saved account defaults and bundled
synthetic values. A metadata journal precedes every fill and click; input-triggered
advance/submission declares its effect and event explicitly. Recovery observes
the current document and never blindly replays an uncertain mutation or pending
submit. Same-origin attempts
remain locked to one owner tab until that tab closes, including terminal results.

The shared synthetic site verifies field values, click counts and server-observed
POST counts independently of the executor. Interruption fixtures distinguish
intent persistence, delivery, effect and acknowledgement; a missing acknowledgement
never authorizes another fill or a fallback click.
[Development](development.md#installed-chrome-synthetic-login-probe)
describes the early installed-Chrome acceptance procedure. Production activation,
arbitrary saved recipe configuration, real provider compatibility and broader frame
and dynamic-page support remain outstanding. The early installed-Chrome run passed
multi-page, background-tab, single-page, rejection, ambiguity, concurrency and
input/change-triggered advance cases using synthetic values. It does not establish
current SDK/setup compatibility or official Bitwarden extension coexistence. See the
[dated acceptance evidence](research/2026-10-10-feasibility.md#early-installed-chrome-acceptance-2026-10-10).
Neither M1 nor M2 is complete.

## Bitwarden transport progress

The first M3 slice isolates provider endpoints and transport in
`packages/bitwarden`. It covers official US/EU environments and standard HTTPS
self-hosted service paths, with fixed prelogin and encrypted-sync operations.
Redirects, browser cookies, automatic retries and arbitrary caller-supplied
request destinations are excluded. Response size, cancellation and parsing
boundaries have synthetic tests; errors do not expose request or response bodies.

The connection setup below integrates this library with extension settings and the
local cache. The isolated authentication and account-mapping operations are described
below. Real-account MFA compatibility remains outstanding. Synthetic fetch tests do
not establish real-server compatibility or installed-Chrome permissions.

## Local cryptography progress

The next M3 slice uses the pinned official OSS SDK under its GPLv3 option, as
approved in [ADR 0005](adr/0005-bitwarden-local-crypto.md). It introduces isolated
local sessions, bounded PBKDF2/Argon2id admission, V1/V2 account initialization,
strict cipher and stored-passkey decryption, and verified security-version
checks. The account mapper below prepares encrypted sync responses for these
sessions. Extension connection setup and the persistent cache layer have separate
progress sections below.

The pinned SDK's V2 version export also rewraps and re-signs an in-memory copy of
verified key state. Pateat keeps only its version and does not send or persist
the export. This adds transient sensitive copies and computation. Invalid blobs
never fall back to legacy fields; supplied URI checksums are verified even for
legacy keyless items, while absent legacy checksums remain supported.

Synchronous SDK parsing checks signed COSE and serialized keys before asynchronous
bindings that can otherwise leave malformed-input calls unresolved. The signed
COSE check admits structure only; account initialization must still verify the
actual signature. Key admission can temporarily unwrap/rewrap key material; those
results are discarded and mutable key buffers cleared. This is additional local
work, not a claim of zero-copy secrets or cancellation of synchronous WASM.

Disposal invalidates results immediately but defers native object cleanup until
pending operations settle. Hard cancellation requires termination of the owning
Worker. A separate synthetic extension page exercises packaged native WASM,
real vectors and Worker termination. The reusable background host is described
below; neither probe activates production login. See the
[source/distribution requirements](sdk-source.md) before conveying its binary.

An earlier synthetic executor artifact was manually installed in the owner's
Chrome on 2026-10-10. Chrome-use observations verified single/multi-page login,
input-triggered submission, uncertain-outcome stopping and competing-tab refusal.
Page-recorded visibility showed a successful inactive-tab run. This evidence
does not cover the SDK slice, real vaults, actual-profile restart or coexistence
with the official Bitwarden extension; M1-M3 remain incomplete.

## Authentication progress

The isolated authentication slice adds local authorization-hash derivation and fixed
password/refresh-token requests. It uses the SDK for the original KDF and native
WebCrypto for the protocol's one-iteration hash, with independent upstream
answers and a synthetic MV3 probe. Authentication prelogin parameters remain
separate from vault-unlock parameters. The pinned SDK's transitional missing/null
prelogin-salt fallback uses normalized email; present-empty salt and unknown KDFs
are rejected, and no alternate endpoint is tried automatically.

The transport supports explicit manual authenticator/email codes and new-device
OTP submission as request shapes. Challenge, rejection and interactive/unsupported
results are distinguished without returning raw server messages or challenge
URLs. No method is claimed compatible with a real account from synthetic HTTP
tests. Settings integration, code-delivery initiation, interactive providers,
token persistence and authoritative account/cache reconciliation remain separate
gates; an authenticated transport result does not mean an unlocked vault.
The transport uses the explicit read-protocol profile described in the
[architecture](architecture.md#vault-adapter). Header acceptance alone does not
prove real-account compatibility or complete sync coverage.

## Account mapping progress

The isolated mapper maps received account/sync data into the local crypto boundary
and defines an explicit read-protocol profile. It correlates provider and
subject continuity, distinguishes authentication from unlock parameters, rejects
incomplete current-format state and carries known account/security-version
floors. Unsigned token-claim decoding is consistency checking, not independent
authentication or ownership proof.

The initial mapper targets ordinary login, secure-note, card and identity items.
Other item types receive explicit unimplemented outcomes without blocking
unrelated supported items. Do not expand rare-type support solely to satisfy a
compatibility label. All received IDs still require validation and uniqueness;
malformed supported/account data cannot fall back to older formats or secrets.
Coverage remains the received envelope, not a complete-vault or atomic-cache
claim. Real-account setup, persistent unlock and cache reconciliation remain
separate integration gates.

Synthetic raw token/sync responses exercise real SDK password unlock and
decryption for personal and organization items and V2 sealed blobs. The V2
password wrapper is explicitly SDK-generated compatibility data; its signed
account state and blob/plaintext anchors come from recorded upstream fixtures.
This is not an independent password-wrapping known answer or real-account proof.
The packaged browser probe includes both V1 and V2 mapping/password-unlock paths.

## Local field and TOTP progress

The isolated field resolver covers ordinary login, secure-note, card and identity
values plus Text, Hidden, Boolean and Linked custom fields. It exposes value-free
metadata and scoped references, preserves duplicate names and leading zeros, and
requires an explicit allowlist for both a linked alias and its source fields. The
settings catalog lists each field's display label, its raw custom-field name (`null`
for built-in fields, unnamed fields and names over 200 characters), its kind and, for a
Linked field, the built-in field it reads; each connection also names its provider
account ID. These are what synced, name-based bindings need
([ADR 0013](adr/0013-service-held-recipes-and-settings.md)).
Disposing a snapshot prevents later resolution. The host must still enforce
destination policy and invalidate stale operations.

OTPAuth supplies local standard TOTP and Steam generation. Supported inputs are
canonical Base32 and explicit TOTP URI parameters; unsupported algorithms and
HOTP are explicit errors. OTP seeds are not field values or inference inputs.
Independent RFC 6238 and pinned upstream answers, clock boundaries and the
packaged MV3 probe are the verification gates for this slice.

Connection setup, cache adoption and custom-field exclusion rebinding are now
integrated, as described below. The remaining M3 integration gaps are listed after
the connection setup section.

## URI candidate matching progress

The isolated provider matcher uses the approved tldts dependency for public and
private suffix handling after WHATWG URL normalization. It implements ordinary
Domain/Host/Exact/StartsWith/Never modes and direct equivalent-domain groups;
Regex remains explicitly unsupported. Output contains candidate indices, modes,
a descriptive target origin and per-URI unavailable reasons, without raw URLs.
The trusted host must supply URIs and effective settings from the same selected
account/snapshot.

Raw prefix/equality behavior follows the pinned provider. Matching is not a fill
grant or a change to the automatic candidate-scope contract. The current executor
still has its existing account/origin/document checks, and live settings/catalog
integration must derive authorization separately. Synthetic tests cover private
suffix isolation, IDN, localhost/IP, equivalent groups and malformed destinations;
the MV3 probe passes a real SDK-decrypted, checksum-validated URI to this matcher.

Prepared accounts now retain a URI context from the same sync: normalized direct
equivalent-domain groups and the effective default mode. The default is Domain unless
an enforced organization URI-match-defaults policy applies, using the pinned SDK's
exemptions for owners, admins and provider users. Pateat cannot see the official
clients' local default setting. Differing enforced defaults, or malformed policy or
domain data, mark that part unavailable; affected URIs report unavailable rather than
falling back. Caches accepted before this change keep working for fields but report
URI matching unavailable until the next accepted sync.

The owner asked for official-client URI rules. The remaining differences (Regex, no
Domain fallback on unavailable context, no access to the local default setting) are
recorded in the [architecture](architecture.md) for later reconsideration.

The crypto Worker captures login URI rules while verifying every received item,
skipping deleted and archived items, and answers fixed snapshot-bound match requests
with item IDs and URI indices only. A settings bridge queries enabled connections
whose snapshot is ready or under review, after site exclusions, and keeps only
eligible, non-quarantined items. Unavailable connections and eligible items with
unevaluated rules are reported, never treated as no match. Pateat only receives
confirmed organization memberships, so a policy from an accepted-only membership is
treated as enforced; this can only enforce or mark a default unavailable. Native browser
tests verify an actual SDK-decrypted URI with the retained context across a full
profile restart, and the unavailable result for a cache without context.

## Background cryptographic host progress

The offscreen host slice connects trusted background operations to packaged
Dedicated Workers running the approved SDK. Its private runtime Port is bound
to the browser-reported offscreen document context. Fixed operations support
authorization hashing before a user ID is known, scoped account sessions and
local field access; they do not expose SDK dispatch to pages.

The verification graph includes actual MV3 sender/context checks, real SDK vectors
through the host, connection isolation, lock and hard cancellation, bounded
deadlines, and fresh recovery after service-worker or offscreen-document loss.
A new background incarnation must replace old hosts and reject
old handles without replaying requests. Production artifacts now package the
host and WASM. The connection setup slice below now calls the same host.

[PR #18](https://github.com/risu729/pateat/pull/18) passed the complete Linux
verification graph with 46 host tests and 42 extension tests. Its actual browser
tests verify native Worker creation/destruction, hard cancellation, fresh
offscreen recreation and service-worker restart. This is synthetic runtime
evidence; it does not establish real-provider or installed-Chrome compatibility.

The persistent-unlock layer below adds encrypted-cache acceptance; that behavior
is not proven by the host's in-memory restart fencing. Connection setup and
settings/catalog integration are described below; real-provider compatibility
remains unverified.
Conveying a new artifact still requires its matching
[Corresponding Source](sdk-source.md).

## Persistent unlock and cache progress

The cache slice implements
[atomic local cache records](adr/0006-atomic-local-vault-cache.md), verified SDK
unlock-key retention, offline restoration and durable local disable. It has no provider
HTTP or production setup UI.
[PR #19](https://github.com/risu729/pateat/pull/19) passed full Linux CI with 71 vault
tests and 58 extension tests. The 16 added browser cases passed real IndexedDB revision
conflicts and aborts, disable versus stale acceptance, full browser restart with the
same isolated profile for V1/V2/organization accounts, fresh SDK verification, preserved
snapshot identity, and unavailable-item replacement without older secrets. Independent
review verified restore/disable ordering and cleanup joining. This is synthetic native
browser evidence, not an installed-profile or real-account compatibility claim.

## Connection setup and live catalog progress

The connection setup slice connects manual options setup to the existing authentication,
mapping and durable-cache components. It adds configured-provider host permissions,
bounded manual challenges and a value-free catalog for local settings. Production site
execution remains a separate integration gate. Provider authentication was transient
in this slice; [durable provider sessions](#provider-session-progress) followed.

Catalog replacement preserves custom-field denies: exact unchanged encrypted field
sequences can rebind snapshot-scoped references, while changed or ambiguous sequences
with custom-policy history block the affected item's secret release until reviewed.
Protected snapshot bindings survive even a review choosing no exclusions. Generic saves
cannot clear unresolved exclusions or that binding history. Separate cache/settings
stores detect mismatched state after interruption; they do not provide one atomic
combined commit. Catalog bounds are validated before unlock-key export and cache commit.

[PR #20](https://github.com/risu729/pateat/pull/20) passed
[full Linux CI](https://github.com/risu729/pateat/actions/runs/38047201686) with 766
package, 72 connection, 73 vault, 47 host, 42 contract, 21 options and 69 extension
tests, and [CodeQL](https://github.com/risu729/pateat/actions/runs/38047201688). The 11
added native setup cases cover restoration after a full browser close, manual MFA and
new-device verification, two connections, preservation of the existing cache after
rejected re-authentication or oversized metadata, and custom-field rebinding and review.
Independent review approved the change. The fixed browser probe substitutes provider
responses and host permission decisions; it does not establish real optional-permission
prompt behavior or real-account authentication. Production starts with an empty catalog
until connections are configured. The demo catalog remains confined to the synthetic
probe. No build containing the SDK or this setup has been installed in the owner's
Chrome yet.

### Remaining M3 integration gaps

- The executor chooses the account for each admitted document. A saved site default
  wins. Without one, it asks every enabled connection for provider URI candidates for
  the document's own URL and uses the item only when exactly one eligible item matches
  (ADR 0013). Several matches refuse as `account-ambiguous`, none as `default-not-set`;
  an unevaluated item (including Regex rules) as `item-uri-unevaluated`; and a
  connection that cannot answer, or a locked vault, as `vault-unavailable`. Each
  document asks once and reuses the answer while every connection's snapshot is
  unchanged, so a new match from a later sync stops the attempt; every policy check
  still compares the choice with the attempt's account. It is saved (`siteDefaults`
  plus `settings.bindings`) only after the outcome is `authenticated`, only for the
  account the attempt used, only when the settings revision is still the one the
  attempt was authorized under, and only for what is missing; nothing is saved on
  `credential-rejected` or an unknown outcome. Saving bumps the settings revision every
  attempt checks, so it is skipped while another login is still running; the next login
  chooses again.
- A site default saved from now on names the provider account and item
  (`{ origin, provider, userId, itemId }`, ADR 0013); the executor and the settings page
  find this device's connection through the catalog connection's `userId`, and an
  account that is not connected here refuses as `connection-missing`, one connected
  twice as `account-ambiguous`, and one whose vault is locked or unavailable as
  `vault-unavailable`; the settings page refuses to save a default it could not use. A
  default saved earlier with a `connectionId` is still read and used as before and is
  never rewritten.
- A saved default's own item is matched the same way. A match satisfies the item origin
  check for that document only, and is reused while the connection's snapshot is
  unchanged; it never saves `allowedOrigins` or grants a field. Each new document is
  matched again, so an Exact rule refuses a later page at another path. No match refuses
  as `item-origin-mismatch`. Page URLs over 8192 characters and answers from another
  snapshot refuse as `vault-unavailable`. Static `allowedOrigins` remain empty for live
  items; Domain-mode subdomains and raw StartsWith rules cannot be expressed as exact
  origins, so do not derive them. Synthetic unit tests cover these paths; a native
  browser run waits for cached recipes.
- The declarative executor reads account metadata from the live settings catalog on
  every policy check and resolves each bound field through the connection runtime
  immediately before a fill. An unavailable connection or an item awaiting field review
  is refused before an attempt starts. A denied, locked or failed field read, or a
  replacement snapshot before delivery, blocks the attempt as `policy-changed` without
  filling. Production admits top-level HTTPS documents on a non-excluded site with
  granted host access, with or without a saved default
  ([ADR 0009](adr/0009-install-time-https-site-access.md)); without a cached recipe they
  stop with `recipe-not-found` before the policy catalog or vault is opened. Only the
  probe build grants its loopback origin to the probe item and supplies recipes and
  bindings. Recipes and account bindings come from the service cache
  ([ADR 0013](adr/0013-service-held-recipes-and-settings.md)). The executor looks up the
  chosen item's binding in `settings.bindings` by recipe, provider, provider account ID
  (the catalog connection's `userId`) and item, falls back to the built-in-slot binding
  (`defaultLoginBinding`), and maps it to this device's field IDs with
  `resolveBindingFields` over the catalog's raw field names. A recipe with another slot
  and no saved binding refuses as `binding-not-found`; a connection without a `userId`
  refuses as `vault-unavailable`. Production reads recipes from the synced recipe cache
  described under [service sync progress](#service-sync-progress), and bindings from the
  synced settings described there. An extension or service build that predates
  `bindings` rejects settings that contain them. Provider-derived origins remain open.
- A fill step refuses as `structural-mismatch` before writing anything unless all of its
  inputs share one `<form>` (or all sit outside any form), and each secret value lands
  in an input made for it. A Bitwarden `login.password` (or the probe's dummy
  `password`) fills only `type="password"` inputs or inputs whose `autocomplete`
  includes `current-password`. A `login.totp-code` fills `autocomplete="one-time-code"`
  inputs, or `inputmode="numeric"`, `type="tel"` or `type="number"` inputs with a
  `maxlength` from 1 to 10. A Hidden custom field fills the password inputs above or
  those short numeric inputs (a PIN), never a plain `type="text"` input such as a
  passphrase field. A Linked custom field follows the rule of the built-in field it
  reads, so one linked to `login.password` fills only password inputs. The owner chose
  this rule on 2026-10-10. Each write rechecks the same conditions. Usernames, Text
  custom fields and other values fill any writable input. There is no per-binding
  exception, so a bank PIN rendered as `<input type="tel">` and
  bound to `login.password` is refused; revisit if such sites are common.
- Real Bitwarden connections, individual MFA methods, the install-time site-access
  warning and the setup prompt after withheld site access in installed Chrome remain
  separate gates.

## Provider session progress

Implemented as [ADR 0008](adr/0008-durable-provider-sessions.md) describes. The native
IndexedDB database is upgraded in place from version 1 to 2 and gains a
`providerSessions` store; vault records still never contain tokens. A token-free refresh
claim commits by compare-and-swap before HTTP, a restart or unknown outcome requires
password sign-in instead of replaying it, rotation commits before sync, and an absent
refresh token keeps the captured one. Local forget, permission loss for that provider,
a rejected refresh or access token, and a mismatched account context clear only the
sync session. Startup only reads state; the settings page shows sync sign-in and
automatic unlock separately and labels forget as local.

Unit tests cover claims, rotation, concurrent writers, forget and permission races,
expiry from the token's own claims, and per-provider permission loss. Isolated Chromium
tests cover the blocked and released version 1 upgrade, the native session store's
guards and readback, two password-free syncs after a full profile reopen, and local
forget and permission removal with offline unlock kept. These use synthetic providers.
An
[installed-Chrome check](research/2026-10-10-feasibility.md#installed-chrome-provider-session-check-2026-10-10)
confirmed a password-free Sync after a full browser restart with the synthetic probe.
Refresh against a real account and real host-access revocation remain unverified.

## Service sync progress

The first M4 slice turns the health-only Worker into a device-authenticated
settings/recipe sync API with Hono, Drizzle and a D1 schema. Shared Valibot contracts
cover synced settings, immutable recipe revisions with tombstones, cursor pages and
conflict responses. Every query is scoped by the owner resolved from a hashed,
revocable device credential; request paths and bodies never select an owner. Settings
writes and recipe heads use conditional revision writes, and a recipe's history row
is recorded in the same D1 batch only when that request won the head.

Local Miniflare tests cover unknown, malformed and revoked credentials, owner and
device isolation, stale and concurrent writes, tombstones, cursor paging, strict
schema rejection, media type and body limits, and fail-closed handling of corrupt
stored documents. Concurrent cases interleave within one local runtime, not hosted
D1. A migration check regenerates SQL from the Drizzle schema. The D1 database is
not provisioned, and nothing is deployed.

The second slice adds the service side of
[device enrollment](architecture.md#device-enrollment). The Worker verifies Cloudflare
Access tokens itself (RS256 signature against the team keys, issuer, audience, expiry
and a user subject) and maps the issuer and subject to an owner. An Access-protected
page records the owner's approval of a device's SHA-256 challenge with the code they
typed, an anonymous rate-limited route exchanges the verifier for a device credential
once and only if that code matches the one derived from the verifier, and the owner can
list and revoke devices; a device can revoke itself. Local tests use synthetic signing
keys and cover forged, expired, wrong-audience and service tokens, missing
configuration, CSRF, code mismatch and retyping, approval by an account that only saw
the link, replay, concurrent redemption, expiry, cleanup, rate limits and cross-owner
revocation.

The extension side of pairing is the third slice. The settings page has an optional sync
service panel: it accepts only an exact HTTPS origin, asks the background to start
pairing, and shows the short code with a button that opens the approval page in an
ordinary tab. The background keeps the verifier and, after redemption, the device
credential in trusted extension storage; neither crosses the runtime message boundary.
Pairing asks Chrome for site access to the service host when the user has withheld it,
and a pending pairing offers to ask again instead of being cancelled. The page polls
redemption every ten seconds only while it stays open and a pairing is pending; the
background allows at most one redemption every six seconds and waits a minute after a
rate limit. A pairing is abandoned on the first request after 15 minutes, and an issued
credential whose write failed is kept in memory and saved on the next request. An
unreadable stored connection fails closed until the owner forgets it. Disconnecting
revokes the device with its own credential and forgets it locally even when the service
cannot confirm, in which case the page points to the management page. Requests refuse
redirects, send no cookies and bound response bodies. Unit tests use synthetic responses
and in-memory storage; component tests cover address validation, polling, code mismatch,
expiry, cancellation, site access requests, forgetting an unreadable connection and an
unconfirmed disconnect. Pairing has not been tried against a running service.

The fourth slice syncs recipes into a last-known-good cache that the login executor
reads. The background pulls `GET /v1/recipes` pages from the stored cursor with the
paired device's credential, applies active and revoked changes, and writes the cursor
and recipes together, so a failed page or write leaves the previous consistent copy. It
reads at most 50 pages per sync and refuses a page that moves the cursor backwards or
does not advance it. The cache belongs to one paired device: a new pairing starts from
an empty cache, nothing is served while no device is paired or the pairing cannot be
read, and disconnecting or forgetting an unreadable pairing clears it. Sync runs right
after pairing completes, also when another device's sync is still running, and in the
background when the worker starts, a lookup arrives or the settings page is open and the
last attempt is more than five minutes old. The attempt time is stored, so a worker
restart does not sync again sooner, and a 429 postpones background syncs, but not the
one after pairing, for 15 minutes. A lookup does not wait for the network or for pairing
and disconnect requests. The serialized cache is limited to 2 MiB of the extension's 10
MB `storage.local` quota, which it shares with the vault cache, settings and login
attempts; a page that would exceed it is not applied, and the settings page says the
recipes no longer fit. A 401 marks the device as rejected: syncing stops, login keeps
using the cached recipes, and the settings page says to pair again. Lookup uses
`selectLoginRecipe` for a new attempt and the recipe ID for a resumed one; two recipes
starting on one page find no recipe. Unit tests use synthetic pages and in-memory
storage; no running service has been tried.

The fifth slice syncs the device-independent settings in the same run, after recipes:
site exclusions, site defaults that name a provider account and item, and account
bindings. Vault connections, item selection, field exclusions and legacy site defaults
that name a device-local connection ID stay on the device; the service document always
has an empty `connections` list. The background reads `GET /v1/settings` and merges
three copies per entry (exclusions by hostname, defaults by origin, bindings by recipe,
origin and account): the last agreed base, stored under `pateat.sync-settings.v1`, the
local settings and the service's. A side that changed an entry since that base wins, and
the service wins when both changed it; removing an entry counts as a change. The base
keeps the service's copy and the local copy it accounts for. Both are the same after a
complete sync; after an upload whose local write has not happened yet, the local copy is
still the one the merge started from, so a merged entry the device has not written yet
is not read as a local removal, and a local edit made meanwhile still wins. The base is
used only when the service revision is newer than the stored one, or equal with the same
content. Without a base (a new pairing, a device paired before this sync existed, or a
service whose revision went back below the stored one or matches it with other content)
both sides' entries are kept, the service wins where they differ, and nothing is
removed. A service restored to an older state whose revision has since passed the stored
one is merged against the stored base, so its removals apply. Writing the base is best
effort; when that write fails, the next sync uses the older base, which can drop a later
local edit to an entry that the sync with the lost base changed. Disconnecting forgets
the base but keeps local settings, so pairing with another owner's service uploads this
device's synced settings there. The merge is written back with a conditional
`PUT /v1/settings`, and a stale service or local revision merges again, in up to three
attempts per sync. A merge over the settings limits (1,000 entries per list, or an
uploaded document over 120 KiB of the service's 128 KiB body limit) is not applied, and
the settings page says the settings no longer fit; when a later attempt in the same sync
goes over, an earlier upload stays. Local settings change through the settings store's
revision check, only when the merge differs from them, so an unchanged sync does not
stop running login attempts. While a login is running, including one between pages, the
upload still happens but the local write waits for a later sync, for at most two minutes
after the first wait. The time of the first wait is stored under
`pateat.sync-settings-hold.v1`, so the limit holds across service worker restarts, and
it is cleared when a sync finds no login running. A later sync starts when the recipe
schedule is due again. A local legacy default is replaced when the service names an
account for its origin. Saving settings on the extension's page or saving an automatic
account choice starts a sync at once. A recipe sync that cannot reach the service skips
settings, a 401 from either request marks the device rejected, and the settings page
shows a complete sync only when both finished. Unit tests use a synthetic service and
the real settings store over in-memory storage; no running service has been tried.

### Remaining M4 service gaps

- Device enrollment has not been tried against a real Access application; that probe
  needs the owner's approval, as do the credential idle-expiry decision and the
  optional `launchWebAuthFlow` variant.
- Settings that use device-local connection IDs, such as item selection and field
  exclusions, have no device-independent form yet and are not synced (ADR 0013).
- Inference adapters, spending accounting and the release artifact's migration SQL
  remain separate slices.
- Every table is owner-scoped, and any identity the Access policy admits becomes an
  owner on first approval. Before the service is offered to other people, it needs
  per-owner storage and request limits; today only `/redeem` is rate limited (per
  client address) and request bodies are size-capped.

## Passkey progress

[ADR 0007](adr/0007-existing-passkey-assertions.md) records the M5 bridge and
presence policy. The Bitwarden package maps one decrypted FIDO2 credential view
per item into secret-free metadata: ECDSA P-256 public-key credentials, GUID or
`b64.` credential IDs, canonical user handles, lowercase ASCII domain RP IDs
(no IP literals) and decimal counters. Items with several credentials are rejected
instead of choosing one; a nonzero counter is preserved so selection can refuse it.
The SDK-decrypted private key is decoded with a DER framing check only; WebCrypto
import validates its structure. Unit tests cover malformed and unsupported views and
an SDK round trip through the synthetic legacy account fixture.

The extension's assertion core admits only requests with mediation absent or `optional`
that pass WebAuthn RP ID validation with tldts private suffixes; everything else is a
delegation result. A `PasskeyPolicy` decides whether a missing gesture or a UV
requirement also delegates; the initial policy sets UP and UV unattended. It selects
exactly one eligible credential, refuses nonzero counters, serializes `clientDataJSON`,
builds authenticator data with UP, UV, BE and BS and a zero counter, and returns DER
ECDSA signatures from a non-extractable sign-only key. Unit tests reproduce the WebAuthn
Level 3 ES256 client data and authenticator data byte for byte, verify the published and
produced signatures, and cover the HTML registrable-suffix examples.

The probe build connects that core through a request bridge: a document-start MAIN-world
wrapper for `navigator.credentials.get`, an isolated relay that checks top-level
placement, secure context and the `publickey-credentials-get` policy and reports
transient user activation, and a background runtime bound to the browser-supplied sender
origin, frame 0 and document. Every unclaimed request, failure or deadline calls the
browser's original `get` with the caller's arguments. A synthetic source signs with the
public WebAuthn test-vector key for `http://localhost` only. Playwright tests against a
synthetic relying party verify Pateat assertions with Node's independent ECDSA verifier,
including UP and UV for page-load and UV-required requests, prove delegation to a CDP
virtual authenticator for nonzero-counter and unconfigured requests and, under a
ceremony policy, for unattended and UV-required requests, keep the browser's rejection
for unknown allow-list credentials and a denied permissions policy, and cover abort and
background timeout.

The crypto Worker can search the verified, live login items of the accepted snapshot for
stored passkeys whose RP ID equals the requested one, and sign with the passkey of one
such item. The host and vault manager expose these two operations with the same snapshot
binding, durable-revision checks and late-result withholding as URL matching. The search
decrypts credential metadata only for items whose encrypted `login.fido2Credentials` is
non-empty and returns only the secret-free metadata above. Items whose metadata cannot
be decrypted, and decrypted items with this RP ID that cannot be used (for example
several stored passkeys), are listed in `unavailableItemIds` instead of failing the
search; items whose passkeys all have other RP IDs are not. Signing re-derives the
item's single credential, requires the requested credential ID and RP ID to match it,
refuses a nonzero stored counter, and signs only 37-byte zero-counter assertion data
whose RP ID hash matches and whose flags carry UP, BE and BS with no attested data,
extension or reserved bits. The decoded key is imported non-extractable inside the
Worker and only a DER signature crosses the Port. A reply bound to another snapshot,
item or credential, or with any other shape, locks the session; an unreadable or
ambiguous item fails on its own without retiring the session. Unit tests sign through
the pinned SDK with the synthetic FIDO2 fixture and verify against its public key.
`apps/extension/src/passkeys/vault.ts` applies the
[ADR 0007 item selection](adr/0007-existing-passkey-assertions.md#item-selection) on top
of that search: enabled connections only, excluded sites, excluded and quarantined
items, the exact-origin site default as the tie-break, and no single-match choice while
a connection or eligible item could not be searched. Signing through it requires the
same settings revision, snapshot and item eligibility before and after the Worker signs.
Unit tests cover it with fake vault managers. Both builds register the bridge on every
top-level `https://*/*` document and answer it from this source; the probe build keeps
its test-vector key for `http://localhost` only. A probe-build Playwright test on
`https://synthetic.example.test`, served by request interception, connects the synthetic
Bitwarden account (fixture variant `passkey`, one login holding one zero-counter
passkey), gets an assertion signed in the crypto Worker and verified with the fixture's
public key, and gets the browser's own credential once the item is excluded. A
production-build test checks that the bridge is installed at document start there and,
with no vault connected, leaves the request to the browser. Real-site interoperability
and real-account use remain open; a navigation during signing relies on Chrome dropping
the response to the replaced document.
[Development](development.md#installed-chrome-synthetic-passkey-probe) describes the
installed-Chrome acceptance procedure. Page script can detect the wrapper (an own `get`
accessor property returning a function with a different `length` and source text), which
real-site testing must evaluate.

Evidence, 2026-10-10, synthetic relying party only:

- At main `2716b96`, the probe build passed steps 3 to 6 of that procedure in cloud
  Chromium 141.0.7390.37 with no other extension, loaded unpacked in a Playwright
  persistent context with `--headless=new`. Both buttons and the page-load request
  reported `Pateat, flags 0x1d, signature verified`; `/denied` reported
  `error NotAllowedError`.
- In the owner's Chrome 154.0.8037.98 with the official Bitwarden extension 2026.6.1,
  the request without a UV requirement reported a verified Pateat assertion, but the
  UV-required and page-load requests reported `error Error`. Bitwarden's page script
  had replaced `navigator.credentials.get` outside Pateat's wrapper. For the
  UV-required request it showed its "No passkeys found" window and, when that closed,
  rejected instead of falling back.
- The owner then chose to keep Pateat's wrapper outermost
  ([ADR 0007](adr/0007-existing-passkey-assertions.md#bridge-topology)). In cloud
  Chromium, a synthetic page script shaped like Bitwarden's (`/provider` on the
  synthetic relying party) reproduced `error Error` before that change; after it, both
  buttons returned Pateat assertions, also after the script restored its saved `get`,
  and an unclaimed request reached that script once. While the script held an unclaimed
  request, as Bitwarden's "Your vault is locked" window does, a new request still got a
  Pateat assertion and the held one ended with the script's own `Error`. A conditional
  request that the script passed on as a shallow copy reached it once, and a later
  modal request still got a Pateat assertion. Real-site testing must also check pages
  that wrap `get` themselves, which no longer see claimed requests.
- At main `5d0e1ac`, the probe build passed steps 3 to 6 in the owner's Chrome
  154.0.8037.98 on Windows 11 (Default profile) with the official Bitwarden extension
  2026.6.1. Both buttons and the page-load request reported `Pateat, flags 0x1d,
  signature verified`, with Bitwarden unlocked and again with it locked after a reload.
  No Bitwarden window appeared, and no request errored or stayed pending.

## AI evaluation harness progress

`packages/inference` holds the first offline M4 slice. A proposed sanitized observation
contract carries bounded, value-free element roles, locators and labels; incomplete
observations are rejected before inference. The generation/repair role uses AI SDK
structured output and the finite-choice role uses the SDK decision contract with an
explicit none option per question. Both resolve observation-local candidate IDs, check
slot/role compatibility, joint mapping uniqueness and same-form grouping, refuse secrets
in new-password fields, and apply the shared recipe step contract. They return explicit
ok, abstained or failed outcomes. Usage sums every attempt, including failed retries;
one attempt without reported usage makes the total unknown. Retries default to none and
are bounded; timeouts, caller cancellation and byte limits on the sent instructions,
input and output schema or questions are enforced locally (provider envelope overhead is
not counted). SDK telemetry is disabled per call so prompts, page text and outputs never
reach global integrations. The finite-choice state carries page context and the slots
(meanings plus any ADR 0010 hints); eligible elements appear solely as question options.

Per [ADR 0010](adr/0010-inference-field-hints.md), slots may name the allowed vault
field and give the coarse shape (length, character classes, email form) of a login
username or Text field value, and observations carry page `maxLength`, `minLength` and
`inputMode`. `checkPlanValues` checks a plan against the real values before filling and
turns a mismatch into a `value-mismatch` abstention; the harness applies it when a case
carries synthetic values. The vault adapter and runtime do not supply these hints yet.
`valueShapeOf` takes `{ source: "username" | "text", value }`, so the adapter must
resolve Linked fields and never pass Hidden, password or TOTP values.

A 16-page synthetic Japanese/English corpus covers bank branch/account/password
(including an unlabeled page distinguishable only by length),
identifier-first and password steps, one-time codes, decoy search/sign-up/SSO controls,
label injection, unlabeled ambiguity and a page without a login form. The harness
reports semantic accuracy, false submits, abstentions, joint-mapping rejections,
errors, p50/p95 latency and usage. Fake-provider tests cover malformed output,
nonexistent targets, malformed probabilities, refusal, truncation, timeout, rate limits,
oversized and incomplete inputs and the absence of fallback.

[ADR 0014](adr/0014-claude-generation-provider.md) selects `claude-opus-5-5` at effort
`low` through `@ai-sdk/anthropic` for the generation/repair role; the finite-choice role
has no provider yet. `createClaudeGenerationModel` in
`packages/inference/src/providers/claude.ts` builds that model, and
`mise run bench:inference --paid` runs the generation role over the corpus with the
local value check. It stops before a case that could take the estimated spend past
`--max-cost-usd` (default 2) and still prints the cases already run, the estimated cost
and the model IDs the API reported serving. In cloud sessions the key is provided as
the environment variable `PATEAT_ANTHROPIC_API_KEY`, because the name
`ANTHROPIC_API_KEY` is withheld from sessions; run
`ANTHROPIC_API_KEY="$PATEAT_ANTHROPIC_API_KEY" mise run bench:inference --paid`.

The one owner-approved run (2026-10-10, main `29ab04c`, cap $2) gave:

| Measure | Result |
| --- | --- |
| Served models | `claude-opus-5-5` only |
| Verdicts (16 cases) | 13 correct, 2 correct abstentions, 0 missed, 0 false submits, 1 failed |
| Semantic accuracy | 0.9375 (15/16) |
| Abstentions | `ambiguous` 1 (`ja-unlabeled-ambiguous`), `no-login-form` 1 (`en-newsletter-only`) |
| Errors | `refused` 1 (`ja-bank-unlabeled-lengths`) |
| Joint-mapping rejections | 0 |
| Latency | p50 2,285 ms, p95 6,727 ms (one call per case, no retries) |
| Usage | 21,182 input and 1,146 output tokens over 16 calls |
| Estimated cost | $0.108 at $4/$20 per million (about $0.0067 per call) |

The one failure is a model refusal: the API ended the call with a refusal
(`finishReason` `content-filter`) on the unlabeled Japanese bank page that has only
`maxLength` 7/3/4 numeric fields. As ADR 0014 requires, there is no fallback model, so
such a page gets no generated recipe. Measured usage per call is well below the ADR
0014 estimate of about 3,000 input and 1,000 output tokens. Remaining M4 AI work:

- The service route, monthly spend stop and the
  [request log](adr/0012-inference-request-log.md).
- The extension observation extractor with privacy fixtures. Expect Japanese pages to
  put labels in adjacent table cells, use image buttons labeled only by `alt`, and
  offer software keyboards.
- Supplying ADR 0010 hints from the vault adapter, and running `checkPlanValues` and
  the post-fill check before the click in the executor.
- A real-page corpus per ADR 0012, then moving the observation contract to
  `packages/contracts` when the service shares it.

Evaluation data candidates, checked 2026-10-10 (terms are as published by each
source; confirm before use):

| Source                                                                                                           | Contents                                                                         | Use                                                            |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [Formasaurus](https://github.com/scrapinghub/Formasaurus)                                                        | 954 real pages, 274 login forms labeled by field type; 4 Japanese pages          | Derived observations with attribution (code MIT; page HTML unclear) |
| [SSO-Monitor](https://sso-monitor.me)                                                                            | Login-page URLs and SSO elements for top sites                                   | Seed URLs for capture                                          |
| [Chromium form classification tests](https://source.chromium.org/chromium/chromium/src/+/main:components/test/data/password_manager/form_classification_tests/) | 96 sign-in and 112 sign-up site scripts from 2016 with password selectors | Seed URLs (BSD); sites may have changed                        |
| [WebUI](https://huggingface.co/datasets/biglab/webui-all)                                                        | About 400,000 pages with accessibility trees and screenshots; no login labels    | Private evaluation only (research terms)                       |
| [Phish360](https://web.cs.hacettepe.edu.tr/~selman/phish360-dataset/)                                            | 10,748 samples incl. legitimate login pages in 27 languages; no field labels     | Private evaluation only; request form                          |
| PILWD-134K                                                                                                       | Legitimate and phishing login pages, 2019-2020                                   | Private evaluation only; institutional request                 |

No public source has meaningful Japanese or bank branch/account coverage, so those
pages come from the request log and the owner's Chrome. Reusing per-site recipes from
[Bitwarden map-the-web](https://github.com/bitwarden/map-the-web) (GPL-3.0, 32 hosts),
[Apple password-manager-resources](https://github.com/apple/password-manager-resources)
(MIT, shared credential backends) or
[2fa.directory](https://github.com/2factorauth/twofactorauth) (MIT) is later scope.

## Initial delivery and later scope

The [architecture](architecture.md) owns the product contracts. These boundaries
order delivery; deferred capabilities remain product scope, without requiring
their implementation in M1-M6.

Initial delivery includes multiple vault connections, connection/item/field/site
policies, saved site account defaults, cached-recipe execution, Bitwarden
password/custom-field/TOTP use, and existing zero-counter software passkey
assertions. The first server configuration uses Cloudflare Access, server-readable
private settings sync and server-side AI. Per
[ADR 0013](adr/0013-service-held-recipes-and-settings.md), the service is the
source of truth for settings, recipes and account bindings, which are edited on its
web UI; the extension keeps a last-known-good cache and only the pages that handle
local secrets. Running without the service is later scope.

Later work includes independently permitted vault create/update operations,
nonzero passkey counter writeback and passkey creation; Bitwarden provider login
with passkeys, API keys, SSO or device approval; external email/SMS OTP and magic
links; and separately authorized post-login actions, including transactions and
approvals. UI extensions, account switching, a mode without the service, direct AI,
recipe sharing, additional service auth, E2EE settings sync and MCP are also
deferred. They are extension points, not
implicit permissions or initial acceptance requirements.

## Ordered milestones

| Milestone                                     | Deliverable                                                                                              | Acceptance evidence                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0: Documentation bootstrap                   | Empty main root, repository settings, this docs PR                                                       | Empty tree/root verified; rules read back; independent docs review. Owner merges separately                                                                                                                                    |
| M1: Tooling and runtime probes                | WXT skeleton, shared Valibot contracts, mise/hk, mandatory CI                                            | Frozen installation; full checks; packaged extension build; early injection/background execution in isolated Chromium and a small installed-Chrome/Chrome-use dummy-page coexistence probe; compatible cf/Workers test harness |
| M2: Local login engine and settings           | Dummy vault adapter, settings page, multi-connection policies, saved site defaults, declarative executor | Multi-field/multi-page fixtures; policy precedence, excluded-site pass-through, background, navigation, interruption and concurrency tests; no automatic extension UI                                                          |
| M3: Bitwarden passwords                       | First real adapter, local sync/crypto, persistent unlock, custom fields and TOTP                         | Synthetic protocol/crypto vectors; supported environment/authentication and TOTP cases below; restart/unlock; no vault writes; explicit unsupported cases; controlled account test only when authorized                        |
| M4: Private settings/recipe service and AI    | Worker+D1, Access enrollment, settings/recipe/binding sync and web UI, Claude generation adapter (ADR 0014) | Owner/device isolation, revocation, redaction, offline cache, revision conflicts, malformed AI output, bounded complete inputs, explicit abstention, retry and monthly spend-stop tests; benchmark report |
| M5: Existing software passkeys                | Request bridge and Bitwarden-backed zero-counter assertion capability                                    | Standards/wire vectors, RP ID and cancellation tests, configured UV/UP policy, controlled interoperability; reject nonzero counters; no registration                                                                             |
| M6: Integrated acceptance and server delivery | Chrome use coexistence, operational docs, hosted service release                                         | Installed Chrome dummy-account tests plus artifact-verified deployment and hosted synthetic smoke checks; measured limits documented                                                                                           |

M1's small cf compatibility probe may precede a backend skeleton; it must not
provision resources. M2 starts with a dummy adapter so login correctness does not
depend on account secrets. Bring the WebAuthn document-start probe forward into
M1; defer full signing to M5. Each milestone can be several focused PRs.

### Library decisions before implementation

[ADR 0004](adr/0004-library-composition.md) and the
[candidate comparison](development.md#dependency-policy) distinguish approved
choices from pending recommendations. Ask the owner to decide each major addition
or replacement after presenting its purpose, alternatives and tradeoffs. Do not
infer adoption approval from a research or plan-update request.

Approved M2 slice: migrate the settings page to React, Tailwind + Base UI with
selected shadcn/ui components, and TanStack Form + Valibot. Pin compatible versions
with WXT/Vite, verify MV3 CSP and emitted bundles, and retain draft preservation,
revision conflicts, validation and keyboard/focus behavior. Keep UI dependencies
out of the background worker and content scripts. Add the approved Vitest Browser
Mode with `vitest-browser-react`, `@axe-core/playwright` and Knip to the existing
test stack. Keep real-extension Playwright tests and manual keyboard/focus checks;
configure WXT entrypoints before acting on Knip findings. Use the approved fast-check
for policy invariants, state transitions and controlled async-ordering tests.

Also approved for M2: TanStack Query for metadata loading/mutations and
`@webext-core/messaging` for extension communication. Keep dirty form drafts
separate from refreshed data, configure retry/refetch behavior explicitly and
retain runtime payload/sender authorization. Use the approved XState for the M2
executor; verify navigation cancellation, timeout handling and interrupted-submit
reconciliation before expanding execution. Persist allowlisted resumable metadata
only; restoring state must not blindly replay submission. Integrate approved WXT
storage helpers with trusted-access initialization before migrations, existing
single-writer revision checks and fail-closed handling of corrupt settings.

Approved for M4: Hono and Drizzle for the first substantive API/schema. Keep
Valibot boundary validation, verify generated SQL and migrations, and test owner
isolation, conditional revision writes and D1 batch behavior. Neither dependency
automatically supplies those application guarantees.

Selected for M3/M5 under delegated maintenance review: OTPAuth for standard TOTP
and URI handling, and tldts for public/private suffix information after WHATWG URL
normalization. Verify Bitwarden parameters/Steam format and destination/RP policy
separately; neither library approval expands the supported protocol scope.
Approved for M4: AI SDK with Valibot for supported generation APIs. Preserve
role-specific decision adapters, explicit retry/timeout limits, redacted diagnostics
and usage accounting. This selects transport tooling, not an inference provider.

Potential integration points, subject to those decisions, are M2 settings UI,
forms, async state, attempt lifecycle and verification; M3/M5 protocol libraries;
and M4 service/database and inference transport. Once a choice is approved, record
it and add the concrete integration slice with compatibility and regression gates.
Until then, continue independent work without installing the candidate or making
the current plan depend on it.

M3 initially targets Bitwarden Cloud US/EU and official self-hosted servers at
ordinary HTTPS URLs. Use email/master-password authentication, with human-entered
two-step/new-device verification in settings. Probe individual MFA methods before
claiming compatibility. This provider setup is separate from website OTP
automation. Preserve supported Bitwarden TOTP forms, including raw Base32,
`otpauth://totp/` parameters and Steam form; verify algorithms, digits, periods
and clock boundaries. Do not imply HOTP support from URI parsing alone.

## Mandatory acceptance matrix

| Area                  | Minimum cases                                                                                                                                                                                                                                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab/document identity | Inactive live tab, active-tab switch during inference, two tabs, nested/cross-origin permitted frames, navigation invalidating a late response, frozen/discarded tab classification                                                                                                                                                                            |
| Login execution       | Branch/account/password, username then password/passkey, dynamic React inputs, delayed render, explicit field mappings before AI, ambiguity without guessing, credential rejection versus layout mismatch versus unknown outcome, no duplicated click after restart                                                                                            |
| MV3 and coexistence   | Worker suspension/restart, browser restart, no page extension iframe, official BW coexistence, actual Chrome use attach and concurrent input                                                                                                                                                                                                                   |
| Secret boundary       | Malicious page messages, origin mismatch, redirects, unauthorized frames, storage access level, redacted observations/logs, no secrets in server/provider payloads                                                                                                                                                                                             |
| Vault and settings    | PBKDF2 and Argon2id, authenticated ciphertext corruption, encoding, multiple connections, deny precedence and field exclusion, organization/custom fields capability, duplicate/linked fields and leading zeros, supported TOTP forms, sync expiry, persistent unlock and revocation                                                                           |
| Passkeys              | Existing zero-counter software key, nonzero-counter rejection, secure context, RP ID/public suffix, challenge, ancestor/topOrigin/crossOrigin, denied iframe Permissions Policy, allowCredentials/userHandle, signature encoding, configured UV/UP, abort/timeout, competing provider/conditional mediation                                                      |
| Service/AI            | Service auth separate from vault unlock, device ownership, replay/revocation, schema compatibility, settings revision conflicts, offline cache, separate generation/repair and finite-choice settings, injection text, nonexistent targets, refusal/truncation/timeout/rate-limit, no automatic provider/model fallback, monthly spend stop and attempt limits |

Fixtures use synthetic sites and credentials. A bundled Chromium pass is not
proof for installed Chrome or Chrome use. A single successful login is not
support for every site or vault format. Keep observed limitations explicit.

## Decisions still requiring evidence

- Pick and pin the compatible WXT/Vite/Node/Bun/Vitest/cf combination during M1.
  Valibot and WXT are fixed choices, not open framework comparisons.
- Establish the Chrome use ownership/wait mechanism before integrated automation
  claims. If no integration hook exists, document the tested wait protocol and
  remaining races rather than inventing support.
- Verify the owner-approved official OSS SDK for local Bitwarden cryptography,
  including Argon2id, legacy/current formats, strict failure handling, GPL
  distribution, memory/time and browser lifecycle. See
  [ADR 0005](adr/0005-bitwarden-local-crypto.md); do not implement cryptographic
  primitives ourselves or treat library adoption as compatibility proof.
- [ADR 0007](adr/0007-existing-passkey-assertions.md) records the owner's choice
  to set UP and UV on every claimed assertion without a gesture. A per-site
  setting over the existing policy shape is later work. Nonzero-counter
  synchronization is deferred.
- Per [ADR 0013](adr/0013-service-held-recipes-and-settings.md), decide how to choose
  among several URI-matched items, how synced field exclusions
  move to device-independent references, and where custom-field review happens.
- Settle device enrollment/recovery, credential lifetime, AI pricing sources and
  the monthly monetary budget default before service deployment. Initial spending
  control aggregates usage and stops later inference after the limit is reached;
  in-flight/concurrent requests can overshoot. Atomic maximum-cost reservation is
  not required. The owner confirmed $200 of monthly Claude API credit; ADR 0014 sets
  the default limit to $150.
- Benchmark generation/repair and finite-choice roles separately on the same
  Japanese/English synthetic login corpus. Measure the ADR 0014 Claude configuration for
  generation; Clef-flash, Clef and Jev for decisions are optional later candidates.
  Report semantic correctness, false-submit count, abstentions, joint mapping
  consistency, p50/p95 end-to-end latency and usage/cost. Test invalid candidate IDs,
  malformed probabilities, context overflow and incomplete observations. Clef vendor
  latency/price claims are research inputs, not Pateat measurements. Present results to
  the owner; a model or effort change is an owner decision, and evaluating a candidate
  does not authorize adopting it. There is no latency promise. Use only the configured
  provider/model for each role; its failure is an error, not an automatic fallback.
  Cached recipes continue after an AI/budget failure.

Before implementing deferred features, add their concrete slice and evidence to
this plan: write capabilities need independent connection permissions and no
automatic permission upgrade; post-login actions need site/action authorization
separate from credential use; provider passkey login needs authentication versus
vault-unlock and PRF/RP/origin checks; external challenge adapters need explicit
channel permissions. None requires a blanket prompt on every operation once a
user has authorized its supported scope.

Future page UI must avoid extension iframes, preserve accessible keyboard/focus behavior
and recheck policy locally. The service's HTTPS management UI and MCP must share the
internal operation contracts. Before implementing MCP, verify that the target client can
autonomously invoke allowed dummy operations after connection approval; MCP does not
bypass client rules. One-time account overrides and automatic logout/re-login require
shared-session/race tests. Direct AI requires trusted extension key storage and provider
compatibility tests. Alternative service auth, E2EE sync and Vaultwarden require their
own interoperability/recovery evidence.

Extension publishing/CD, public recipe sharing and hosted browser installation
are outside the current delivery plan. Extension build and automated tests remain
in CI scope. Native helpers are not required by the product.
