# Proposed architecture

Status: accepted reference design. Sections with their own status line say what is
implemented; otherwise the capabilities below remain planned unless
[the plan](plan.md) records their implementation and evidence.

## Product boundary

A Chrome MV3 extension logs into the user's configured accounts, including
background tabs operated by another browser agent. Bitwarden is the first vault
adapter, not the product identity. Passwords, custom fields, TOTP, and existing
exportable software passkeys belong in scope. Another vault can be added behind
the same narrow capability boundary when there is a concrete second integration. For
the time being Pateat supports only Bitwarden, and no other vault is planned (owner
decision, 2026-10-11).

The client works without a native helper or desktop daemon. Settings, recipes and
account bindings live on the owner's self-hosted Pateat service and are edited on its
web UI ([ADR 0013](adr/0013-service-held-recipes-and-settings.md)). The extension keeps
a last-known-good cache, so login keeps working while the service is offline, and a
reinstalled extension restores the data by syncing. A mode without the service is
planned for [phase 3](plan.md#phase-3-public-release). Missing recipes produce an
explicit result rather than guessing. Bitwarden sync still needs its own service. The
same Worker provides the initial inference path. Direct extension-to-AI calls with
user-owned keys are a later option, not the recommended initial setup.

Configure accounts and site permissions once, then automatically fill and submit
login forms. Cover multi-page flows and separate branch/account/password fields,
including a username step before a passkey request. Login completion ends the
initial executor's responsibility. Credential saving/updating, email/SMS OTP,
magic links, session switching and separately authorized post-login operations,
including transactions and approvals, are later product capabilities. They are
not permanent exclusions and must not silently broaden the initial executor.
Unsupported challenges produce specific results rather than indefinite retries.
Prioritize ordinary login paths. Uncommon cases may remain explicitly
unimplemented; report the unsupported capability without misclassifying it as
bad credentials or attempting another method. An unsupported unrelated vault
item must not prevent use of otherwise valid, supported login items.

This targets locally installed Chrome. Running in a hosted browser depends on
that environment allowing installation and storage; it is not an initial
compatibility claim or an alternative cloud-browser implementation.

## Components and trust boundaries

| Component               | Responsibilities                                                                           | May hold secrets?                                               |
| ----------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| MV3 service worker      | Vault sync, crypto-host coordination, account selection, recipe cache and attempts       | Yes, extension-owned contexts only                              |
| Offscreen crypto host   | Own Dedicated Workers for local SDK operations and hard cancellation                     | Yes, private background channel only                            |
| Isolated content script | Extract sanitized form structure, validate document identity, execute fixed DOM operations | Only the specific values being filled, briefly                  |
| MAIN-world bridge       | Mediate WebAuthn requests and return results to the site                                   | No vault keys; assertions necessarily reach the requesting site |
| MAIN-world click relay  | Click a `javascript:` link the isolated script names, under the page's own policy          | No; it receives no values                                       |
| Settings page           | Vault connection, re-authentication, unlock and service pairing                            | Deliberate user setup only; no auto-opening during login        |
| Toolbar popup           | Current site's default account and exclusion; choosing among several matches (ADR 0021) | Item names and login usernames only; opened only by the user    |
| Passkey chooser window  | Choosing a passkey for one pending request: several match, or Pateat signed in the tab   | Item names and passkey user names only                           |
| Worker API + D1         | Settings, recipes and account bindings, owner web UI, device authorization, inference, request log | Service credentials only; no vault values or keys               |
| AI provider             | Match observed elements and propose declarative steps                                      | No vault values, account bindings, cookies, or assertions       |

Content/page messages are untrusted. Validate payloads with Valibot and bind
requests to the browser-supplied sender, permitted origin, tab, frame, document,
and short-lived operation ID. Page-provided origin strings never authorize a
secret lookup. MAIN-world bridging needs its own request matching and cancellation
protocol; TypeScript types and a message nonce alone are not authorization.

Extension pages and content scripts send their requests to the service worker through
`@webext-core/messaging`, under one key per area (settings, service, diagnostics,
passkey chooser, login, passkey); the request keeps its own `type`. The worker checks
the sender before the area's handler runs, and the handler still validates the request
with Valibot and checks a content script's tab, frame and document. A handler that
fails answers `undefined`, so no error the library would serialize reaches the sender.
The worker's sends to a tab stay raw `tabs.sendMessage` calls addressed by `frameId` and
`documentId`, which the library's tab send cannot address. The Ports to the settings
page and the offscreen crypto host, the offscreen document's Worker messages and the
`window.postMessage` channel between the passkey scripts also stay raw.

DOM-filled values can be read by the receiving page and potentially its debugger.
The local-only vault boundary does not promise invisibility to Chrome use or a
compromised destination page.

## Vault adapter

Distinguish a provider type from a connection and model multiple simultaneous
vault connections from the start. Scope item and field IDs by connection.
Adapters are developer-written and bundled with extension releases; no remotely
loaded executable plugins or speculative second provider implementation.

Bitwarden's master password re-prompt is not honoured. The adapter reads a cipher's
`reprompt` (`0` or `1`) but carries it no further: an item with `reprompt: 1` is filled
and its passkeys sign without the master password prompt the official clients show.
Bitwarden describes re-prompt as "an interface-only guardrail" and "not an encryption
mechanism"
([Master Password Re-prompt](https://bitwarden.com/help/master-password-re-prompt/),
checked 2026-10-14), so the vault data does not enforce it. A setting to honour it
is planned for [phase 3](plan.md#phase-3-public-release) (owner, 2026-10-13 21:57 UTC).

Expose authentication, unlock, sync, eligible references, field resolution, OTP
generation and signing capabilities. Reserve create/update capabilities for
later writing. Distinguish unsupported, supported-but-denied and available:
adapter support does not grant permission. Keep cipher formats and protocols
inside the adapter.

Initial Bitwarden connections target official US/EU cloud and ordinary HTTPS
self-hosted instances. Support email/master-password authentication and required
verification/MFA through settings; record tested methods instead of claiming all
methods work. Vaultwarden and special endpoint/certificate configurations are
later compatibility work.

The initial transport library fixes service paths for each selected environment. Reject
endpoint credentials, query/fragment components and unsupported custom service layouts.
Do not follow redirects or send browser cookies. Each provider operation owns its
method, path and request shape; no generic authenticated request function is exposed.
Bound response bytes while reading, support explicit cancellation and report sanitized
errors without request bodies or tokens. Manual connection setup requests the canonical
provider HTTPS hosts from the options page's user gesture. The install-time HTTPS site
access of [ADR 0009](adr/0009-install-time-https-site-access.md) normally already covers
them, so the request prompts only when the user has withheld site access. The background
rechecks actual permission before each provider operation and cancels affected
authentication flows when permission is removed. Chrome's host grant does not constrain
endpoint paths, so the fixed transport still enforces the configured origin, method and
service path. Extension CSP permits HTTPS connections while keeping script sources
packaged locally. See Chrome's
[optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions)
and
[network request policy](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests).

Prelogin, password/refresh-token requests and encrypted sync are isolated library
operations. Manual options setup composes them through a dedicated private Port
bound to the exact options-page sender. Passwords and manual codes never enter
the metadata query cache. Closing that Port cancels its flow and withholds late
results. Every setup failure crosses that Port as an error code only; provider
HTTP statuses and other failure details stay in the background. Only
value-free connection, group, item and field metadata returns to
the settings catalog; vault field resolution remains an internal background API. The
one exception is the default account picker: for the items that match the entered
origin, the background returns each item's login username so same-named items can be
told apart. It is not cached, persisted or synced.
Password requests accept explicit manual authenticator/email codes and new-device
OTP values. Return bounded challenge categories and provider IDs, never raw
challenge parameters, server descriptions or URLs. Code delivery and interactive
providers need separate integration. Keep successful token and encrypted-account
results local; they do not establish account ownership or unlock a vault by
themselves. Sync sessions persist apart from the vault record
([ADR 0008](adr/0008-durable-provider-sessions.md)). Preserve unknown encrypted
format metadata for later crypto validation; successful HTTP parsing does not prove
decryptability or authorize use of a newly fetched snapshot.
The server can filter sync data according to client version and device capability
headers. Record the protocol profile and validate completeness in the later
adapter before replacing a usable cache; an intact outer envelope alone is not
evidence that every vault item was returned.
Treat coverage as the received envelope only. The
[pinned server restricts partial-cipher support to Web clients](https://github.com/bitwarden/server/blob/9ee4e0ebf502fd1c8bf5c1bbcbc2942c3b66bbcc/src/Core/Vault/Authorization/PartialCipherSupport.cs),
so an honest Chrome device profile can omit restricted items. Missing records
cannot prove deletion. An explicitly unavailable item cannot authorize reuse of
its old cached secret; cache reconciliation still needs its own integration.
The isolated requests advertise the fixed read-protocol baseline
`Bitwarden-Client-Version: 2026.2.0` and truthful Chrome `Device-Type: 2`. This is
a protocol compatibility label, separate from Pateat's product version, and does
not claim support for every official-client capability or item type. The
[pinned server validator](https://github.com/bitwarden/server/blob/9ee4e0ebf502fd1c8bf5c1bbcbc2942c3b66bbcc/src/Identity/IdentityServer/RequestValidators/ClientVersionValidator.cs)
requires a version header for existing accounts. Report version rejection as
protocol incompatibility; do not retry with another version or device identity.

The pure account mapper prepares trusted transport responses for local crypto.
It correlates token subject, sync profile and a known account's canonical provider
binding. Decoding unsigned JWT claims does not verify their signature or establish
ownership; the calling host must preserve the fixed HTTPS response provenance.
Authentication salt/KDF and vault-unlock salt/KDF remain independent. Incomplete
modern account keys cannot fall back to legacy state. Previously verified account
format and signed security-version floors must survive subsequent syncs.

The initial mapper admits login, secure-note, card and identity items. Other
types have explicit unavailable results containing only IDs and an unsupported
reason. Validate uniqueness across both sets. No secrets from unavailable records
may be released. Mapping success is preparation only; native cryptographic
verification and later cache acceptance remain separate gates.

The isolated local-crypto library uses the owner-approved official OSS SDK, with no SDK
HTTP/token provider. It validates supported input shapes, rejects partial decryption and
binds each session to one connection. V2 account state requires both the signed public
key and the signed security state; the SDK verifies both signatures during
initialization before a security-version floor is checked. The SDK exports no accessor
for that version, so the library decodes the security state's COSE_Sign1 payload the SDK
has just verified with `cbor2` (`packages/bitwarden/src/security-state.ts`). The pinned
SDK's asynchronous `initialize_user_crypto` never settles its Promise when an argument
fails conversion (malformed COSE, invalid base64, a user ID that is not a UUID): the
error is thrown from a microtask as an uncaught exception. The library rejects invalid
base64 and the shapes its input schema checks, but no longer checks COSE structure
itself, so the library alone does not guarantee that initialization settles. In the
extension, the uncaught exception reaches the owning Worker's `error` event and the
offscreen host terminates that Worker and answers `crypto-failed`; a call that neither
settles nor errors ends at the host's 30-second `timeout`. The bug is in the SDK,
outside Pateat. Cipher views withhold the decrypted
cipher, attachment and passkey private keys; only the Worker's passkey signing step
reads a private key. Ordinary cipher decryption leaves separately encrypted passkeys
out, so an unreadable passkey makes only passkey use of that item unavailable. Disposal
withholds stale results; native cleanup waits for in-flight operations, while Worker
termination is the hard cancellation boundary. Local password-authorization hashing uses
the SDK's primary KDF followed by native WebCrypto's protocol-specific single-iteration
PBKDF2. Preserve the password exactly and normalize the authentication salt according to
the pinned SDK, independently of vault-unlock parameters. Provider settings, cache
reconciliation and persistent unlock still need their own integration and acceptance
tests.

The background host uses a packaged offscreen document with the `WORKERS`
reason to construct Dedicated Workers. A private runtime Port starts in that
document; the background validates its browser-supplied extension identity and
exact URL against the single live offscreen context from `runtime.getContexts`.
Each host uses a fresh URL query to reject connections from a previous host.
Chrome may omit the Port sender's document ID for this non-tab context; the live
context supplies the authoritative opaque document ID, and any sender document
ID that is present must match. Tab, frame and native-application senders are
rejected. Secret operations do not use broadcast messages.
The host exposes fixed authentication, session and field operations only to
trusted background code, with no generic page-facing SDK API.

Every background incarnation replaces any surviving offscreen document before accepting
secret work. Request and session identities include fresh generation bindings.
Disconnect, cancellation and deadlines invalidate pending results and terminate the
affected Workers; a fresh host never replays old operations. A session's Worker runs one
job at a time, so the host delivers a session's jobs in turn: a job for a busy session
waits instead of failing `resource-limit`, as when a passkey is signed while a login
matches the page's URI. A waiting job gets a full budget once it is delivered, so it can
take up to twice its budget in all. A job cancelled while it waits, or whose wait
outlasts its budget (`resource-limit`), never reaches the Worker and leaves the session
open. Locking or closing the session fails its waiting jobs with `crypto-locked`, and
the pending limit still refuses extra jobs with `resource-limit`. The initial caller
remains a synthetic compatibility probe. Durable cache, retained unlock material and
production connection setup are separate gates. More than one staged session may exist
for a connection. Opening a new snapshot does not itself accept it or retire older
sessions. The future cache manager must explicitly retire superseded handles and
invalidate affected policy/recipe references before accepting a replacement snapshot for
credential release.

Design later personal API key, SSO, device approval and Bitwarden passkey login
flows without assuming every user has a master password. Authentication and
decryption are independent states: a connection may be authenticated but locked.
Passkey login must accommodate authentication-only and PRF-enabled decryption.
RP ID, extension-origin and server acceptance need tests. This is distinct from
using a stored passkey to log into a website.

Keep the existing Bitwarden account as source of truth. Implement its protocol
against versioned upstream specifications and synthetic interoperability vectors;
do not depend on automating the official extension's UI. Preserve URI-match
semantics but enforce an explicit destination policy before filling. Personal
items, custom fields, organization keys, KDF variants, and passkey formats each
need an explicit support test; missing support is reported, never guessed.

The isolated URI matcher evaluates provider candidates only, following the
[pinned provider modes](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/vault/models/view/login-uri.view.ts#L132-L207).
It supports Domain,
Host, raw-string Exact and StartsWith, and Never. Regex returns an explicit
unsupported result without executing a pattern. Domain matching uses tldts after
WHATWG URL parsing, including private suffixes and direct equivalent-domain
groups from the same account. Host includes the parsed port; Exact and StartsWith
preserve the original strings. Malformed or unsupported individual stored URIs
receive unavailable metadata without blocking unrelated valid candidates.
Equivalent groups and the effective default mode are retained with the prepared
account snapshot; an unavailable or conflicting context makes the affected URIs
unavailable instead of falling back. Decrypted URI rules stay in the crypto Worker.

Deliberate differences from the official Bitwarden clients, to be reconsidered later:

- Regex URIs are not evaluated. The official clients test them; Pateat matches inside
  the crypto Worker that holds the vault session, and a catastrophic pattern would
  block that Worker. Such URIs are reported as unsupported and never match.
- When equivalent domains or the organization default-match policy cannot be read
  consistently, affected URIs are reported unavailable. The official clients would
  continue with Domain matching.
- The official clients' device-local default match setting is not visible to Pateat;
  Domain is used unless an enforced organization policy applies.

A provider match and its descriptive target origin are not a credential-release
grant. Raw StartsWith can match a different host with the same prefix. Live
integration must enforce site exclusions, account selection, recipe and document
identity, and destination/field policy separately. This does not introduce a
first-visit confirmation: eligible provider matches may automatically enter
candidate scope under the agreed settings contract. URI matching alone neither
updates settings nor authorizes a page operation.

Persistent automatic unlock across browser restarts is a requirement. Store
encrypted vault data and the necessary unlock material locally, not in browser
sync. Restrict storage access to trusted extension contexts, exclude secrets from
logs/backups/telemetry, and define revoke/lock/delete behavior. This intentionally
accepts the local-device risk of retaining a usable decryption key. An
extension-only design cannot claim native OS-keystore protection it does not use.
Initial setup and server-side session/MFA expiry remain distinct from unlocking
a local cache. Authentication failure must not erase a usable cache silently.

Use native IndexedDB revision transactions for the vault cache, as specified in
[ADR 0006](adr/0006-atomic-local-vault-cache.md). Account verification and strict
decryption of every supported received cipher precede durable acceptance.
Retain only the verified SDK user key alongside encrypted data. Keep provider
tokens, master passwords and page grants out of this record. Offline admission
validates the saved encrypted context without depending on expired online tokens.
Disabled records retain verified identity and security floors; an ordinary
refresh must not re-enable automatic unlock. Atomic expected-revision writes
prevent a stale operation from undoing a newer disable after worker restart.
Uncertain commits invalidate both candidate and old live sessions until a fresh
read and SDK verification. Immutable records preserve snapshot identity across
restart, while replacement data receives a fresh snapshot and requires policy
reconciliation before credential release.

Initially vault use does not write back: passwords, TOTP and counter-zero
assertions only. Nonzero counters produce an unsupported result. Do not reset
them to zero or keep an unsynchronized local substitute. Later writeback needs
provider sync/conflict handling and separate read, create and update grants per
connection. New capabilities do not automatically gain grants. Future automatic
password saving can be enabled without confirmation on every save, within those
grants and applicable policy. Read-only is an initial scope, not the provider API.

Handle all custom field types: Text, Hidden, Boolean and Linked. Preserve leading zeros
and duplicate names. Synced references name a custom field and, for duplicate names, its
position among them ([ADR 0013](adr/0013-service-held-recipes-and-settings.md)); resolve
Linked fields to their source. Second passwords and card PINs are valid field roles.
Prefer explicit mappings; abstain from ambiguous mappings instead of trying every
candidate. Values never go to inference; allowed field names and the coarse shape of
visible identifier values may ([ADR 0010](adr/0010-inference-field-hints.md)), and a
plan is checked against the real values locally before filling. After filling and before
the click, the executor stops when the page marks a filled element invalid or shows a
new alert. The executor runs both checks
([Background execution](#background-execution)). Automatic generation sends the
username's shape when every matching item agrees
([ADR 0016](adr/0016-recipe-generation-trigger.md#username-shape)).

Local field snapshots detach supported decrypted items from caller mutation. Each crypto
Worker caches at most 128 decrypted items per session, disposing the least recently used
item on eviction; closing the session destroys the Worker and its remaining cache.
References bind connection, user, item and snapshot identity; custom fields use
snapshot-scoped positional IDs because Bitwarden does not supply a persistent field
UUID. Resolution requires an explicit field allowlist. Linked aliases also require
permission for every source field, and Boolean fields retain a typed Boolean result.
Metadata lists never include field values or OTP seeds. The trusted host must assign a
fresh snapshot UUID whenever captured item state changes; caller-supplied identifiers do
not prove freshness or authorization.

Snapshot-bound references alone do not preserve persistent exclusions. Persist
the accepted policy-to-snapshot binding. On replacement, rebind custom-field
exclusions only when the captured encrypted custom-field sequence is exactly
unchanged, including encrypted values and linked source identifiers. Equal names
and types cannot establish identity when names repeat. For a sealed item, require
the whole captured encrypted blob to match. A changed or ambiguous sequence with
an existing custom exclusion blocks that item's secret release until explicit
review; unrelated items and stable built-in exclusions retain their policies.
Bitwarden re-encrypts the whole item on every save, so when a sync replaces a
snapshot that is still open, the crypto host also compares the decrypted custom
fields (name, value, type and linked source, in order) of each protected item;
equal fields rebind as an unchanged sequence would. Each Worker
returns HMAC-SHA-256 digests under a key the offscreen document creates and keeps,
so no value leaves the crypto host and a digest cannot be tested offline against
guesses of a short value; it is no defense against a compromised background
([ADR 0025](adr/0025-automatic-vault-sync.md#protected-items-after-a-sync)).

Review must identify the current snapshot and settings revision. Start every
current custom field excluded, and require a deliberate save of that item's
reviewed choices. Reloading metadata or saving unrelated settings must not clear
the old exclusions or count as review. Retain an item's snapshot binding after
review even when every field is allowed; an empty exclusion list must not let
an interrupted review authorize a newer, unreviewed field sequence.
Cache and settings use separate stores:
an interrupted update can leave mismatched records, which must deny release
until reconciled. Do not claim an atomic transaction across both stores.
Persistent reconciliation and its restart tests are under implementation in
the [connection setup slice](plan.md#connection-setup-and-live-catalog-progress).

Generate TOTP locally and preserve stored parameters. Test raw Base32, standard
TOTP URIs and Bitwarden's Steam variant. Unsupported OTP formats must not be
silently interpreted as TOTP. Bitwarden setup's manually entered verification
codes are distinct from future automatic email/SMS challenge retrieval.

### Unsupported vault session cases

These cases of the crypto host and the vault manager are known and not handled; each
fails as stated rather than retrying:

- Every supported received item must decrypt before a vault opens or a sync is
  accepted ([ADR 0006](adr/0006-atomic-local-vault-cache.md)), so one item the SDK
  cannot read stops the whole vault, not only that item. One known shape is an item
  with its own key whose saved URI has no valid checksum: the SDK drops that URI, and
  the library refuses the item because its URI count changed.
- A crypto job has 30 seconds. A vault whose open, or whose check of every received
  item, takes longer (a very large vault on a slow device) cannot be opened or synced.
- The host measures that budget on the wall clock. A job still running when the
  computer sleeps, or when the system clock jumps forward past the budget, ends with
  `timeout`, and a job on an open vault ends that vault's session with it.
- Cancelling a job the Worker has already received ends the whole session, because
  terminating the Worker is the only way to stop it. Only the settings page's sync
  passes such a cancellation for an open vault today.
- A Worker that fails while it has no job is noticed only by its next job, which
  fails `crypto-locked`.
- One vault manager runs one open at a time. A restore or sync of a connection that
  starts while another restore or sync of the same connection runs fails
  `resource-limit`: the page sees the vault as unavailable, or the sync reports the
  limit and is not retried by itself.
- When the offscreen document's creation outlasts its 30-second budget, the host
  creates no other document until Chrome settles that call; if it never settles,
  vault work fails until the service worker restarts.
- Work in flight when the service worker stops (an idle stop, a browser restart or an
  extension update) is lost and its page request fails. The next service worker opens
  each vault again from the retained key on its first use, so that first use waits
  for the open.

## Settings, eligibility and operation grants

Settings, exclusions, account defaults and inference settings are edited on the
service's owner-authenticated web UI
([ADR 0013](adr/0013-service-held-recipes-and-settings.md)). The extension's settings
page handles vault connection, re-authentication, unlock and service pairing, and still
edits local policy, exclusions and account defaults. The toolbar popup edits only the
active tab's site default account and exclusion, through the same worker-owned store
([ADR 0021](adr/0021-account-choice-outside-settings.md)). Its "Pateat on this site"
switch adds or removes only an exclusion rule for the exact hostname without subdomains;
when a parent-domain rule or one with subdomains covers the site, the switch is disabled
and the popup links each such rule to the settings page. While the tab's page waits for
an account choice, the choice is the popup's only list (the owner asked for one list on
2026-10-13 at 03:54 UTC): its cards mark the saved default, its "Make it the default"
checkbox makes the picked account the default once that login succeeds, and a saved
default can still be removed there. The default-account list, where a default is chosen
without logging in, returns once the page no longer waits. An open popup reads the
settings again from the worker whenever the stored settings change, so a default saved
by a picked login that succeeds while it is open shows without reopening it. The popup
waits up to 45 seconds for the site's matching vault items. When the search has not
answered by then, as while the vault is busy right after the extension restarts, the
popup stops waiting and says to reopen it a little later, while the worker finishes the
search, and the saved default shows by its saved labels. Under the header, a "This page"
section ([ADR 0038](adr/0038-login-status-badge.md#popup);
`apps/extension/src/popup/page-status.tsx`) asks the worker every second with
`login.status.get` and says whether the site has a recipe that starts on the page, one
on other paths only, or none; the AI's last answer for the tab (making a recipe, made
one, chose not to, could not, or a page sent with no answer recorded), or why the page
was not sent; and the tab's last login on the site (logging in, logged in, waiting on a
second step, an ended sign-in that could not be confirmed, or why it did not start,
stopped or did not succeed, with a note that a
broken recipe is not made again automatically), and a refusal the badge shows, such as
"the vault item has neither a password nor a passkey". Known codes get a plain sentence
and others show their log name; a link opens the diagnostics page. The worker answers
from the recipe cache, its own record of the top page, the badge's spin for a request
in flight, and the last login and model request the badge keeps from the log reports,
with the badge's lifetime: a top page of another origin or the tab's closing drops them,
and `chrome.storage.session` keeps them across a worker restart. Item selection, field
exclusions and custom-field review stay on the extension's settings page once synced
([ADR 0023](adr/0023-synced-vault-policy.md)). The service keeps one settings document
per owner; [ADR 0024](adr/0024-settings-profiles.md) assigns its parts either to a
settings profile that each device will choose later or to the owner. Chrome use access
to these pages is not assumed. Keep settings and execution operations independent of
their UI.

Each connection supports all items except exclusions or selected
folders/collections/items only. Use existing Bitwarden metadata; independent
Pateat tags are deferred. Item and field exclusions win over inclusions. Excluded
fields are neither inference candidates nor fill sources. These are Pateat use
restrictions, not reduced Bitwarden server permissions or decryption access.

Provider URL matching plus eligibility makes a site automatically in scope,
without first-visit approval. Site exclusions use host matching with an explicit
subdomain option and stop Pateat analysis, inference, filling, submission and
passkey handling while preserving ordinary browser authentication. Apply them
before collecting observations; policy changes cancel stale work.

The account choice is a saved site default applied on the next login. A default names
the provider account and item, not this device's connection. Without one, a single
eligible provider URI match is used and saved only after confirmed `authenticated`; a
saved choice keeps winning when more items match later ([ADR
0013](adr/0013-service-held-recipes-and-settings.md)). Changing it does not log out the
current session. No match or several matches require a choice rather than trying
accounts in turn. Under [ADR 0021](adr/0021-account-choice-outside-settings.md) the
choice is made in the toolbar popup for the refused document and may be one-time. After
a finished login in a tab, the recipe's first step appearing again in that tab's page
asks for a choice again instead of logging in, with the saved default first; for
passkeys, a username-less request after Pateat signed in the tab opens the chooser
window (part D of [ADR 0021](adr/0021-account-choice-outside-settings.md)). Automatic
logout/relogin when the user picks another account while logged in stays later. Cookies
may be shared across tabs even during initial login. Another tab's login of the origin
that is running or ended without success holds the origin until that tab closes or its
record has not changed for 5 minutes; an `authenticated` one, one that ended
`interrupted` without submitting, or one Pateat itself stopped with nothing in flight
(such as `policy-changed`) does not. A tab keeps one attempt record per origin and runs
one attempt at a time; a page resumes only its own origin's record, except that a new
page releases one Pateat itself stopped with nothing in flight before any submission and
logs in as a new tab would, and a top-level attempt that may have submitted ends
`left-origin` when the tab moves to another origin, or `authenticated` when that origin
belongs to a passkey Pateat has just answered and its page shows no sign-in, or when a
`password` login's tab moves, within 30 seconds of the login's last step that may have
submitted (a fill or click), to another HTTPS origin of the same registrable domain,
or within 30 seconds of a second factor (a TOTP code it submitted, or a passkey Pateat
answered after the item's password) to an HTTPS origin of any site, whose
page shows the account's username and no sign-in or, when it shows no username, a
signed-in marker learned on that origin or the judge, asked once. An ended record of a
site the tab left, including a frame's login on that site's page, never holds the new
site's page or its frames ([ADR 0022](adr/0022-login-attempts-per-tab-and-origin.md)).
Wider shared-session domains need explicit coordination before broader support, not a
guessed relationship between origins.

Credential eligibility does not grant arbitrary post-login actions. Later
transactions/approvals require separate site/action grants and deterministic
execution checks. Users may preauthorize bounded automatic operations without
confirmation every time; AI cannot expand those grants. The initial action
vocabulary contains login operations only.

## Background execution

Address tabs explicitly by `tabId`, frames by `frameId`, and documents by `documentId`.
Never select the target by whichever tab happens to be active. Use declarative content
scripts/host permissions and browser events, not a popup or focus event as the execution
trigger. The one exception is a choice the user makes in the toolbar popup: it restarts
only the one recorded document that was refused for several matches, through
`login.reconnect` ([ADR 0021](adr/0021-account-choice-outside-settings.md)). A vault
check after a page with a recipe found no matching item likewise reconnects only that
refused document, once the check applied a new snapshot within ten seconds
([ADR 0025](adr/0025-automatic-vault-sync.md#after-no-item-matches)). A static content
script runs on every HTTPS page and frame; the background admits non-excluded sites with
host access and needs a cached recipe for the exact origin before any policy or vault
access ([ADR 0009](adr/0009-install-time-https-site-access.md)). A frame also needs the
tab's page admitted, and its account must match the tab's URL as well as the frame's
([ADR 0017](adr/0017-login-forms-in-frames.md)). The exception is recipe generation: a
tab's own page on whose path no recipe starts that shows a login field within 10 seconds
and has a vault URI match is observed and sent, and not again within 10 minutes per
origin and path once a request for it reached the model,
unless the tab holds an attempt record other than an account switch on that origin
([ADR 0016](adr/0016-recipe-generation-trigger.md)). A page that shows no login field
within 10 seconds is sent instead, without slots, only when its URL names another path
of its site in a query value, and a cached entry recipe on a page's path is pressed: one
click on a same-site link in the top document, then the tab's next page is checked
([ADR 0031](adr/0031-sign-in-entry-pages.md); see
[Declarative recipes and AI](#declarative-recipes-and-ai)). The request also offers
one slot per custom field a matching item allows (Text, Hidden, or Linked with an
allowed source), named by field name and position, under an opaque ID such as `custom-1`
([ADR 0027](adr/0027-per-account-login-routes.md)). Just before sending, it reads the
matching items' usernames and the values of Text fields and of Linked fields that read
the username or a Text field for their shape, each sent only when all items agree. The
returned recipe enters the recipe cache and starts at once: `login.reconnect` asks every
tab's page still tracked on that origin and path that holds no login to announce again.
That covers the page that was sent and a page refused for want of a recipe while the
request was in flight, such as one that replaced it in its tab or the same page in
another tab. After a recipe's final
`advance` step, a page that has loaded and shows a password, username or email input for
a slot the recipe does not fill yet, on one path for a second, is sent once per step
with the revision it continues; the running login takes the continued revision over when
it only appends steps and still resolves to the login's account, and runs the new steps
([ADR 0018](adr/0018-recipe-generation-route.md#continuing-after-an-advance)). Any other
page that an effect step leads to and no check explains is sent to be judged, which can
learn a signed-in marker or a second-factor handler
([ADR 0018](adr/0018-recipe-generation-route.md),
[ADR 0027](adr/0027-per-account-login-routes.md); see below). A judgement or
continuation that changes the recipe pulls recipes only; settings wait for the next full
sync, since a settings write would stop the login the page belongs to. Inactive, frozen,
discarded, and navigated documents are different states; only live documents can
execute.

Do not inject `chrome-extension://` iframes, automatic overlays or unlock windows into
the flow. There is no page UI; use an icon badge, the toolbar popup and manually opened
settings. The one extension window is the passkey chooser of
[ADR 0021](adr/0021-account-choice-outside-settings.md), opened for a pending request
from a focused page, with several matches or after Pateat signed in from the same tab,
and never in incognito. Do not attach our own
debugger in normal operation. Another installed extension can still inject a conflicting
frame; coexistence requires an explicit compatibility test and documented settings.

Each login is an attempt state machine (`loginAttemptMachine`): detected -> ready ->
executing -> submit-intent -> awaiting-result or reconciling -> authenticated or
blocked, with retryable after a failure that changed nothing. Records are kept per tab
and origin ([ADR 0022](adr/0022-login-attempts-per-tab-and-origin.md)). One writer owns
an attempt, and a tab runs one attempt across all of its frames; other tabs can progress
independently. Revalidate origin, account binding, target elements, and document
immediately before each fill or click. Expire late AI results after navigation and
cancel outstanding work. Synthetic events and lack of trusted user activation may limit
some sites. An attempt starts when a recipe's first step, that of its start-page
`passkey` route or of any of its `password` variants, is ready on the page, including
after a same-document URL change, and each later fill or click waits a bounded time for
its elements ([ADR 0013](adr/0013-service-held-recipes-and-settings.md#recipe-lookup)).
The browser-provided `sender.url` keeps a document's load URL, so the executor takes a
top-level document's current path from the tab's committed URL. The vault match for
generation (`generationSlotsFor`) uses that URL too, on a first page as on the page
after an `advance` step.

A preparing fill (`prepare`) enters its inputs in order, 25 ms apart so the page's
handlers for one field run before the next, each typed as a keyboard would type it:
focus without scrolling, which blurs the field before; a field that already holds text
is cleared first (`beforeinput` and `input` of type `deleteContentBackward`); then each
character, one task apart, so the page's handlers for it and their microtasks run first
(no timer, which Chrome throttles on a hidden page to a second, or to a minute after
five minutes hidden), as `keydown` and `keypress` naming its key (no `keypress` for a
control character), `beforeinput`, the character appended through the native
`HTMLInputElement` value setter (so a framework that tracks the value, such as React,
sees a change; a number input gets the characters typed so far, as Chrome empties one
that is not yet a number, such as `1.`), `input` (an `InputEvent` of type `insertText`
with the character as its data) and `keyup`; then `change`, and blur unless the page
moved focus elsewhere. Key events carry Shift for the characters a US layout types with
it. A page that cancels a character's `keydown`, `keypress` or `beforeinput` keeps it
out, as a browser does. One more wait follows the last character, 25 ms on a shown page
and one task on a hidden one (a framework writes a key it cancelled only once its
handlers ran); then the fill stops as `fill-rejected` without `change`, blur or a click,
so a value the page changed is never submitted, when the input does not hold the value
after a cancelled event, or holds a value of another length. Since 2026-10-13, when a
bank's password field held one character fewer than the typed value with no event
cancelled and the login was sent and rejected, the length is checked after every typing;
a value of the same length, such as a mask or a case the page changed, is kept, while a
page that reformats a value, as by adding hyphens, refuses it. The length is checked
again one wait after `change` and blur, whose handlers may rewrite the value, and a fill
refused then has sent both; a field emptied then, as by a form that switches to other
fields, is left to the checks before the click. A same-length change is a known limit: a
page that turns a full-width character into a half-width one, or one symbol into
another, still has its value submitted, as it would be from a person's typing. A page
that cancels the clearing `beforeinput` and does not clear the field itself by that wait
refuses the value the same way before any character is typed. A code split into
one-digit inputs gets the same per digit, 25 ms apart. Typed keys are only a value's
characters, so a page's Enter handler does not run. Each field's scope checks, and a
split code's per-digit checks, run after the wait before it and again after each wait of
its typing, including the waits after its last character; a typing they stop leaves the
characters typed so far in the field and fails the step, so nothing is clicked, unless
the code watch of [ADR 0027](adr/0027-per-account-login-routes.md) saw the page take the
code, as a page that replaces its form once the last digit is in does: that ends as
`submitted`. The 500 ms check of [ADR 0010](adr/0010-inference-field-hints.md) follows
the last field. A fill that advances or submits through the page's own event sets the
value and sends that one `input` or `change` event alone, with no focus, keys or blur
that could run its effect again. Known limits: the events are not trusted (`isTrusted`
is false), so a page that checks that, or opens a software keyboard on focus, can still
refuse a fill; only letters, digits and space get a `code` and `keyCode`, after a US
layout; Chrome sends no focus or blur events to a page whose window is not focused, so a
page that reads a field only on blur may still miss it there; a hidden tab's timers are
throttled, so the waits between fields and between the digits of a split code may
stretch; a page that writes the field from its own timer after each key may drop
characters, and its fill then stops at the check after typing, while one that keeps its
own copy of the value from such a timer may hold another value while the field passes
that check, and the copy is submitted (a page's zero-delay timer runs before the next
character only when Chrome queues it first, which it does not once it clamps nested
timers to 4 ms); and a page that submits on its own from a key or blur handler of a
preparing fill is not watched for, so the click after the 500 ms check still runs if its
button stays clickable. Before 2026-10-13 a preparing fill sent only `input` and
`change` after the setter, in one task; that day a bank page showed its required-field
error under its filled fields. Until later that day it then set the whole value at once
between bare key events, as Bitwarden's autofill does; the same page's React inputs kept
their state empty after that (a dummy-value probe in the owner's Chrome), and took each
value when it was typed a character at a time. Characters were 25 ms apart, about 0.5 s
for a username and a password, until the owner chose one task apart that day
(2026-10-13), for speed: a character the page drops from the field still stops the fill
before the click. Fields are not typed at the same time: only one input has focus, and
typing two at once would move focus, and run the page's blur and focus checks, at every
character; one task apart, a field's characters take a few milliseconds, so typing the
fields in turn costs little (owner, 2026-10-13).

MV3 workers can stop. Persist only resumable metadata, never an instruction to blindly
replay a submit. Input and change handlers can submit without a click. Declare whether a
fill prepares fields, advances a flow or submits it; an input-triggered advance or
submission uses one explicit event and initially one field. Record intent before any
field mutation or event, including preparation fills. An acknowledgement proves local
execution, not remote acceptance. After interruption around a fill or click, observe the
current page and reconcile the outcome before another attempt. An uncertain fill must
not be repeated merely because the original fields remain visible. Only a confirmed
failure before mutation can permit a bounded retry. Never use an observation timeout to
fall back from an input-triggered submission to a click. Recipes for ordinary click
flows must explicitly describe tested preparation behavior. Exactly-once effects at a
remote website cannot be guaranteed by local state alone. Apply a finite retry budget
per attempt, with a terminal outcome for lockout risk. The submission budget reserves
each executor effect before delivery; only a validated failure proving that the current
operation made no mutation can release its reservation. A fill whose operation no longer
validates just before the worker reads its values (`operation-invalid`, as when it
expired while its authorization was read) never reached the page, so it is such a
failure and is tried again. A separate retry budget still applies: a failure that
changed nothing on the page (`retryable`) is tried again from the same step at most
twice, and a spent budget ends the attempt `blocked` with `retry-limit`. A TOTP code's
click after the code is in, a `totp` handler's or a route step's, is never retried,
since a late click could submit an expired code; its failure ends the attempt
`retry-limit` at once (ADR 0027). Initiated or possibly initiated effects remain
counted, not proven server requests: one page handler can itself issue more than one
request. Each fill step writes only inputs inside one form (or only inputs outside any
form). A provider password goes only into a password input, and a TOTP code only into a
one-time-code or short numeric input, so a recipe cannot place them in a search box. A
Hidden custom field goes only into a password or short numeric input, and a Linked
custom field follows the field it reads. Before a fill step that writes a secret but not
the username (a site that remembers the account and asks only for the password), the
background sends the selected item's username to the content script with that one fill.
The content script compares it with the account identifiers shown in the form, or the
page when there is no form, and the first eight `h1`-`h3` headings; every element
boundary separates words, and `mailto:` links, `<address>` and `<footer>` are skipped as
contact addresses. The username never leaves the content script or reaches status. An
email username is compared with shown email addresses. A username of digits only is
compared with masked IDs that show at least two characters (`****1234`), and only on a
step that fills a password or Hidden field, because a one-time-code page usually shows
the masked phone number the code was sent to. If comparable identifiers are shown and
none fits (`myaccount@example.com` or `****9999` shown while `my2@example.com` or
`00001234` is selected), the step fills nothing and the attempt ends `wrong-account`
without a retry or a spent submission. A masked value consistent with the username
(`m***@example.com`, `****1234`) proceeds, as does an item without a username, a
username of another kind (`taro99`) or a page that shows no comparable identifier. A
masked number that is not the account, such as a card number on a password page, still
stops a digits-only username: a known limitation. A recipe can name an `accountSwitch`
target: the button or `<a href>` link that switches to another account
(`{ "by": "text", "value": "Use another account" }`; text locators match link text only
here and in a signed-in marker; the recipe must not use it for a click step or
`rejection`). When the page shows another account, nothing was submitted in the attempt,
and that target matches exactly one shown link or button that does not submit a form,
the background first records the attempt as `account-switched` (blocked, no submission
spent) and then has the content script click it. The click happens only within 10
seconds, on the same path, while the target still matches exactly that element;
otherwise the record becomes `wrong-account` and keeps holding that origin in the tab.
After the click, the tab's next document of that origin that reports ready starts a new
attempt instead of resuming, so a recipe that starts on the page the switch leads to
logs in, such as an email page at `/signin/id` after a password page at `/signin/pwd`
that showed `myaccount@example.com` (owner decision, 2026-10-11). That attempt carries
the switch and never clicks another: a page that still shows another account ends it
`wrong-account`. Without the target, or when it is missing or ambiguous, the attempt
ends `wrong-account` as above. A switch that changes the account in place, without
loading a new document, does not continue the login. Before a fill step writes anything,
the content script checks every value against its input
([ADR 0010](adr/0010-inference-field-hints.md)): non-empty, within the input's
`maxlength` and `minlength` (ignored on `number` inputs), and a valid email or number
for those input types (`valueMismatch` in `packages/contracts/src/values.ts`). A
22-character password and an input with `maxlength="8"` fills nothing and ends the
attempt `value-mismatch` without a retry or a spent submission. After a preparing fill,
the content script waits 500 ms for the page's own handlers and ends the attempt
`fill-rejected`, without a retry or the click, when a filled input is invalid
(`validity.valid`, which unlike `checkValidity()` fires no `invalid` event), became
`aria-invalid="true"`, or a visible alert shows text that no such region showed before
the fill. Alerts are `role="alert"` and `aria-live="assertive"` regions anywhere, and
`role="status"` and polite regions inside the filled form or named by a filled input's
`aria-describedby` or `aria-errormessage`. A message the page already showed and renders
again is not new, nor is a mark the input had before the fill. The text stays in the
content script; only the outcome leaves it. A fill that submits through its own event is
checked only before filling. When a filled input was replaced during the wait, nothing
is clicked and the attempt observes the page instead. A click is not made, and the
attempt ends `structural-mismatch` and moves to reconciling, when the page emptied a
shown input that this document's fills wrote to since the last click, or, for a
submitting click, when a shown password input that was not writable when those fills
began is empty. Only the clicked element's form counts (the page, for an element outside
a form), and only once Pateat filled something in it since the last click. St.George's
logon page (`ibanking.stgeorge.com.au`) with a remembered access number hides its
Security Number field; typing the access number clears every field and shows it
(2026-10-12), so the form would otherwise be sent with the access number and Security
Number empty. A passkey button beside an empty password field, a registration panel's
password field shown from the start, and an earlier step's field the page hid and
cleared do not hold a click. When the page shows a CAPTCHA frame (ADR 0029's S4) as a
click is about to run and none of its services' token fields holds a token yet, the form
stays filled and nothing is clicked: the click is left to the person and held as a
handler's click is, up to two minutes while its button shows
([ADR 0029](adr/0029-local-sign-in-state.md)); a chooser's click on its list is made as
before. Explicit credential rejection stops retries with that credential. Structural
mismatch is meant to request bounded repair (not implemented, see
[Declarative recipes and AI](#declarative-recipes-and-ai)); unknown submission outcomes
require reconciliation before any resubmission.

A new login reads its item's facts once and records them in its attempt
([ADR 0027](adr/0027-per-account-login-routes.md)): a non-empty, not excluded password
and TOTP field from the catalog's value-free `empty` flags (an allowed Linked field that
reads one counts like it), and any usable or discoverable passkey from one item-scoped
vault search per RP ID the origin may use. The facts never leave the extension. The
attempt also records its route. A recipe may have a start-page `passkey` route, one
click on the start page's passkey sign-in button; it is taken first when the item has a
discoverable passkey, needs no binding, and a login on it that reaches no signed-in page
ends `challenge`: it never falls back to typing the password, and after `authenticated`
it saves only the site default. On a recipe without that button, a start page that asks
for a passkey by itself with a `conditional` request gets the same route, whose one step
answers that request with the login's item; a `password` login switches to it before
anything is submitted, and a login on a chooser's list
([ADR 0028](adr/0028-account-chooser-login-pages.md)) before its click there. It falls
back to the recorded `password` variant when no request comes, the item cannot answer
it, the recipe's rejection shows, or the sign-in form still shows 15 seconds after the
answer, and until then a page on the start path is not judged (up to two minutes while
it shows nothing to describe, as a loader). While the tab asks for an account after a
logout, that request waits for the popup pick, whose login answers it the same way. So
does it, for up to four minutes, while the popup offers the page an ordinary choice of
accounts in which an item holds a discoverable passkey, checked with one vault search
per RP ID; it is handed on three seconds after that choice goes away
([ADR 0034](adr/0034-answer-page-passkey-requests.md)). A recipe's `password` route has
one to four variants, one per identifier set its start page offers (such as branch and
account numbers, or a contract number), and the attempt records the variant it took: the
first, in recipe order, whose binding resolves on the item and whose every bound
password or TOTP field, built in or Linked to one, has its fact; the item's own password
must also be present. A saved binding is the only source for its item, so a variant
whose slots it does not hold is skipped. When none fits, a recipe with one variant
refuses the page with that variant's reason, and a recipe with several refuses it
`no-route`, with the first variant's reason as the logged refusal's detail. A `no-route`
of a variant names the fact it missed as the detail instead: `password-empty` (the item
holds no password), `password-not-allowed` (it holds one the account may not fill),
`no-totp` (a bound TOTP field without a secret) or `passkey-unresolved` (the facts chose
the passkey route, which did not resolve). An item whose password is missing or empty
(`password-empty`, never `password-not-allowed`) but that holds a usable passkey,
discoverable or not, still takes the `password` route of a recipe without alternatives,
in the tab's own page, when an `advance` step comes before the route's first step that
fills the password and no step before that one fills a value the item lacks
([ADR 0036](adr/0036-passkey-after-the-identifier.md)). On a chooser's list (ADR 0028;
owner, 2026-10-13 06:32 UTC) that route is the click's: the click, chosen as for any
item, is the `advance`, and the stop lies at the branch's first step that fills the
password, just past a branch that fills none and ends with an `advance`, or just past
the click while the branch is not generated yet. The account branch's route is checked
before the list is read, and the `other` branch's again when the list leads there. When
the account branch cannot take the stop, the list is read on the click alone, so an
account it does not show still goes on through `other`; a stored branch the list leads
to that cannot take the stop is refused `no-route`, with nothing pressed. The same holds
for a route that fills no password at all and ends with an `advance`, as an
identifier-first recipe whose page after the identifier is not generated yet, when none
of its steps fills a value the item lacks and no slot of its binding reads a password
from another field (the `password` slot, a field Linked to the password, or a hidden
custom field): its stop lies just past its last step. Such an attempt gets one
submission more than the recipe's budget, kept for the passkey answer at the stop: no
step, handler or page's own submission may spend it, and a switch to the `passkey` route
gives it back. When such an item does not go on, the `password-empty` detail names why
after a colon: `password-empty:no-passkey` (no usable passkey for an RP ID the origin
may use), `:alternatives`, `:no-password-step` (the route fills no password and does not
end with an `advance`), `:no-advance` (no `advance` step before the one that fills the
password), `:fills-lacking`, `:password-field` (a slot reads a password from another
field) or `:frame`, also for a variant whose binding reads nothing from the empty
password. The attempt records that step as its stop (`stopAt`, its index in the plan, or
the plan's step count for a stop past its last step, moved along when a handler is
entered before it), and the attempt contract never prepares it or a later step, so
neither a worker restart nor a vault sync that adds a password meanwhile types one; a
handler shown after the stop is not entered, and at the stop only a `passkey` handler is
(below). The binding keeps naming the empty password, so the item signs in with its
password once it has one. The steps before the stop run as on any `password` login. The
login reaches the stop once the stop step's elements show. For a stop past the last
step, the page after that step's `advance` takes the login there at once when it asks
for a passkey after the step, waiting or answered by the passkey bridge. Otherwise that
page is continued as any login's ([ADR 0018](adr/0018-recipe-generation-route.md); the
owner's decision of 2026-10-13 04:42 UTC), offering the `password` slot though the
item's password is empty: a continuation the login takes over moves the stop to its
first step that fills a password (or past its steps again), and its kept submission into
the continued budget; one the stop cannot be moved into is not taken over, and the
login's `challenge` at its stop then names why (`password-empty:fills-lacking` and the
like). A page that does not qualify for continuation is judged once the step's 10-second
wait runs out, and a `passkey` handler the judge learns is entered before the stop and
pressed. When the continuation fails or abstains, or the judge leaves the page undecided
or a challenge with no handler, the login goes on to the stop; an advance the record
cannot go on from ends `challenge` unjudged. At the stop the login fills nothing: it
waits up to 3 seconds for its document's `conditional` passkey request, counting one
already waiting, and answers it with its item, or counts an answer the passkey bridge
gave a request of the tab's page since the login's last effect step. The answer is a
submission (`STOP_ANSWERED`), and the page is then observed as after a click: while the
stop step's fields still show it is not judged or settled, for up to 15 seconds after
the answer, and a page on the stop step's path, or for a stop past the last step on the
path the answer was given on in the same document, is held as the `passkey` route's page
is after its answer ([ADR 0034](adr/0034-answer-page-passkey-requests.md)). Without a
request in those 3 seconds, a `passkey` handler of the recipe shown on the page is
entered before the stop step, which moves along, and its button pressed (owner,
2026-10-13 05:39 UTC); the request that follows is answered with the item, and the click
is held while its button shows, as any handler's. Without one, a page that still shows
the stop step's password field on its path, where the recipe has no `passkey` handler,
is sent once per attempt to be judged as a stop's page (`stop: true`, recorded as
`stopJudged` before the request, so a restart does not send it again), within the
judge's limits on the service, which keeps only a `passkey` handler from it; the login
takes that revision over and enters the handler in the same way. On a chooser's branch a
learned `passkey` handler is entered and pressed the same way, but the page is not sent
to be judged (`not-sent` with `chooser`), since the service judges no stop's page of a
chooser. A login on the `password` route without a stop never enters a `passkey` handler
on a path where its plan still has a route step to run that fills the password, nor
while a fill field of the route shows on that path, so such a button never pre-empts a
password that is typed, even while a form swaps its fields in place; a route step still
to run there that fills only another slot, such as a code after the password, does not
keep the handler out. The service judges such a page only when its password field
matches the route's fill locator exactly, and answers `not-judgeable` otherwise (a known
gap, ADR 0036). Without a request or a button, after an answer the item could not give,
or with the form still showing after those 15 seconds, the login ends `challenge` and is
watched. A login that switched to the `passkey` route before its first submission never
falls back to a variant with a stop; it ends `challenge`. A running or resumed login
checks only its recorded variant and never reads the facts again
([ADR 0027](adr/0027-per-account-login-routes.md#implementation-choices)). After each
effect step the executor checks the signed-in markers, the rejection and the plan's next
step, then the recipe's handlers on the page's path. A click or an `advance` fill
continues when its next step's elements are unique on that step's path, if that path is
another one. An `advance` whose next route step is on its own path, as an
identifier-first form that swaps in its password form in place, continues only once that
step's elements are ready as the step waits for them (each fill field a shown writable
input, a click's button shown and enabled, an `assert`-present step's element present),
none of them was ready or matched several elements when the content script measured them
in the same task as the click or the fill's first input, just before it, and none is one
of the advance's own elements
([ADR 0013](adr/0013-service-held-recipes-and-settings.md)). This holds in the same
document, after a `history.pushState` that keeps the path, and in a new document the
form posts back to that path once the advance's answer arrived. So a page that still
shows only the account form, or showed the password form from the start, never
continues, and Next is never clicked again; it settles as any advance its next step
never confirmed, after 10 seconds. The measurement is kept in the worker's memory only,
so after a worker restart such an advance settles that way too. As on another path, the
next step comes before the recipe's handlers: a page that shows the password form beside
a handler's elements on that path gets the password, not the handler. "Shown" is the
content script's visibility check, which ignores occlusion, opacity, off-screen
position, `aria-hidden` and `inert`, so a password form revealed under a captcha or
consent overlay counts as ready: a known limitation. A click that submits never
continues on its own path, and handler steps keep their own rules. A handler that has
not run is entered once per login when all its elements are unique and usable: its code
field a shown writable input, its button shown, enabled or not, since many code pages
enable Verify only once the code is typed (the click step waits for it to be enabled).
Its steps follow the effect step and grow the attempt's step and submission budget (at
most 4 handlers, 40 steps and 12 submissions). A `totp` handler whose button is also a
route step's on that path is entered only while none of the route's fill fields there
shows. A handler that already ran counts as shown again when its elements are present at
all, hidden or disabled. The `passkey` handler clicks a button such as "Use security
key" only for an item with a usable passkey. The `totp` handler fills a code from the
item's built-in TOTP field into its code field under the TOTP fill rule and clicks its
button once; it needs the TOTP fact and that field allowed for the account, and a
binding that names another field for the code ends `challenge`, since Pateat cannot make
a code from a custom field yet. When several handlers show, the first that qualifies is
entered, a `passkey` handler before a `totp` handler; one is passed over when it already
ran, the item lacks its fact, or, for a `totp` handler, the login already types a TOTP
code (`code-used`), since a login types at most one code. When every shown handler is
passed over, the attempt ends `challenge`. After the code goes in, the content script
watches the page for 2 seconds before the click: a submit event, the document unloading
or navigating, the field or form disabled, removed or replaced, the field cleared, the
button gone, hidden, busy, disabled after it was enabled or still disabled half a second
after the code went in, or a new busy indicator in the form each mean the page submitted
the code by itself. So do a page that leaves the path or shows a signed-in marker or the
rejection without the button before the click, and a new document after the fill. Each
counts as the handler's click (`AUTO_SUBMITTED`); the code is never filled again or
followed by a click. A route step that fills only the `totp` slot, followed by a click
on the same path, is watched and settled the same way. A button rendered again at the
same locator and a status message alone, such as a digit counter, are not signs, and a
status message never refuses the code. While a handler's or the `passkey` route's
clicked button, or the button of a code the page submitted itself, still shows in that
document, the page is neither judged nor settled for up to two minutes; then it ends
`challenge`. A new document of the tab that shows the `passkey` route's button again
ends `challenge` at once, and so does one that shows a handler that already ran and no
other that qualifies; a handler shown there that still qualifies, such as a `totp`
handler beside a `passkey` handler that already ran, is entered. When the result
settles, the page's sign-in state ([ADR 0029](adr/0029-local-sign-in-state.md)) is read
first: on the `password` route, evidence of a sign-in that a reading a second later
confirms in the fully loaded document (read again a second apart, at most ten times,
while it loads) completes the login as `authenticated`, and a failure shown next to the
sign-in fields (S1 with F1 or F2) confirmed the same way ends it `credential-rejected`.
In the submitted document F1 and F2 are a new mark or new alert text. When the sign-in
form comes back in the first new top document of the tab after a password submission,
announced within 30 seconds of it, any mark on its sign-in inputs or any text of an
alert next to the form counts (inside it, named by one of its inputs, or sharing a
container with it that is not the body and holds no page chrome, no `main` area and no
other shown form with a shown, enabled field to type in or pick from, as a passkey or
social sign-in form of buttons and hidden inputs is not), never while a recognised
CAPTCHA (S4: reCAPTCHA, hCaptcha, Turnstile) shows; this also ends a login already
watched after the submitted document's reading. Later documents and pages after an
`advance` or passkey step are not read this way. Otherwise a page no check explains is
sent to be judged unless it still shows a fill field of any of the route's variants on a
route path or a signed-in marker (on the `passkey` route, its button or a fill field of
any `password` variant on its path or a `password` route path); this applies to later
documents of the tab too, while the attempt has not ended. The page of a login's stop
before its item's missing password is the exception: sent as a stop's page, it must show
the route's password field, and the service keeps only a `passkey` handler from it
([ADR 0036](adr/0036-passkey-after-the-identifier.md), owner 2026-10-13 05:39 UTC). At
most 2 pages count per effect step: the attempt counts a page once its complete
description is in hand, before the request, so a restart during the request cannot
resend without bound. A page is given back only after a temporary refusal before any
model call (a busy service, the service's own 429, an unreachable service, no paired
service, a rejected device, or a request that failed before the model). Permanent
refusals such as `already-judged`, `not-judgeable` or `recipe-conflict` count, and so do
the provider's rate limit, a timeout and an unexpected answer, which may follow a model
call; so a settled login sends at most 2 counted pages per effect step plus retries
after temporary refusals. A page whose description is incomplete, failed or of another
path is not sent and does not count. A judged page's path carries `[id]` in place of
each segment that may hold a token, as every observed page's does
([ADR 0039](adr/0039-redacted-token-path-segments.md)), so pages that differ only there
share one judgement, its locators never use an attribute value that may be a token, and
a field no locator names is left out unless it may be a sign-in field (ADR 0029). Since
ADR 0039 a handler is learned on a path with `[id]` too, and matches that page of every
tenant. A disabled field that may not be a sign-in field is left out too:
the request says so (`partial`), the page then completes only on `signed-in`, and the
service keeps the model's abstention on it as `partial`, so the path is judged again
when a page of it is described in full (ADR 0029). A page where a route's sign-in field
shows (S1), on any path, is not sent; only an input of a kind Pateat fills counts as
that field, never another element its locator names on another page, while the passkey
route's button counts as shown. A handler's click is a new effect step. A `challenge`
verdict that added a handler hands back the newer revision: the attempt takes it over
(`REVISED`) when it only adds handlers or signed-in markers, and runs the handler on the
page it is on. A resumed attempt accepts a newer cached revision on the same terms only
while the worker still holds its recorded revision; after a worker restart only the
recorded revision resumes. What the judge answers settles the login on the `password`
route as the ADR's outcome table says: `signed-in` completes it, `rejected` ends it
`credential-rejected`, and `challenge` ends it `challenge`. An `unclear` answer
completes it, as a warning marked `completed`, only when the page confirmed no sign and
no evidence (S1 to S5, E1 to E3) before the request and still shows none in the loaded
document after the answer, the login is not watched, the description left out no
disabled field, and the model abstained or the service answered `already-judged`,
`judged-signed-in`, `judgement-limit`, `daily-limit` or `monthly-limit`. Only the
`signed-in` verdict or `unclear` with `judged-signed-in` is confirmed; other undecided
completions carry `unconfirmed: true`, save no pending account choice and note no
sign-in for passkey registration refusal. They show the yellow unsettled badge and
the popup says the sign-in could not be confirmed. Automation still stops, the site
is released to other tabs and later logout detection is unchanged
([ADR 0029 amendment](adr/0029-local-sign-in-state.md#amendment-unconfirmed-completion-2026-10-14)).
An `unclear` answer on a page with
a confirmed sign of another sign-in step (S2 to S5), or the service's `judged-challenge`
for a path judged `challenge` before in the revision, ends it `challenge`. Anything
else, including the service's `judged-rejected` for a path judged `rejected` before, its
`judgement-unanswered` for a path whose earlier request has no verdict, and a page that
was not sent, leaves it unknown. A login that stops before its item's missing password
([ADR 0036](adr/0036-passkey-after-the-identifier.md)) never reads the username in the
header or navigation (E2), after its steps, while watched or on a move to another origin
of the site, since the page after the identifier may show it before the sign-in; an
`unclear` answer that would complete it ends it `challenge` instead, watched. After a
recipe's final `advance` step on its first `password` variant, a page that has loaded
and shows, for a second on one path, a password input other than the recipe's own fields
while the recipe fills no password, or a username or email input while the recipe fills
no username and none of its fill fields is writable on the page, outside any form with a
`new-password` or `one-time-code` input, is not judged: it is sent once per step to
continue the recipe, offering only the slots the recipe does not fill yet and no custom
field its generated slot map already names (`CONTINUING`, recorded before the request
and given back by `UNCONTINUED` only when the generation claim is freed or the request
was not sent, as for the first page, and not after `recipe-revoked` or
`recipe-conflict`; the document that sent it never sends it again). The attempt takes
the returned revision over (`CONTINUED`) when it keeps every step of the recorded one,
only appends steps that fill none of its slots again, and a dry run of its route still
resolves to its account; its step and submission budget grows by the appended steps and
effects. The advance that the continued revision now follows had no next step when it
ran, so it was measured with nothing and the takeover alone moves the login on. The
request is kept in the worker's memory, so a later document of the login waits up to 100
seconds for its answer. A spent or unusable request on such a page settles `unknown`
without a judge call
([ADR 0018](adr/0018-recipe-generation-route.md#continuing-after-an-advance)).

A top-level `password` login whose result stops at `challenge`, for any reason, or
settles as unknown is watched for 10 minutes from that moment
([ADR 0027](adr/0027-per-account-login-routes.md#watching-after-a-challenge), owner's
choice on 2026-10-12): the record keeps a `watch` (its start, the document it began in,
and its own judged pages). A `challenge` login moves to the `watching` state, where it
runs no step: each new top-level document of its tab and origin, other than the one the
watch began in, is only read. The signed-in markers are checked for 3 seconds, then the
sign-in state; a confirmed `signed-in` reading completes the login, and a page with no
sign of a sign-in going on and no evidence (the `judge` decision) is sent to be judged,
at most 2 pages for the whole watch, counted apart from the effect step's own.
`signed-in` completes, `rejected` ends the login `credential-rejected`, and any other
answer, a refusal such as `already-judged` or a spent budget leaves it watched, logged
as a warning; a judge that adds a handler is never followed while watched. A login whose
result settled as unknown keeps its checks of later pages as before (its next step, a
handler, a continuation), and its judged pages also count against the watch's 2. While a
login is watched, each later page of its tab gets the origin's first steps to watch for.
A watched login never signed in, so one of them ready in a new document is no logout
([ADR 0021 D](adr/0021-account-choice-outside-settings.md); owner, 2026-10-13): the
login ends (`WATCH_ENDED` with `abandoned`) as `blocked` with `challenge-abandoned` from
a `challenge`, or `watch-abandoned` from a result settled as unknown, and its record is
forgotten. Only that tab asks (`pateat.login-stopped-asks.v1`, as after a login stopped
after a submission) and, with one account to use, fills without pressing anything; the
site's other tabs log in as before. A first step ready in a new top-level document of
another tab of the site, first seen by the worker after the watch began, ends it the
same way, so a person who starts over in a new tab logs in there rather than being
refused `origin-busy`, and the watched tab asks if its own first step shows again. When
the watch is over, the next page of the tab ends the login where it stopped
(`WATCH_ENDED`: `blocked` with `challenge` or `unknown-submit`) without changing the
record's last change time, so it holds the site only until 5 minutes after that time; a
login stopped after a submission is then handled as before, also on a page the watch
already followed, other than the one it began in. A restart keeps the watch. Leaving the
origin without a confirmed sign-in ends it the same way where it stopped, not
`left-origin`, so its first step showing again later in the tab is no logout either
(2026-10-13). Newer settings end it
`policy-changed` only when they no longer allow its account on the page; otherwise the
watch takes over their revision, since it only reads, so another site's saved account
choice does not end it. A login in a frame and the `passkey` route still end `challenge`
at once. The attempt store is `pateat.login-attempts.v4`.

Chrome use coordination is an open integration gate. Expose a scoped status
contract for a future trusted consumer, but do not assume Chrome use already
waits for it. Coexistence tests must include overlapping actions; avoid claiming
race-free operation before a wait/ownership mechanism is established.

## Extension icon

The owner chose the logo on 2026-10-11: a Roman arch whose keystone completes it,
after the Latin name ("let it be open"). The arch is green `#1C9A7E`, the keystone
gold `#E0A100`, and the background is transparent. Both colors stay visible on light
and dark Chrome toolbars; the mark avoids blue and shield shapes so it is not
confused with the official Bitwarden extension. The source is
`apps/extension/icons/icon.svg`; `mise run render:icons` writes the committed PNG files
in `apps/extension/public/icon/`, drawing the 128 px store icon at 96 px with
transparent padding.

Pateat shows no Bitwarden logo. Bitwarden's
[trademark guidelines](https://github.com/bitwarden/server/blob/main/TRADEMARK_GUIDELINES.md)
allow its logos only with written permission, and open-source licences grant no
trademark rights. Pateat names Bitwarden only in plain text, to say which vault it
connects to, and marks Bitwarden in the settings page with the generic `lucide-react`
`Shield` icon (owner, 2026-10-13 15:02 UTC); the shield stands for Bitwarden there, so
Pateat's own mark still avoids shield shapes. This follows independent
Bitwarden-compatible projects checked on 2026-10-13:
[Vaultwarden](https://github.com/dani-garcia/vaultwarden/blob/main/README.md), which
renamed from bitwarden_rs to avoid trademark and branding issues, and
[Keyguard](https://github.com/AChep/keyguard-app/blob/master/README.md) use their own
logos and state that they are not associated with Bitwarden, Inc. Small launcher plugins
such as the
[Raycast extension](https://github.com/raycast/extensions/blob/main/extensions/bitwarden/package.json)
use the Bitwarden shield without any stated permission, although the guidelines
require it. Using the logo needs Bitwarden's written permission first.

The toolbar icon shows whether Pateat can log in without asking for a password, as the
Bitwarden extension shows its lock state (owner-approved). Unlocked shows the logo;
locked draws the whole mark gray `#8A8F98` with the keystone lifted out of the arch
(`apps/extension/icons/icon-locked.svg`). The icon is unlocked only when at least one
vault connection exists and every configured connection holds an active local vault
record, so automatic unlock needs no password; otherwise, including an unreadable
record, it is locked. The manifest's default action icon is the locked one; the worker
re-reads the records when it starts, at browser start, after each vault record write and
after each settings-page connection request
(`apps/extension/src/connections/action-icon.ts`). The owner confirmed the switch in
installed Chrome on 2026-10-11 (main 863ad90 or later). After a full Chrome 154 restart
with automatic unlock on main f7d3cf5, the icon showed the logo with no visible gray
phase; this is expected, because the built manifest's `action.default_icon` is the
locked icon and the worker replaces it as soon as it reads the active records.

The toolbar badge shows, per tab, a waiting account choice, a model request in flight,
and how the last login ended ([ADR 0038](adr/0038-login-status-badge.md);
`apps/extension/src/login/badge.ts`). It replaced a spinning toolbar icon the owner had
chosen at 14:04 UTC on 2026-10-13 and found unexpected in installed Chrome at 18:56 UTC.
While a first page or a continuation is sent for generation, a sign-in entry page is
sent, or a page is sent to the judge, the badge cycles braille frames (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, 100
ms each) on indigo, from the send until the request returns, and at most two minutes,
longer than the 90-second inference timeout. A failed login, or a refusal that stops one
before it starts such as `no-route` for an item with neither a password nor a passkey,
shows a red `!` until the tab starts another login, its top page loads another origin or
it closes; a signed-in login shows a green `✓`, and a login whose result is unknown a
yellow `!`, each for 4 seconds. A waiting choice wins over all of them. Each write sends
only the fields that changed, writes for one tab are applied in order, the badge is
written again after each page load because Chrome resets tab-specific badges on
navigation, and a tab Chrome replaces (`tabs.onReplaced`) keeps its badge. Results and
spinning tabs are kept in `chrome.storage.session`, so a restarted worker redraws them.
Each frame is an extension API call, so a spin keeps the worker running, at most for
those two minutes; the model call keeps it running anyway.

The service's pages use the same unlocked logo as their favicon (owner request,
2026-10-12). The owner web UI links the SVG, which Vite emits under `/manage/assets/`
behind the same Access check as the page. The Worker's own HTML pages
(`services/api/src/pages.ts`, including `/pair/signed-in` and error pages) inline it as
a `data:` URL and allow only `img-src data:`, so the icon never needs a request to a
path that another Access application, or none, guards.

## Page styles and theme

The extension's pages (settings, popup, diagnostics and the passkey chooser) and the
owner web UI take their colors, type, radii and focus ring from the
[Pateat design system](https://claude.ai/artifact/WRXAnVi9RDw9cVWccy2fxJ) (owner,
2026-10-12 20:53 UTC). `apps/extension/entrypoints/options/style.css` and
`services/api/web/styles.css` each define its tokens as CSS custom properties and
Tailwind colors, with each light/dark color pair written once using `light-dark()`.
`color-scheme: light dark` follows the browser, and the explicit theme overrides set
only `color-scheme`; shadow colors are paired separately from their shapes. The Worker's
script-free pages (`services/api/src/pages.ts`: `/pair/signed-in`, the Access and error
pages and `/manage/claude`) inline a small stylesheet,
`services/api/src/page-styles.ts`, with the same tokens, the logo beside "Pateat" and
the page in one panel. `tests/options/design-tokens.test.tsx` compares the three token
copies and checks their resolved light and dark palettes, including shadows.

Each page has light and dark themes. The extension's pages and the owner web UI have a
Theme select (Browser setting, Light, Dark): at the foot of the extension settings
page's section list and in the owner web UI's footer (owner, 2026-10-12 20:54 UTC); the
Worker's script-free pages always follow the browser. Browser setting, the default,
follows the browser's `prefers-color-scheme`. The choice is presentation only: it is
kept in the program's own `localStorage` under `pateat.theme`, not in `chrome.storage`,
the service or sync, so the extension and the owner web UI keep separate choices and
each browser profile has its own. A page applies the stored choice before it renders, as
a `data-theme` attribute on the root element, and an open page follows a change made on
another page of the same program through the `storage` event. Because neither program's
pages allow inline script (the MV3 policy, and the owner web UI's `script-src 'self'`),
the choice is applied from the page's module, so a page whose stored choice differs from
the browser's scheme may paint one frame in the browser's scheme first.

Deleting a Bitwarden connection in settings asks in a modal Base UI `AlertDialog`. It
names the connection and explains removal of its local vault cache, unlock key and sync
sign-in. Focus starts on **Keep connection**; Keep and Escape close without deleting,
report "Connection kept." and return focus to that row's **More** button. Backdrop
clicks leave the question open, and the page behind it is blocked until it closes.
**Delete connection** runs the existing local deletion operation and reports its result
in the settings status line. The owner approved this change on 2026-10-14 at 08:40 UTC
([adopted platform features](research/2026-10-14-platform-feature-candidates.md)). The
`/manage` recipe revoke and diagnostics **Clear logs** confirmations remain inline;
whether they follow is a separate owner decision.

## Diagnostics

`diagnostics.html`, linked from the settings page, shows per-device versions and state
for bug reports ([ADR 0019](adr/0019-local-diagnostics-and-logs.md)). The page asks the
service worker for `{ version: 1, type: "diagnostics.status" }`; the worker answers only
that exact page URL and returns a value-free summary
(`apps/extension/src/diagnostics/`):

- the manifest version with the build revision (`PATEAT_REVISION` in CI, otherwise the
  checkout's `git rev-parse HEAD`), build mode, the pinned Bitwarden SDK version and the
  Bitwarden protocol label; the page adds the Chrome version and install type
  (`development` is shown as `unpacked install (development)`);
- the platform, granted API permissions, the manifest's host patterns (other granted
  origins are only counted) and the toolbar icon state;
- per Bitwarden connection, an HMAC pseudonym of its ID (`bitwarden:5c1e9a`, keyed by a
  non-extractable per-device key in IndexedDB `pateat.diagnostics.v1`), the environment
  kind, the server from `GET {api}/config` (the release number of its `version`
  without any suffix, and, from `server`, whether it is Bitwarden, Vaultwarden or
  another third-party server, whose version is the Bitwarden version it is compatible
  with), setup state, automatic unlock, sync sign-in, the vault record's accepted time
  and read failure code, item counts by type (trash excluded) while the vault is
  unlocked, the unlock KDF family (`PBKDF2` or `Argon2id`) and, on the page only, its
  parameters;
- the Pateat service pairing state, `rejected` and `cacheFull`, site access to the
  paired origin, its `/health` revision, the last recipe sync, next scheduled sync,
  settings revision, settings hold and recipe cache size;
- the service's own record from `GET /v1/device` with the device credential: when the
  device was paired, the owner's live recipe count and settings revision, and whether
  recipe generation would run now, in the order a generation call checks it
  (`monthly-limit` or `daily-limit`, then `credentials-not-configured`, then
  `issuer-unavailable` when the issuer settings are missing or the signing key does
  not import, otherwise `ok`), or the reason code when it could not be read;
- setting counts, `storage.local` usage, the log's size and debug state, and checks
  for site access, the crypto host, each vault cache and sync sign-in
  (`refresh-required` is ok with automatic unlock, since the next Sync tries to renew
  the token, and info without it, since Sync needs the stored unlock key), the vault
  copy's age with the last automatic check and its outcome (info; warn when that check
  failed, was rate limited, needs sign-in again or found the account deleted), each
  Bitwarden server's `/config` (warn when it fails or is not checked), service
  reachability, clock skew over 30 s against the service `Date` header, recipe
  generation (info without Claude credentials, warn when the issuer is missing or a
  spend limit is reached), whether the cached recipes and settings revision match the
  service (info when they differ, since the next sync catches up), a recipe sync
  older than 24 hours and the errors and warnings logged in the last 24 hours (warn when
  there is an error, info for warnings only). Reworded states keep the
  raw code in parentheses.

The page lists the checks first, each as a line led by its level's icon with the level
read out to screen readers, then the Version and Settings and storage panels, the
Bitwarden connections and Pateat service panels, and Logs. Values are shown as the
summary has them, in a monospace face.

Computed ages use `Intl.DurationFormat("en", { style: "short" })`, with the selected
unit's display set to `always` so zero remains visible. They floor to minutes below
one hour (`0 min`, `59 min`), hours below 48 hours (`1 hr`, `47 hr`), then days
(`2 days`); future times count as `0 min`. Recipe sync overdue labels floor to hours
even beyond 48 hours, including `0 hr` during the first overdue hour. The locale stays
English until phase 3 localisation passes the UI locale. Fixed phrases such as
"in the last 24 h" remain unchanged.

The worker fetches `/health` only for a paired service with site access, and
`/v1/device` only then and while the service has not rejected the credential, with a 5 s
timeout; that route reads the database and imports the signing key, but signs nothing
and never exchanges a Claude token. It fetches `{api}/config` only for an enabled
connection whose provider permission sync also requires, with a 5 s timeout and no
credentials. It never reads the config's `environment` (host URLs) or a third-party
server's name other than Vaultwarden. **Copy for bug report** shows the exact text
before copying it; that text leaves out the unlock KDF parameters. It ends with the
log's last update (`Updated <time> from <revision>`), its warnings and errors of the
last 24 hours (newest 10, one line each with the time, level, event and allowlisted
field values) and the count of passkey requests left to the browser in those 24 hours by
reason. The worker builds these lines from the log and always numbers sites and recipes
in them as a download does when they are hidden, but separately, so `site-1` there can
be another site than in **Download logs**. Labels, emails, item names and IDs, URLs and
host names are never part of the summary.

The owner checked the page in installed Chrome on 2026-10-11 against production
(extension main 8581f1d, service e48b4e7). The Bitwarden cloud server showed as
`Bitwarden server 2026.9.2`, and the report carried only the KDF family. The service
record matched `/manage/recipes` and the local settings revision, with recipe generation
`ok`. A settings-page Sync logged `vault.sync` with outcome `ready`. No email, label,
item name, host or ID appeared.

### Local log

The service worker keeps a log in the `entries` store of the same IndexedDB database
(`apps/extension/src/diagnostics/log.ts`). Only the worker writes it, one transaction
per entry, and mirrors each entry to its console as `Pateat <event> {fields}`. Each
event allowlists its fields by kind; other fields are dropped, a field failing its
kind's check is left out and a string over 512 characters becomes `"[truncated]"`.

| Event | Level | Fields |
| --- | --- | --- |
| `runtime.started` | debug | build revision |
| `runtime.updated` | info | previous and new build revision, version |
| `vault.state` | warn for `unavailable`, `review-required` or `reauthentication-required`, even at a worker's first sight; else debug at the first sight, then info | connection pseudonym, state, previous state, sync sign-in, `synced` when a new snapshot was accepted |
| `vault.sync` | info for a result, including `unchanged` since the person pressed Sync, and for `cancelled`, else warn | connection pseudonym, the settings-page Sync's result kind or error code, and the account mismatch check when there is one |
| `vault.check` | debug for `unchanged`, `skipped` and the same outcome as the connection's last stored check other than `synced`, also after the worker restarted (such as a sign-in that still needs the password, where no request is sent); otherwise info for `synced` and `deferred` (the replacement waits for a login or passkey request), else warn | connection pseudonym and the automatic check's outcome (ADR 0025): `unchanged`, `synced`, `deferred`, `rate-limited`, `failed`, `reauthentication-required`, `account-deleted` or `skipped` |
| `vault.refresh` | debug for `refreshed`, info for `not-sent`, else warn | connection pseudonym; `not-sent` when no usable session was refreshed and no refresh was sent, with why: `no-session`, `no-refresh-token`, `claimed` (another refresh in this worker holds it), `provider-permission-required`, `cancelled` or the store's error code; `refreshed`, `restored` (the session was put back after a network failure, timeout, 429 or 5xx), `rejected`, `account-mismatch` or `failed` (a non-retryable error drops the claim's refresh token so the sync sign-in needs the password; a store error leaves the claim to resume; a conflict means forget or a password sign-in replaced it); the transport or store error code and HTTP status when there is one |
| `service.sync` | debug for `synced`, `incomplete`, `not-connected` unless a recipe was added, updated or removed, then info; info for `unreachable`, since a device offline for a while would otherwise fill the warnings, and `busy` (a settings write that waits for a login, a sync superseded by a later one, or attempts that ran out); else warn | recipe and settings sync outcome; `full`, or `recipes` for a recipes-only run after a judged page; recipes added, updated and removed in the cache |
| `settings.changed` | info | `synced` (a settings sync wrote local settings) or `saved` (the settings page); the settings revision when the entry is written. Running logins and passkey requests stop; a watched login stops only if the new settings no longer allow its account |
| `login.attempt` | debug when a new page resumes the attempt without changing its state or outcome; otherwise info for `authenticated` and `retryable`, for a route change and for the end of a fill-only login after a logout, warn for other `blocked`, for `watching` and when the result settles as unknown (`unknown-submit`, marked `settled`), so a login that did not finish counts as a warning, info for `document-gone` with a reason other than `no-receiver` and for `captcha-shown`, else debug | origin, recipe ID and revision (`recipeRevision`), route and `password` variant, state, step, step count, the current step's kind (`fill`, `click`, `wait`, `assert`) and effect (`prepare`, `advance`, `submit`), the entered handler the step belongs to, outcome (`challenge-abandoned` or `watch-abandoned` when a watched login's first step showed again before it signed in, [ADR 0027](adr/0027-per-account-login-routes.md#watching-after-a-challenge)); for `policy-changed`, its cause and a refused plan's reason; else `fill-only` as the reason for a login that only fills the form after a logout (ADR 0021 D); `routeChange` when the login changed route ([ADR 0034](adr/0034-answer-page-passkey-requests.md)): `page-request` (to the `passkey` route, because the page asked for a passkey), or back to the `password` route as `request-missing`, `answer-failed`, `sign-in-rejected` or `sign-in-shown`; `stop` (`password`) on every entry of a login that stops before its item's missing password, also one whose stop lies just past its route's last step, and `password-empty` as the reason when it ends `challenge` at that stop, or `password-empty:<why>` (such as `password-empty:fills-lacking`) when a continuation of a stop past the plan's last step could not take the stop over ([ADR 0036](adr/0036-passkey-after-the-identifier.md)); the item's lack of a password shows as the `no-route` detail does, never a value. A result that settles as unknown (`unknown-submit`) on a page that still shows a sign-in element of the route, with no failure that acted (S1, [ADR 0029](adr/0029-local-sign-in-state.md)), names `sign-in-shown` as its `cause`. A login that failed or was cancelled names its `cause` when one is known (a plain wait timeout or a cancel without a reason has none): the step's elements did not show in time (`elements-timeout`), a code page neither submitted the code nor took the click (`code-not-submitted`), no operation could be built (`no-operation`), the login's item could not answer the page's passkey request (`answer-failed`), the operation no longer validated (`operation-invalid`), a field had no vault binding (`slot-unbound`), the page did not answer or its answer failed its check (`no-answer`), a code page said it submitted the code itself but no check confirmed it (`page-submitted`), the page showed a CAPTCHA, so the click was left to the person and the attempt waits in `awaiting-result` (`captcha-shown`), the document stopped answering, as when a submit replaced it, so the attempt waits in `reconciling` for the next document to resume it (`document-gone`, with what the browser said as the reason: `no-receiver` when no listener was left or the page went into the back/forward cache, logged at debug as a submit's usual navigation, else `port-closed` when the listener did not answer or `send-failed`, logged at info as they may hide a fault), or the page's own reason: the worker did not authorize the step (`not-authorized`), the document was cancelled (`document-cancelled`), the operation was used (`operation-used`) or expired (`operation-expired`), the page moved to another path (`page-changed`, also with a `timeout` outcome when the wait ended on another path), a field changed under the fill (`field-changed`), the step threw (`threw`), the form was replaced (`form-replaced`), the target is missing or not writable (`target-missing`), the form changed before a click (`form-changed`), an `assert` did not hold (`assert-failed`), the step was sent values it does not fill (`unexpected-values`), its fields are in different forms (`fields-split`), an input refused its secret (`secret-refused`), the page's inputs have no value setter (`unsupported-input`), or a code field's submission watch could not start (`code-watch-failed`); `unconfirmed` for an undecided completion without a confirmed sign-in (ADR 0029) |
| `login.handler` | info | origin, recipe ID and revision (`recipeRevision`), handler index, kind, step count; `entered`, `shown-again` (left to the person after this login ran it), `missing-fact` (the item lacks what the handler needs, including a `totp` handler's built-in TOTP field), `code-used` (a `totp` handler in a login that already types a TOTP code) or `no-room` (the attempt's step or submission budget is spent) |
| `login.entry` | info for `pressed` and for the first `refused` of each reason on a document, debug for `refused` with `no-return-target` or `in-progress` and for a reason the document already logged, warn for `blocked` ([ADR 0019](adr/0019-local-diagnostics-and-logs.md#amendment-what-the-log-records)'s levels) | a site's sign-in entry ([ADR 0031](adr/0031-sign-in-entry-pages.md)): origin, recipe ID and revision (`recipeRevision`) and outcome. `pressed` when the document answered that it clicked the link. `refused` with the check before the press that failed: `frame`, `storage-unavailable`, `blocked` (the revision is blocked on this device), `tab-unavailable` (the tab could not be read), `page-changed`, `recipe-changed`, `no-return-target` (the URL names no other path of the site), `no-site`, `site-record` (the tab ran a login of the site), `site-held` (another tab's login holds it), `logged-out` (a tab keeps a logout of it), `logout-clicked` (a control that logs out was clicked on the site in this tab, ADR 0021 D), `press-limit` (the tab pressed an entry in the last 10 minutes), `settings-unavailable`, `site-excluded`, `destination-excluded`, `no-vault-match`, `in-progress` (another document of the tab is being pressed), `no-answer`, `target-missing`, `target-ambiguous`, the element's refusal (`not-link`, `script-link`, `hidden`, `no-text`, `new-window`, `download`), the `href`'s (`link-not-https`, `link-off-site`, `link-query-off-site`, `link-same-page`), `target-changed`, `cancelled`, `unconfirmed` (the document never answered the press, which still counts against the tab's limit) or `exception`. `blocked` with why the page after the press blocked the revision: `left-site`, `no-sign-in` or `sign-up`, and the detail `storage-unavailable` when the block holds in this worker only |
| `login.state` | debug for a later page of an attempt that already settled as unknown, else info | origin, recipe ID and revision (`recipeRevision`), route; the page signs of [ADR 0029](adr/0029-local-sign-in-state.md) that show, as flags: a sign-in element of the route (`s1`), a password input not for a new password and not in a form with two or more shown password inputs (`s2`), a code input (`s3`), a CAPTCHA widget (`s4`), a passkey request of the top document after the step, outside conditional mediation (`s5`), a new invalid mark on the step's sign-in inputs (`f1`) or new alert text, read as the fill check reads it (`f2`), next to the sign-in fields in the submitted document, or, with `reshown`, any invalid mark on the route's sign-in inputs or any text of an alert next to the form in the first new top document after a password submission, within 30 seconds of it, that shows the sign-in form again, a signed-in marker on any path (`e1`), the username in the header or navigation (`e2`), the return target the sign-in page's URL named (`e3`); and what the ADR would do (`rejected`, `unknown`, `continuing`, `signed-in`, `judge`); `settled` for a later page of an attempt that already settled as unknown; `reshown` when S1 holds in the first new top document after the attempt's password submission, announced within 30 seconds of it, where `rejected` needs no CAPTCHA (`s4`) and also ends a watched login. When S1 holds without `reshown`, `reshownMiss` says why: no effect step of the attempt is known (`no-effect`, as after a worker restart), the last one asked for a passkey (`passkey-step`) or did not submit (`not-submit`, as an `advance`), the page is the document the step ran in (`same-document`), no other top document came within 30 seconds of the step (`late`), or the page is a later document than the first one that did (`later-document`). With `reshown` and no F2, `alertMiss` says why no alert next to the form counted: none outside the sign-in inputs shows text (`no-alert`), none of the route's sign-in elements is a single shown writable input (`no-input`), or the first rule failed by the region closest to counting: its nearest common container with the form is the body or the root (`body`), or holds page chrome (`chrome`), another form that asks for input (`other-form`) or the main area (`main`). Both are codes only, never page text. Logged for a page after an effect step that no check explained, before the judge is asked. On the `password` route a `signed-in` page is read again a second later, and a second apart while it loads (at most ten times), and the last reading is the one logged; the other decisions but `unknown` are read again the same way, and so is an `unknown` reading of the sign-in form shown again with its password input and no other sign, before the tab asks again (ADR 0021 D). A confirmed `signed-in` completes the login without the judge and a confirmed `rejected` ends it `credential-rejected`; the rest go to the judge as described above (ADR 0029). E1 reads the recipe's signed-in markers as the completion check does: a marker counts on any path, but not while one of its `absent` elements is there, even hidden. A login in a frame is not read |
| `login.move` | info | a login's tab moved to a page of another origin that did not complete it ([ADR 0022](adr/0022-login-attempts-per-tab-and-origin.md)), logged unless the judge decided the move (`recipe.judge` with `moved`): that page's origin, recipe ID and revision (`recipeRevision`), route, and why: no step or second factor fits the move (`no-factor`, as a move to another site right after the password step or more than 30 seconds after the second factor), the account has no username to look for (`no-username`), the page could not be read (`unreadable`), shows a password field, code input or CAPTCHA (`sign-in-shown`) or asked for a passkey since the step (`passkey-request`), or never read quiet twice (`not-quiet`); `frame` when a frame of the new page announced first and ended the login. `page-gone` with `kept` when the page went away before its quiet readings answered, as a redirect through another page does: the login is not ended there, and the tab's next page is checked instead, which must still come within the same 30 seconds; a page that goes away while it is judged still ends the login. `passkey-request` with `kept` when the page is of another origin of the site and asked for a passkey at most 30 seconds after the step: the login waits for the tab's next page, which a passkey answered there with the login's own item lets complete it |
| `login.refused` | info for the first time a reason shows on a login-related page (the tab's page when its origin has a recipe or a login is in progress in the tab, or a frame whose own origin has a recipe, such as a login form embedded in the page); debug for the same reason again on the same document and path (remembered in session storage for the last 256 pages until their tab closes, so a restarted worker's reconnect of every page does not log it again), for a page that is not login-related (such as `recipe-not-found` on an origin without a recipe), for `stale-document` and `duplicate-document` (a document announcing again while it carries a login), and for `tab-busy` in a frame (a held tab refuses every frame on its page, such as ad frames); `stale-document` with `gave-up` is info | origin, reason, `frame` for a frame; for `account-ambiguous` and `logged-out`, how many accounts the tab may ask with (`candidates`, at most 100 for `logged-out`); `no-uri-match` as the detail of `default-not-set` when no vault item's URI matches the page, or of `item-origin-mismatch` when the saved default's item no longer matches it; `site-excluded`, `no-site-access` or `settings-unavailable` when the tab's page of a login-related site is not admitted; `stale-document` with `gave-up` when a document's fourth try in a row to start (about half a second apart, each within 2 s of the last answer) was stale and it waits until its form goes, an estimate since the worker does not see the form go and come back between tries; for `no-route`, the fact the first variant missed (`password-empty`, with why the login did not go on to a passkey after a colon when the item has no password, as `password-empty:no-passkey`; `password-not-allowed`, `no-totp` or `passkey-unresolved`), or on a recipe with several `password` variants the first variant's other reason, as its detail, also for a chooser login refused when its route is planned again for the list's `other` button ([ADR 0028](adr/0028-account-chooser-login-pages.md)); for `logged-out`, which tab logged out (`this-tab` or `other-tab`), `rejected` when the site rejected this tab's login, or `stopped-login` when this tab's own login stopped after a submission and its form showed again, or its watched login ended `challenge-abandoned` or `watch-abandoned`; `entry-blocked` for the page after a sign-in entry press that blocked the entry recipe's revision (ADR 0031), on every announcement of that document; `not-started` when a page of an origin with a recipe shows a visible password, username or one-time-code input for 10 seconds without a ready first step and only watches, once per document and path, with why: the tab's earlier login of the origin finished and this form is not a recipe's first step on its path, so it is not taken as a logout (`logged-in`), a recipe starts on this path but its first step's elements are not found (`first-step-missing`), or the origin's recipes start only on other paths (`no-recipe-on-path`), or the tab's login of the origin stopped after a submission and the page watches for its form (`stopped-login`); `not-started` with `stopped-login` also, once per document and path, for a page that resumes the tab's login that stopped after a submission while it still holds the site (the 5-minute hold of ADR 0022) and does nothing; `reconnect-failed` when a page that a returned recipe should start could not be asked to announce again, debug when the tab no longer shows that page's origin and path |
| `login.start` | info | origin, recipe ID and revision (`recipeRevision`), route and `password` variant of a new login; how its account was chosen (`default` for the saved site default, `match` for the only provider URI match, `pick` for a pick in the popup); for `match` the candidate count and the item as a pseudonym; for a login that only fills the page after a logout (`fillOnly`), the count of accounts the tab asks with; for a login on a chooser's list ([ADR 0028](adr/0028-account-chooser-login-pages.md)), what it clicks there (`list`: `entry`, `continue`, `other`), or `none` when it ends `account-not-listed`, or `other-shown` when the list's path showed the `other` branch's form instead and nothing was clicked, then with what the list showed, never a name or address: the chosen username's kind (`listUsername`: `email`, `name` or `empty`), the entries showing an address, or for a name the innermost entry-like controls (`listEntries`), for an address the entries whose address is masked (`listMasked`), shows the username's domain (`listSameDomain`) or fits the username before masked ones are weighed against the other items (`listFits`), and without entries why a text with an `@` is none (`listEntryMiss`, as `not-a-list` names it), the short texts beside buttons (`listBeside`), for a name the controls whose whole text names it (`listNamed`), and the chooser's `other` and `continue` buttons (`listOther`, `listContinue`: `none` when the recipe has none, else `missing`, `one` or `many` elements found) |
| `login.logout` | info | origin, recipe ID and revision (`recipeRevision`), when the recipe's first step shows again in the tab's page after a finished login (ADR 0021 D); never for a watched login (ADR 0027) whose first step shows again, which never signed in and ends `challenge-abandoned` or `watch-abandoned` instead (`login.attempt`); `rejected` when the login ended `credential-rejected`, or its page was the sign-in form shown again with its password input and no other sign (no S3, S4, S5 or E sign) in the first new document after its password submission; then the tab asks at once, also on a path where no recipe starts; `clicked`, without a recipe, when the first step showed in a tab after a control that logs out was clicked there on the site and the tab had no login of its own to release (ADR 0021 D) |
| `login.choice` | info | origin and whether the account a login authenticated with was saved afterwards: `saved`, `already-saved`, or why not: `account-changed`, `login-in-progress` (another login runs, and saving would stop it), `settings-unavailable` or `write-failed`; logged only when the login's site default or binding was not saved yet: an account found by URI match, one picked to become the default, or a saved default whose binding is new |
| `login.popup` | info; debug for `none` without a login record or a refused page | origin and what the toolbar popup was told about the tab's account choice (ADR 0021), logged when that changes for the tab: `offered` with how many accounts (`candidates`), why the tab asks after a logout (`logout`: `this-tab`, `rejected`, `other-tab` or `stopped-login`), `held`, and `rejectedElsewhere` when the site rejected another tab's login that still asks, so the popup chooses no account, or `none`; the tab's login record for the origin as `recordState` and `recordOutcome`, and the page's last refusal reason as `pageReason`, which together say why nothing was offered |
| `login.exception` | warn | origin, recipe ID and revision (`recipeRevision`), route, the state the login was left in and its step, the exception's class name, its message only when it is a Pateat error code, and up to five of its stack positions inside the extension's own files; logged when an exception stops a running login. A document that stops answering is no exception: `login.attempt` logs it with `document-gone` |
| `recipe.generate` | debug for `skipped` with `no-vault-match`, `not-connected`, `not-a-list`, `no-listed-account` or `nothing-offered`, warn for `failed`, else info | origin, outcome (`sent` when the page goes out, then `recipe`, `abstained`, `failed`, `unavailable`, `skipped`) and its reason: the abstention, failure or unavailable code, `device-rejected`, `error` for a thrown error, or why nothing was sent (`sending`, `sent`, `no-vault-match` with a detail (`no-item`, `no-slots`, `no-connection`, `incomplete-item`, `site-excluded`, `invalid-url`), `vault-unavailable` with the vault's reason (or `settings`, `tab`, `error`), `connection-disabled` when every vault connection is turned off, `not-a-list` with why a page whose text holds an `@` is not a list of accounts (ADR 0028: `aria-hidden`, `inert`, `hidden`, `not-rendered`, `page-chrome`, `inside-control`, `no-entry`, `unread-text`, `split-address`), `no-listed-account` when no short text beside the buttons named an item (`no-name-match` when the page also shows no control to sign in with another account; when words for another account show but no such control counts, why: for a usable control with the words, `other-holds-name` when its text or label holds a shown name, `other-not-clickable` when a list click could not press it, `other-text-long` when its text is over 64 characters, `other-label-only` when only an `aria-label` has them; for words outside every usable control, `other-in-chrome` in page chrome, `other-not-entry` with nothing shown, enabled and clickable around them, `other-not-control` in a clickable element that is not an innermost control; or the vault's reason), or for any list on a page whose path holds a matching item's username (`username-in-path`), or for a list by email when no matching item's username is an email and the page shows no control for another account (`no-email-username`), `nothing-offered` when a page that could be sent showed, by the end of the 10-second wait after loading, no list of accounts, sign-in entry or identifier input (`no-list`), was the page right after a submitted password form (`after-sign-in`), or showed a sign-in input only at the end of the wait (`sign-in-shown`), `field-not-described` for the page after a final `advance` step whose description lacks the sign-in input it qualified with (ADR 0018), `incomplete-observation` with why as `detail`: for an incomplete description the extractor's first cause, in this order for a login page `shadow-field` (a fillable field in any shadow root), `shadow-control` (another control in a shadow root inside a login form), `unfillable-field` (a transparent or tiny, read-only or disabled fillable field of a login form; one transparent only while it or an ancestor fades in from opacity 0 counts as opaque), `unsupported-control` (a select, radio button, text area or other input the executor cannot act on in a login form), `unlocated-field`, `unlocated-checkbox` and `unlocated-button` (a login form's field, checkbox or button without a locator that names it alone, including an icon button in a form with no other button to submit with), `too-many-candidates` (more than 48), and for a list of accounts `shadow-field`, `too-many-accounts` (more than eight), `unlisted-accounts` (an account whose text could not be sent), `too-many-elements` (more than the 4,000 elements the list scan reads) and `too-many-controls` (more than eight other controls outside page chrome, the page's footer included), or `incomplete` without one; `invalid-observation` for a description that fails its schema; for a complete one `origin-changed` or `path-changed` when it describes another origin or path than the document's, `list-mismatch` when a page announced as a list is described without accounts or another page with them, and for a page offered as a site's sign-in entry `not-entry` when it shows a field or lists accounts; the content script's refusal (`no-candidates` for no field or nothing in a login form to locate or act on, `no-locator` for a login form whose controls could not be located, `unsupported-page` for a description that fails its schema or a list whose raw path holds a listed name (a path that may carry a token is sent with `[id]` instead, ADR 0039), `extract-error` when the extractor threw, `cancelled` for a cancelled document), `extract-failed` for an answer that fails its check or never came, `unreachable` when the page went away or stopped answering before it could be read, as during a navigation, with how as `detail` (`no-receiver`, `port-closed`, `send-failed`), `exception` when reading the vault for it, or anything else, threw while the page still shows, `no-slots`, `not-connected`, `storage-unavailable`, `username-unread` when a matching item's username could not be read to hide it, `username-shown` when a username shows in the page's path or a field's locator, where it cannot be hidden, for the page after a final `advance` step `scope-incomplete` while the vault match could not evaluate every item, `after-sign-in` for the tab's next page after a submitted password form when it lists accounts, offers an entry or asks for an identifier alone, `signed-in-elsewhere` for a list of accounts while another tab's login of the origin authenticated less than an hour ago and neither this tab clicked a control that logs out in the last 10 minutes nor any tab of the origin asks after a logout, which also keeps a sign-in entry offered beside the list from being sent (ADR 0028), and for a page offered as a site's sign-in entry `no-return-target`, `site-record`, `logged-out` and `no-entry-link` when its description lists no link, and for a form on a chooser's path `no-account-field` when it has no field for the account and `list-shown` when the list shows by then); `page` (also for a page that asks for an account identifier alone, [ADR 0016](adr/0016-recipe-generation-trigger.md#pages-that-ask-for-an-identifier-alone)), `accounts` for a list of accounts (ADR 0028), `entry` for a page sent as a site's sign-in entry (ADR 0031), or `other` for a form on a chooser's path sent as its `other` branch's first page (ADR 0028), with the chooser's ID and revision once the page is sent; for `invalid-output`, the check that refused the model's output (`json`, `schema` or `plan`), the plan check's code or the output format's issue, and for a format issue where in the output it was; a page that is not sent is logged once per document, with the last reason after up to three reads a second apart; for the page after a final `advance` step, the recipe ID and the revision it continues, and for a returned revision whether this login took it over, left out when the page that asked was left before the answer |
| `recipe.judge` | warn for `retry` after a request that failed (any reason but `not-connected`, where nothing was sent), for an undecided answer that completed the login (`completed`, ADR 0029) or that did not complete it only because a disabled field was left out or the login stops before its item's missing password (`notCompleted`), and for a watched login's `unclear` or `challenge` or its `not-sent` `page-limit`, which leave it without a result (ADR 0027), else info; `unclear` stays info even with a failure code such as `timeout`, since it also covers permanent refusals such as `already-judged`, and its reason tells them apart; `sent` is logged just before the request leaves the device and is kept because it is all that is left when no answer comes | origin, recipe ID and revision (`recipeRevision`), route; `sent` when the page goes out, then the verdict (`signed-in`, `rejected`, `challenge`, `unclear`, `retry`); for `unclear` and `retry`, the transport, service or model code (for example `already-judged`, `busy`, `timeout`); for a returned revision, whether this login took it over; `watched` for a page of a watched login; `completed` when the judge did not decide a page with no sign and no evidence and the login completed on it; `moved` for a page of another origin of the site that a `password` login's tab moved to right after the submission, or of another site right after a TOTP code or a passkey answered after the password, judged once, whose verdict alone decides the login (ADR 0022), with that page's origin; `disabledLeftOut` on each entry of a page whose description left out a disabled field that may not be a sign-in field, which completes the login only on `signed-in`, and `notCompleted` (`disabled-left-out`) when an undecided answer would otherwise have completed it (ADR 0029), or `password-empty` for a login that stops before its item's missing password, which ends `challenge` instead ([ADR 0036](adr/0036-passkey-after-the-identifier.md)); `stop` (`password`) on each entry of the page judged at such a login's stop for a passkey button beside the password field, `not-sent` with `stop-judged` when the attempt sent it already, or with `chooser` for a chooser login's stop, which the service does not judge; `not-sent` when the page after an effect step is not sent to the judge, with why: the step's two pages, or the watch's, were already sent (`page-limit`), a sign-in field of the route still shows on a sign-in path (`sign-in-shown`), a signed-in marker shows but does not prove the sign-in, as more than once or beside one of its `absent` elements (`marker-shown`), a field in a shadow root (`shadow-field`), one that cannot be filled and may be a sign-in field (`unfillable-field`: a password or email input, one with any autocomplete token the description carries other than `off`, such as `username`, `current-password`, `one-time-code` or a personal-data token such as `tel`, or a short numeric field; other read-only, disabled, transparent or tiny fields, as a read-only date picker, are left out), one that may be a sign-in field without a usable locator, as above, except a password field of a form with two or more of them or for a new password (`unlocated-field`; other fields without one are left out), more than 48 fields (`too-many-fields`), nothing to describe (`no-candidates`), a description that fails its schema (`unsupported-page`; a path that may carry a token is sent with `[id]` instead, as on every page since ADR 0039), an extractor that threw (`extract-error`), a response that fails its check (`invalid-page`), a cancelled login (`cancelled`), a page that changed meanwhile (`page-changed`) or could not be asked (`unreachable`), a username that could not be read to hide it (`username-unread`) or that shows where it cannot be hidden (`username-shown`), a sign-in page after a recipe's final `advance` step, which is sent to continue the recipe instead (`continuation`), or, for a `moved` page, a recipe revision no longer at hand (`recipe-unavailable`) or no paired service (`no-service`) |
| `passkey.request` | info | the passkey report described in [development](development.md#why-a-passkey-request-was-delegated) |
| `passkey.create` | info | the registration check described in [development](development.md#why-a-passkey-request-was-delegated) |
| `error.unhandled` | error | `error` or `rejection`, class name, message only when it is a Pateat error code, up to five `file.js:line:column` positions inside the extension |
| `log.dropped` | warn; debug when only `debug` events were dropped | origin, the dropped event's name (`dropped`) and how many of it were dropped over the page limit |
| `log.debug` | info | whether debug logging was turned on or off, and when it ends |

The login, judgement, handler and generation events also carry `url`, the tab's page URL
as of its last announcement, for an event on that page's own origin and not about a
frame, including a login running in a frame of the same site. Only its path and the
names of its query's and fragment's parameters are kept, never their values, and only
when the origin is recorded in full; a pseudonymized origin gets no URL. An OAuth
callback `/callback?code=abc&state=xyz` is kept as `/callback?code=&state=`. A part
without `=` or with an empty value, which may be a token itself (`?<token>`, or a base64
token's `=` padding), and a name that is not 1 to 40 letters, digits, `_`, `.`, `-` or
brackets starting with a letter or `_` are left out. A fragment that is a route
(`#/signin`, `#!/signin`) is kept up to a second `#` with its own query's names, and an
anchor (`#top`) as `#` alone. A result over 512 characters keeps its path alone. A path
segment or a route can still hold a token, as a magic link's can (owner decision,
2026-10-13, after an OpenAI callback's authorization code and state were found in the
log). A line an older build stored with values stays on the device and is left out of
downloads, unless the value was a single token ending in `=` (`/reset?dG9rZW4=`), which
has the same shape as a name. The diagnostics page says so above the download.
**Hide site addresses and recipe IDs** leaves `url` out of a download, and the bug
report's recent lines never carry it.

Connection and item IDs become HMAC pseudonyms. An origin or RP ID is kept in full only
when a site default, binding, excluded site or cached recipe names it; any other
becomes `origin:7d2b91aa` or `rp:7d2b91aa`. The rule applies when the entry is
written, so a site set up later keeps its earlier pseudonymous entries, also in a
download with site addresses included.

The causes of `policy-changed` are `settings-synced` and `settings-saved` (the settings
changed while the login ran; a watched login is checked against them instead),
`settings-revision` (a check found a settings revision other than the login's, also when
a page resumes the login; a watched login whose account the newer revision still allows
takes it over instead), `settings-unavailable`,
`plan` (the settings or vault no longer allow the login's account on this page, with the
plan's refusal reason such as `connection-disabled`, or `account-changed`),
`vault-replaced` (a vault sync replaced the snapshot that authorized a value before it
was delivered) and `field-unavailable` (a vault field could not be read).

Other login events, judgement, handler, recipe generation and passkey events are limited
to 30 per minute per tab and origin, since one login writes 6 to 8 of them, and
unhandled errors to 20 per minute in all. `debug` events have their own 20 per minute,
so a page's debug detail never crowds out its other events. A login attempt's state
changes (`login.attempt` entries other than `debug`, such as `blocked`, `authenticated`
and a settled result) have their own 60 per minute, so other page events never crowd out
how a long login ended. Each `log.dropped` entry names one dropped event and how many of
it were dropped. The first drop of each event in a window is logged at once and also
logs the drops not yet counted; the rest are counted when the window ends and the next
event or prune runs, so a worker that stops first loses only that remainder. `debug`
entries are written only for 24 hours after **Turn on debug logging for 24 hours**, or
until **Turn off debug logging** turns it off sooner; either change is logged as
`log.debug` with `enabled`. Retention: 14 days; `debug` entries for 24 hours; at most
14,000 `debug` and `info` entries (oldest `debug` first, then `info`) and 1,000 `warn`
and `error` entries, pruned at worker start and every 500 writes.

The diagnostics page sends `diagnostics.logs.export` (with `includeSites`),
`diagnostics.logs.clear` and `diagnostics.logs.debug` (with `enabled`), accepted from
the same page URL only. **Download logs** previews the exact JSON Lines text and saves
it through a `Blob` link (no `downloads` permission): a header line with the version,
revision and export time, then one line per entry. **Copy all** puts the same text on
the clipboard in full, without selecting the scrolled preview by hand, and reports how
many entries it copied. The export shows sites and recipe IDs as logged. When
**Hide site addresses and recipe IDs** is checked, every origin, pseudonymized origin
and RP ID becomes `site-N` and every recipe ID `recipe-N`, numbered within that export.
**Clear logs** deletes every entry and replaces the pseudonym key.

## Declarative recipes and AI

Recipes come from the AI's judgement of a page, never from recording what the person
clicked or typed (owner, 2026-10-12): which page is a login page, and what it offers, is
judged by the AI first ([ADR 0028](adr/0028-account-chooser-login-pages.md)).

Share Valibot contracts for observations, recipes, inference results, and sync. A recipe
contains schema/version, allowed origin/path applicability, structural fingerprint,
semantic slots, stable element candidates, bounded steps, an optional completion and a
failure condition, and provenance. The vocabulary is packaged code such as fill, click,
wait-for-state, and assert-state. There is no eval, remote JavaScript, arbitrary fetch,
or model-selected secret destination.

A stored recipe is either a login recipe, with `slots`, `steps`, `maxSubmissions` and
the optional route members, or an entry recipe
([ADR 0031](adr/0031-sign-in-entry-pages.md#recipe-contract)) whose only member besides
its identity, revision and origin is `entry`: the start path of a page without a login
form and the control there that opens the site's login page, such as
`{"path":"/en/","target":{"by":"text","value":"Login"}}` on pixiv's top page. `entry`
is never beside a login route member, and the target is an `id`, `name`, `test-id` or
`text` locator, never `autocomplete`; only an `<a href>` link is to be pressed, which a
`text` target names by its text as an account switch's does. The service validates,
stores, syncs and revokes both kinds, and the owner web UI lists both. Recipe
generation writes one only for an entry request
([API README](../services/api/README.md#recipe-generation)), a page sent without slots,
whose answer names the link to press. A request with slots, a continuation or a
judgement whose stored recipe is an entry recipe answers `recipe-conflict` without a
model call, as an entry request does when a login or chooser recipe starts on its path.

The extension sends such a page and presses its entry as
[ADR 0031](adr/0031-sign-in-entry-pages.md#decision) describes. The worker offers a
top-level page for generation as ADR 0016 does, with `entry` when a query value of its
URL, parsed against the page's URL, names an `https:` path of the page's registrable
domain other than `/` and its own path (`login/entry.ts`). Ten seconds after loading, a
document that shows no sign-in input and no ready first step announces `entry` (a list
of accounts it also announces goes first); the worker then checks the tab holds no
attempt record for an origin of the site, no tab keeps a logout of it, the page is not
the tab's next page after a submitted password form and a vault item matches, and sends
the page's shown, enabled buttons and links with rendered text outside forms with
fields, header and navigation first, up to 48, without slots. The content script lists
the hosts the page's URL and links name, and the worker answers which are on the site,
so a link to another site, `http:`, to the page itself or only another fragment of it,
opening another window (by its own `target` or the document's `<base target>`),
downloading, or with a query key or value that leads to another site is never described.
The URL parser reads each query key and value on its own and resolved against the link,
and either reading off the site refuses the link; a page's return path counts only when
every reading of its value stays on the site. An entry recipe's path counts as a recipe
start in `offersGeneration` only.

When a cached entry recipe starts on a top document's path, the worker presses it once
every check passes, cheapest first: the revision is not blocked on this device and still
cached, the tab's URL still names a return path, the tab holds no attempt record for the
site, no other tab's login holds it, no tab keeps a logout of it, the tab pressed no
entry in the last 10 minutes, the site and the link's destination are not excluded and a
vault item matches. The content script then names the target's one element, which must
be a shown `<a href>` link with a box of some size and rendered text, no script link, no
`target` (its own or the `<base target>`) other than `_self` and no `download`; the
worker checks its `href` as above and the checks again, stores the press in
`chrome.storage.session` (`pateat.login-entry-presses.v1`) and has the document click it
only if the URL, the element and its `href` are unchanged. A press the document never
answered is not taken as one: it counts against the tab's limit, but its next page is
not checked. The press is no ADR 0022 attempt and holds nothing. The tab's next
top-level document, or the pressed document at another URL, is checked before anything
else runs on it: another site is `left-site`; within `LOGIN_STEP_WAIT_MS` it must show a
sign-in input, an input that asks for an account identifier alone (ADR 0016) or a ready
first step (else `no-sign-in`) and no sign-up form, a shown
`new-password` input beside another password input or two password inputs in one form
(else `sign-up`). No next page within 10 seconds is `no-sign-in`, or `left-site` when
the tab's URL is on another site; a tab on another URL of the site gets the step wait
once more. A page later than the 10 seconds and the step wait settles the press as
`no-sign-in` but is not refused itself, and a page whose check got no answer leaves the
press to that timer, armed again. A failed check blocks the revision in
`chrome.storage.local` (`pateat.login-entry-blocks.v1`) until a newer revision replaces
it, logs `login.entry` as a warning and refuses that page, which is neither generated
nor logged in to. When the stored blocks cannot be read, nothing is written, so no other
recipe's block is lost, and the block holds in the worker only.

A third kind is a chooser recipe
([ADR 0028](adr/0028-account-chooser-login-pages.md#recipe-shape)), whose only member
besides its identity, revision and origin is `chooser`: the path where a list of
accounts shows, the optional `other` and `continue` buttons, and the optional
`afterAccount` and `afterOther` branches, each a login recipe under the chooser's own
ID, revision and origin. The entry to click is never stored. Like an entry recipe, it is
validated, stored, synced, listed and revoked, and the extension never starts it yet.
The service writes one when the model answers that a page with `accounts` is an account
list, naming the list's `other` and `continue` controls by reference; the controls must
be buttons or links of the page whose text holds no `[email]`, `[masked]`, `[number]`,
`@` or run of four digits. The page's description also says how many of its listed
accounts are entries the extension clicks itself (`accountEntries`); when none is, an
answer naming neither control is refused (`no-list-control`), since nothing could lead
on from the list. A request with `branch` (`account` or `other`) and the
chooser as `base` generates that branch's next page: its first page when the branch is
absent, with no alternatives and no passkey route as for any later page, or an append
after the branch's final `advance`. The page judgement takes the same `branch` and
learns a signed-in marker or handler into that branch, with the list's path among the
login paths, and a list shown again is never judged. Each answer is the whole chooser at
its next revision; a branch's page that loses its write to the other branch is written
once more onto the newer chooser. Generation attempts and judged pages are keyed by
branch too. A form page, or a route recipe's next page, whose stored recipe is a chooser
still answers `recipe-conflict`. The extension sends a page that lists accounts ten
seconds after loading, unless it follows a submitted password form, with a username that
is not an email and the other texts beside its buttons shown as `[account]`, and caches
the chooser it gets. A login on the list clicks the account's entry, the `continue`
button or `other`, as the content script finds them for the account's username, then
runs that branch and sends its pages with the branch; with nothing to click it ends
`account-not-listed`
([ADR 0028](adr/0028-account-chooser-login-pages.md#execution)). When the list's path
shows the stored `other` branch's first step instead of the list, as after the person
pressed the button for another account, the login runs that branch without a click
(`other-shown`). Before the chooser has that branch, such a form with a field for the
account is sent as the branch's first page, as after the login's own click, and starts
that way once stored.

A generated recipe has no signed-in marker until the page after its first sign-in is
judged ([ADR 0018](adr/0018-recipe-generation-route.md)). Until then the executor
reports `authenticated` with it only when the sign-in state of
[ADR 0029](adr/0029-local-sign-in-state.md) shows confirmed evidence of a sign-in on the
`password` route (the username in the header or navigation, or the return target the
sign-in page's URL named), or when the tab moves on to the site of a passkey Pateat has
just answered, or, right after a password submission, to another origin of the site (or,
right after a TOTP code or a passkey answered after the password, of any site) whose
page shows the username or a marker learned there, or that the judge answers `signed-in`
for (ADR 0022). A login that stops before its item's missing password never counts the
username ([ADR 0036](adr/0036-passkey-after-the-identifier.md)). Otherwise a submission
ends `credential-rejected`, moves to a later step, or stays unknown (`unknown-submit`),
so no account choice is saved. An unknown attempt stays in `reconciling` until its tab
closes or, for a top-level attempt, until the tab shows a page of another origin that
Pateat may run on (`left-origin`, ADR 0022): meanwhile it holds the origin. A top-level
`password` attempt ends sooner, after its 10-minute watch or when its first step shows
again in a new page
([ADR 0027](adr/0027-per-account-login-routes.md#watching-after-a-challenge)). The
extension sends a page no check explains to be judged, which settles such attempts
([Background execution](#background-execution)).

A login in progress keeps off the writes that would stop it. A passkey chosen in the
chooser as a site default is not saved, nor is an account choice from another tab's
login while this worker runs a login.
The vault replacement waits ([ADR 0025](adr/0025-automatic-vault-sync.md)), and so does
the settings sync's local write, for at most two minutes, counted from the first
deferred write until a sync runs with no login in progress. An attempt counts until it
ends or its result settles as unknown, also between pages and after a worker restart,
and a settled one counts again only while the extension checks or judges one of its
pages. A settled attempt can stay until its tab closes (a top-level `password` one for
at most its 10-minute watch), so counting it would use up the two minutes for every
later login. A policy write while an attempt is settled stops it as
`POLICY_CHANGED`, so its later pages are no longer judged
([ADR 0027](adr/0027-per-account-login-routes.md)). A watched login counts the same way.

A recipe's `completion` is a list of up to four signed-in markers without a path
([ADR 0029](adr/0029-local-sign-in-state.md)), in the order the judge found them: the
first from the page after the first sign-in, each later one from another page the judge
answered `signed-in` for while no learned marker showed there. A marker is never an
element the recipe's steps, passkey route or handlers use, on any path. Each may also
list up to four `absent` elements. The executor reports `authenticated` when one marker
is unique and visible on any path and every `absent` element of that marker is missing.
A marker may be a link named by its text, such as an account page link without an `id`,
matched as an account switch's is. A marker learned on a page that signs in on its own
path lists that path's sign-in fields, because the executor checks the markers after
every step and counts hidden elements: a login page that keeps a hidden "Sign out" link
never counts as signed in. A site that keeps those sign-in inputs hidden in its pages
after signing in therefore never reports `authenticated` with such a marker. A recipe's
markers and their absent elements, its rejection and any one step's elements together
stay within one 24-element observation, so a marker that would exceed it is not learned.

A step names its element with an allowlisted locator, never CSS: an `id` or `name` (any
ASCII except whitespace and control characters, as in `ctl00$Main$txtUserId` or
`user[login]`), a `data-testid` (`[A-Za-z0-9_.:-]`), an `<input>`'s `autocomplete`
token, a fillable input's visible name
([ADR 0037](adr/0037-fields-by-visible-name.md), below), or, for a click or a state
check only, a button's text:
`{ "by": "text", "value": "ログイン" }` names the `<button>` whose rendered text (or,
without any, its images' `alt`), the `<input type="submit|button">` whose value, or the
`<input type="image">` whose `alt` equals the value after whitespace is collapsed (owner
decision, 2026-10-11). Hidden buttons and hidden text inside a button do not count, and
text over 120 characters gives no locator. The `autocomplete` locator,
`{ "by": "autocomplete", "value": "username" }`, names the one `<input>` whose
`autocomplete` attribute holds that token, ignoring case and other tokens; the token is
`username`, `email`, `current-password`, `one-time-code` or `webauthn`, never
`new-password`. The owner added it on 2026-10-12 for pixiv's login page, whose inputs
carry only `autocomplete="username webauthn"` and
`autocomplete="current-password webauthn"`. `webauthn` was added the same day for
LinkedIn's remembered-account page, whose shown password field differs from a hidden
copy (`current-password`) only by that token, once its React IDs no longer counted. The
extractor gives it only to a field that no `id`, `name` or `data-testid` names alone.
Such a token is generic: when another form on the page, such as a newsletter sign-up,
also carries `email`, a step that names `{ "by": "autocomplete", "value": "email" }`
matches twice and waits, or, if the login form has not rendered yet, fills the other
input (never with a secret, which goes only into an input the fill check accepts for it,
such as a password or `current-password` input for the password); and a signed-in page
that shows such an input cannot become the completion. A script button is a control only
scripts make clickable: a script link, or another element with `role="button"`, but
never a form control or anything inside an `<a href>`. A script link is an `<a>` without
`href` that has an `onclick` attribute or `role="button"`, such as
`<a id="login" onclick="document.loginForm.submit()">`, or an `<a href>` that runs a
script instead of following the link: a `javascript:` URL (or a `data:` or `vbscript:`
one, which Chrome never follows from a page), such as
`<a href="javascript:;" onclick="login()">ログイン</a>`, or an empty or fragment-only
`href` on a link with an `onclick` attribute or `role="button"`, such as
`<a id="login" href="#" onclick="document.loginForm.submit()">` (some pages' scripts add
`href="#"` after load). The owner chose on 2026-10-11 that such `href` links are clicked
as buttons, so pages whose login control is one, such as MyJCB and SMBC Direct, can get
a generated recipe. Chrome runs a `javascript:` URL that a click follows under the
content security policy of the world that clicked, and the login content script's
isolated world has the extension's own policy. So a click Pateat makes on an `<a href>`
whose URL, as the browser parses it, is `javascript:` (`src/page/script-url-click.ts`;
`data:` and `vbscript:` links take the same path, though Chrome follows neither) is made
in the page's main world by `login-main.js`, which runs at document start in the
MAIN world wherever the login script runs (every HTTPS page and frame), with no
permission or host access of its own. The isolated script dispatches a fixed,
non-bubbling event that carries nothing on the link itself; the main-world listener
clicks that link once, only when it is such a link, and cancels the event. When nothing
cancels it, as when the script did not load, the isolated script clicks the link itself,
as before; only one world clicks, so the link's `onclick` handler runs once, and
whether the page reacted is still judged by the attempt's own checks, never by anything
the main world reports. A page sees the event and can click its own links anyway, so it
gains no power over its own login it lacked, though the event tells any HTTPS page or
frame that Pateat is installed (the passkey bridge does so in top-level documents). A
link in a closed shadow root is still clicked from the isolated world, since the
main-world listener sees only its host. The click on a list's link for another account
(ADR 0028) takes the same path, so such a `javascript:` link now runs its URL. Every
other click, including links with other URLs, buttons
and form submits, is made in the isolated world as before. Before this, a link whose
action is its URL alone never submitted: on 2026-10-13 a recruiting site's sign-in
logged `Refused to run the JavaScript URL` in the console after such a click,
reproduced in Chromium with a synthetic page, and on 2026-10-17 the owner's Chrome on
build `d29951d` (01:55 UTC) filled SMBC Trust Bank's sign-on page and clicked its
サインオン control, `<a href="javascript:submitProc();doTransaction(...)">`, whose
`submitProc()` copies the shown fields into hidden ones and submits, and
`chrome://extensions` logged
`Running the JavaScript URL violates the following Content Security Policy directive
'script-src 'self' 'wasm-unsafe-eval' …'` from `content-scripts/login.js`, so the page
never submitted. Clicking such links from the main world is an agent implementation
choice under the owner's 2026-10-11 decision that they are clicked as buttons. A text
locator names a script link by its rendered text, but only
when no native button carries that text, shown or hidden: native buttons are matched
first, so a login tab such as `<a href="#" onclick="...">Login</a>` never makes the
`<input type="submit" value="Login">` below it ambiguous, and a text locator waits for a
hidden native button rather than clicking a script link with its text. A recipe that
names a script link by text clicks a native button instead if the page later adds one
with the same text. Other script buttons, such as a `<div role="button">`, are often
widgets such as menus and toggles, so their `id`, `name` or `data-testid` names them,
and their rendered text only inside a login `<form>` or beside a password form, when no
native button (shown or hidden), script link or other such element carries that text:
since 2026-10-13, when Instagram's Log in control was a `<div role="button">` with no
attribute to name it and the page was described without it, the executor matches them by
text after native buttons and script links, but only in lookups that never name a link:
a login's steps and a marker's `absent` elements, where such a control showing again
counts. Lookups that may name a link (an entry, an account switch, a signed-in marker)
compare links instead and never match them, so a widget elsewhere on the page never
stands in for a link, and in a login form a link loses its text locator when such an
element shares its text. The extractor leaves out a script button without a locator
instead of marking the page incomplete. It does the same for an icon button that never
submits (`type="button"` with no text of its own), such as
the eye that shows the password on モッピー's and LinkedIn's sign-in pages (2026-10-12),
whose only name is an `aria-label`, but only when its form has another located button:
an icon-only button may be the form's script-run submit. A `type="button"` button with
text, such as `<input type="button" value="Login">` submitting by script, still marks
the page incomplete when it has no unique locator. The executor compares strings and
acts only when exactly one element matches; more than one is a structural mismatch. It
clicks buttons, image buttons and script buttons (not a disabled button, nor a script
button with `aria-disabled="true"`), never links, except a recipe's `accountSwitch`,
which may be an `<a href>` link (a script link with `href` included) named by its
rendered text; no other script button is clicked as a switch. A switch's text locator
names another link only when no shown button or script link has that text (a hidden
native button holds back only script links), so a switch recipe that names a link clicks
a button instead if the page later shows one with the same text. A link's text is its
rendered text or, for an image-only link such as a header icon, its shown images' `alt`.
The extractor gives a link a text locator only when no other link and no button shows
that text, and only on a login page (for an account switch) or the signed-in page (for a
completion marker). On the signed-in page a link to the page's own origin is located by
its path first (`{ "by": "href", "value": "/my" }`), when no other link goes there and
the path has only letters, `-`, `.`, `_`, `~` and `/`, no token segment and no segment
that repeats the link's text or one or two words of the page's header (a handle or name
the page shows);
the executor finds it as the one non-script `<a href>` to that path on the page's
origin, whatever its query or fragment, never one with an empty or fragment-only `href`
(`#top`). Only completion markers take such a locator
([ADR 0029](adr/0029-local-sign-in-state.md)), so an account link whose text is the
person's nickname can still give a marker. A click is not tied to the
form the previous fill used: a page that shows a second, previously hidden button with
the same text stops the attempt as ambiguous, but if the observed button is removed and
another button with the same text remains, that one is clicked.

The extractor gives no `id` that React's `useId` generated (`:r1:`, `«r1»`, `_r_1_`,
a hydrated `:R1aH1:`, also after a prefix such as `radix-`): it counts the components
rendered before it, so another page of the site gives the same ID to another element.
LinkedIn's feed gave its search box the ID of the login form's username field, so the
signed-in page showed that field (ADR 0029's S1, 2026-10-12). An element with no other
unique locator gets no target: a login form that needs it is incomplete, and a possible
sign-in field on the signed-in page is reported as unlocated. Saved recipes keep their
targets until they are generated again.

An `id` holding a random-looking run is demoted rather than skipped: the extractor
gives it only when no `name`, `data-testid`, `autocomplete` token or text locator is
unique. Such a run is eight or more lower-case letters and digits that no other letter
or digit touches and that switch between digits and letters at least twice. Mantine's
`useId` appends `Math.random().toString(36)` after mount, so a Mantine-built site's
recipe filled `mantine-4p5f7ku4o`, an ID the next load no longer had (2026-10-13). The
rule flags about 88% of such IDs; it misses a run shorter than eight characters, one
that switches fewer than twice, and one beside an upper-case letter. Stable IDs such as
`step2of3`, `input2fa` or `form-3a7bd3e2` also match, so an element that has no other
unique locator still gets its `id`, and a form that only such IDs locate stays
complete. An `id` starting with `mantine-`, the prefix of Mantine's `useId` and of the
IDs its components derive from it, is demoted the same way, as a rule about the UI
library like the one for React's `useId`, not about a site (ADR 0033): the random run
can lack a digit, and a signed-in marker on a Mantine-built site was chosen by
`mantine-ypxwydcwg-tab-mypage`, a tab's ID (2026-10-13). On the signed-in page such an
`id` or a random-looking one locates no marker, since a marker must match on every
later visit; only a field that may be a sign-in field still gets it, so the page is
not reported incomplete.

A field that no `id`, `name`, `data-testid` or `autocomplete` token names alone is
located by its visible name before such an `id` (owner, 2026-10-13,
[ADR 0037](adr/0037-fields-by-visible-name.md)):
`{ "by": "label", "value": "メールアドレス" }` names the one shown `text`, `email`,
`tel`, `number` or `password` input whose name equals the value. The name is the
rendered text of the elements its `aria-labelledby` names, else of its `<label>`
elements, else its `aria-label`, else its `placeholder`, the first that is not empty,
collapsed as button text is; a first name over 120 characters gives none. The extractor
uses it only when no other shown fillable input on the page has that name, it holds no
number (a counter such as `0/20` changes as the person types) and redaction leaves it
unchanged, so a placeholder such as `taro@example.com` is never one; a hidden input
never matches. Fill steps and a `totp` handler's code field take it, never a
button, link, entry or list control. On the signed-in page only a field that may be a
sign-in field gets it; markers never do.
外資就活ドットコム's Mantine fields carry only per-load IDs and the placeholders
「メールアドレス」 and 「パスワード」, so its recipe failed on every visit and was
generated again each time (2026-10-13). A site that rewords the field gets its recipe
generated again.

A text locator is stored in the recipe, unlike observation labels, which only reach
inference. Redaction keeps email addresses and long numbers out of it, but a button such
as "Continue as taro_y" still carries an account name, and so can a signed-in marker's
link text, such as a header link showing the person's name: the judge is told never to
pick one, text with a number never names a marker, and a link to the page's own origin
is named by its path instead when it can be, yet a path can still hold a handle the page
never shows, which only the judge is told to refuse. Nothing enforces the rest. Recipes
are per owner today; before recipes are shared between users, such locators need a
review.

Site recipes contain meanings such as branch-number/account-number/password. Keep
account-specific bindings separate from recipes. They are stored in the synced settings
document as references, never credential values, and resolved to values locally. AI
input may name the allowed vault fields but never carries bindings, item or account IDs
([ADR 0013](adr/0013-service-held-recipes-and-settings.md)). The generation role names
each custom-field slot it uses with a generic ID in lowercase words (`branch-number`;
not `username`, `password`, `totp` or a requested slot ID), the recipe stores only that
ID, and the service answers with `customSlots`, which maps each such ID to the offered
slot. The extension keeps that mapping as the field names it offered, per service,
device and recipe, in `chrome.storage.local`. An item without a saved binding then binds
from another item's saved binding of the recipe, else from that map, and the binding is
saved after `authenticated` as for built-in slots
([ADR 0027](adr/0027-per-account-login-routes.md#implementation-choices)). When a
start page shows several identifier sets at once (branch and account numbers, or a
contract number), the generation role may also return up to 3 alternative sets, each
with its own fields and submit action; they become the further variants of the recipe's
`password` route. An element is filled under one slot name in every set and no two sets
fill the same slots or elements; an answer that hedges an ambiguous mapping that way
fails as invalid output. The role may also name the start page's passkey sign-in button,
never one that registers a passkey; the service stores it as the recipe's `passkey`
route only when its label or locator names a passkey or security key, and drops a
button that fails its checks without failing the answer. A `hidden`
slot is filled only into an input the Hidden rule of ADR 0013 accepts; the decision role
and the heuristic name no custom slot, so they abstain on pages that need one. Signing
in to a site through Google or Microsoft follows the policy in
[ADR 0026](adr/0026-sign-in-through-identity-providers.md) (not implemented).

Split inference into independently configured recipe generation/repair and
finite selection/classification roles. Adapters may share an underlying provider
but keep their contracts and model settings distinct. Selection sees only
eligible sanitized semantic references and cannot relax policy. Future AI account
selection uses the same constrained operations as human selection; it does not
change the initial saved-default behavior.

For finite choices, include an explicit unknown/none candidate and validate
returned identifiers, score/probability shapes and joint mapping consistency.
Abstain on insufficient evidence; model confidence never grants permission.
Bound the full input, including candidate/question text, and reject incomplete
observations instead of relying on provider truncation.

Extract an allowlisted observation before filling. The proposed observation contract
lives in `packages/contracts` and the offline role adapters in `packages/inference`; see
[AI evaluation harness progress](plan.md#ai-evaluation-harness-progress). Exclude
values, hidden inputs, raw HTML, screenshots, query strings, and unrelated page text by
default. On every page Pateat observes (a login page, a list of accounts, a sign-in
entry page, the page after an `advance` step and a judged page), each whole path segment
that may carry a session ID, a tenant or account ID or another token is replaced by
`[id]` ([ADR 0039](adr/0039-redacted-token-path-segments.md), owner 2026-10-16 14:10
UTC), so `/<tenant UUID>/oauth2/authorize` is sent as `/[id]/oauth2/authorize` and the
token never reaches the service or its request log. A segment counts when, as it is or
percent-decoded, it holds a matrix parameter such as `;jsessionid=`, an ASP.NET
cookieless part, `?`, `&` or `=`, a UUID, or a run of 16 or more letters and digits with
a digit (or a base64url-like run of that length); the whole segment goes, so
`/app/login;jsessionid=X` and `/app/register;jsessionid=Y` both read `/app/[id]`. A
recipe is stored under that path, and the extension compares a live page with a recipe,
an observation or a content-script report only through the same replacement, so every
tenant's page shares one recipe and one retry window. On a page whose path had a segment
replaced, an `id`, `name` or `data-testid` that may be a token locates nothing, as on a
judged page, so a token the page also writes into such an attribute is not sent through
a locator either. Text, labels and the title are not checked against the replaced
segment, and a short token the rule does not flag is sent as it is, so this is a
heuristic. A username in the path
is looked for in the raw path, before the replacement. The local log's `url` keeps the
raw path (owner decision 2026-10-13). Labels can
contain private data too: sanitize and bound them, with privacy fixtures and an
abstention path when a useful safe observation cannot be constructed. The owner chose on
2026-10-11 to redact observed text before it is sent: email-like strings, including
masked ones, become `[email]`; runs of three or more `*`, `●`, `•` or `＊` become
`[masked]`; and runs of four or more ASCII or fullwidth digits become `[number]`
(`口座番号 ****1234` becomes `口座番号 [masked][number]`). Names cannot be detected and
stay, except the account's own usernames: just before a page goes to the service (a
recipe's first page, the page after an `advance` step, and the page the completion judge
gets), the worker reads the `login.username` of the items that match the page as for the
[username shape](adr/0016-recipe-generation-trigger.md#username-shape), and for a judged
page the login's own item's too, and hides each username of three or more characters
(the minimum the sign-in state's E2 uses) where it shows as `[account]`, by
[ADR 0028](adr/0028-account-chooser-login-pages.md)'s rule for a listed name: as a whole
text or inside a longer one, ignoring case and width and a leading `@`, but never inside
a longer Latin word, so `ann` is not found in `annual`. It looks for each username as it
is and in the form the page's redaction left it in (`taro[number]` for `taro1234`), and
also hides the start of a username at the end of a text cut at its limit (120
characters, 1,000 for the header text). The title, headings, header text, texts near a
code field or the buttons, account texts and each candidate's label, placeholder and
description are covered. A locator cannot be hidden, since it must name the element as
it is: a button, link or checkbox whose locator (text, `id`, `name` or `data-testid`)
holds a username is left out. The page is not sent (`username-shown`) when that control
would leave it incomplete: a field, a button or link of a field's form, or a button
outside every form beside a field outside every form; nor when a segment of its path
holds a username under the same rule. A username read that fails also keeps the page
from being sent (`username-unread`); an item without a username, with an empty one (the
catalog's `empty` flag) or whose username the user excluded is not read and does not
count. Not covered: an email username's local part shown alone (the address itself is
already `[email]`), a username in the origin, such as a personal subdomain, the
usernames of items on a connection that could not answer, and the sign-in entry pages of
[ADR 0031](adr/0031-sign-in-entry-pages.md). Known limits: a username that is also a
word in the page's path or its form controls, such as `admin` or `login`, keeps that
page from being sent (`username-shown`), so such a site gets no recipe; on a judged
page, a formless control naming the username, such as an account-menu button beside a
header search field, refuses the judge (`not-sent` with `username-shown`), and the login
then settles `unknown`; and the three-character minimum counts after a leading `@`, so
shorter usernames, two-character CJK names included, are not hidden. The usernames are
never sent or logged (`apps/extension/src/observation/usernames.ts`). On the page shown
after sign-in, which the completion judge observes, the owner chose on 2026-10-12 to
hide every number instead: each number, whatever its length or script, with digit groups
joined by `.`, `,` or `'`, becomes one `[number]` (`保有ポイント 1,234pt` becomes
`保有ポイント [number]pt`), because balances and points appear in any form and judging
the sign-in needs none of them. Numerals written as letters, such as most kanji, stay.
That page also carries `headerText` ([ADR 0029](adr/0029-local-sign-in-state.md)): the
visible text of each outermost `header`, `nav`, banner and navigation landmark in
document order, redacted the same way, with usernames hidden as above, and cut at 1,000
characters. No other page carries it. While that page has an open modal dialog (a shown
element with `aria-modal="true"` and the role `dialog` or `alertdialog`, or a `<dialog>`
opened with `showModal()`), an `aria-hidden="true"` or `inert` element beside the dialog
or one of its ancestors, as modal libraries mark the page behind, no longer hides what
it holds: the description carries that page's header text, headings, fields and possible
markers, with the modal's controls ranked right after the header's, and E2 reads the
header the same way (ADR 0029, 2026-10-13). An element the site hid at that level for
another reason, such as a closed drawer, is read too. That page, when it shows a code
field, also carries `nearCode`: up to three short texts near the first one, such as a
sentence naming an authenticator app outside the code form, redacted the same way, with
live regions, error messages, controls, labels, links and headings left out
([ADR 0027](adr/0027-per-account-login-routes.md#implementation-choices)). Without a
code field, it carries `nearButtons` instead: up to three such texts near its buttons,
read inside an open modal that holds one or else the first shown main landmark, and
never in the header or navigation, so the judge can tell that a button labelled only
"Verify" starts a security-key check. There, a polite live region without a role of
its own that holds one of those buttons, the modal or main itself or a region inside
it, is read as any other part of the page; every other live region is still left out.
Login pages keep the
four-digit rule, since hints such as `4 digits` help map fields. When a login page
already shows a chosen account and offers a button or link to use another one, the
generation role may name it as the plan's `accountSwitch`; it must be an observed button
or link that the plan neither fills nor uses as its action. The generated recipe keeps
the first switch a page names that no step clicks. Only links inside the login form are
observed, so a switch link outside it is not named. A button whose text a link elsewhere
on the page shows too, and a button that would submit a form, are never clicked as a
switch; the attempt then ends `wrong-account`. Locating links by text means in-form
links without an `id`, `name` or `data-testid` are now observed as well, with their
redacted labels, and a switch link's redacted rendered text is stored in the recipe.
Model output must pass structural and semantic checks on the server and again locally.
Screenshot, audio and video collection are deferred. A provider's multimodal support
does not enable these inputs without a separate privacy/evaluation gate.

Use a cached compatible recipe first. On structural mismatch or repeated genuine
recipe failure, request repair within a separate bounded inference budget (proposed, not
implemented: a recipe whose elements no longer match is not regenerated until it is
revoked; repair is planned early in [phase 3](plan.md#phase-3-public-release)). Wrong
credentials, MFA, network errors, and account lockout do not trigger endless
relearning or reset submission limits. Inference can abstain, refuse, time out,
or return invalid output; all have explicit local outcomes.
Never automatically fall back to another provider or model. Compatible local
recipes continue working when inference is unavailable or its spending cap is
reached.

## Existing passkeys

Register the MAIN-world bridge at document start without waiting for remote
configuration. Relay permitted WebAuthn requests to local signing code, then
return standards-compatible assertions. Validate challenge, RP ID, origin,
allowed credential IDs, userHandle, algorithm, signature encoding, backup flags,
counter behavior, cancellation and timeout. Implement existing-key assertions
first, with counter-zero keys only; registration and nonzero-counter writeback
are deferred. Preserve ordinary browser behavior for excluded requests.

Mediation must preserve native admission checks: secure context, effective
publickey-credentials-get Permissions Policy, ancestor/top-origin identity,
public-suffix-aware RP ID validation, and correct clientDataJSON crossOrigin/
topOrigin values. Origin suffix matching alone is insufficient. Start with
top-level same-origin ceremonies; fail closed on cross-origin or opaque cases
until those checks and vectors are implemented. An authorized login origin
embedded under an unrelated top-level site is not automatically authorized.

UV is not synonymous with biometrics. Owning a software key makes flag/signature
construction possible, but setting UV/UP without the required ceremony is not
standards-compliant verification. The owner nevertheless chose to set both flags on
every claimed request; describe this as a deliberate deviation, never as verification,
and keep the flags behind a policy a later per-site setting can change. Hardware-bound
keys cannot be unlocked merely by changing flags. Pateat's wrapper stays outside
wrappers that other providers, including the official Bitwarden extension, install by
assigning `get` or `create`, so it answers claimed requests first. A top document's
conditional request goes to the login runtime, which answers it only through a login of
that document and otherwise hands it on, or withholds it after that login signed in
([ADR 0034](adr/0034-answer-page-passkey-requests.md)). A login that stops before its
item's missing password answers its document's waiting request at its stop, also one
made after its first submission
([ADR 0036](adr/0036-passkey-after-the-identifier.md)). Real-extension coexistence
requires separate compatibility tests.

The bridge, admission rules, assertion format and unattended presence and verification
policy are in [ADR 0007](adr/0007-existing-passkey-assertions.md). Like the official
Bitwarden client, passkey requests search every live login item by RP ID rather than by
saved URI; a site default only chooses among several matches. Every build registers the
bridge on top-level `https://*/*` documents: `passkey-main.js` in the MAIN world and
`passkey-isolated.js` in the isolated world, both at document start, under the
install-time HTTPS access of [ADR 0009](adr/0009-install-time-https-site-access.md). The
background answers them from the vault-backed passkey source, which applies the item
selection. The crypto Worker signs with the stored vault passkey, keeping the private
key inside the Worker and signing only zero-counter assertion data for that credential's
RP ID. The probe build adds `http://localhost/*` scripts and a synthetic test-vector key
for that origin.

When several signable passkeys match and none is the site default, the background opens
the chooser window `passkey-picker.html`
([ADR 0021](adr/0021-account-choice-outside-settings.md)) with `chrome.windows.create`.
It shows only item names, passkey user names and connection labels: under "Sign in to"
the site's host, each passkey as its user name over its item and connection, with the
site default marked **Default**, and "Pateat signed in here from this tab before" when
the tab's earlier sign-in opened it, or "You logged out of this site in this tab" when a
control that logs out, clicked in the tab, did (ADR 0021 D). The background
answers its messages only from that page, for the request token in its URL and from the
window it opened, and keeps the worker alive while the window waits. Choosing signs with
that passkey; a ticked checkbox then saves it as the origin's site default. When the
request's wait runs out first, the window closes and the request fails with
`NotAllowedError`, as Chrome's own prompt does. Any other ending delegates to the
browser. A settings change, such as a sync, leaves the window open; after a choice the
passkey is looked up again and used only if the current settings still offer it. The
background also keeps, per tab in session storage, the RP IDs it signed for; a later
request with no allow list for one of them in that tab opens the window even for one
match or a site default, because it may follow a logout. A running login's own requests
never open it (below).

The bridge also wraps `navigator.credentials.create`, but only to refuse one kind of
registration
([ADR 0007](adr/0007-existing-passkey-assertions.md#registration-after-a-sign-in)).
A top document's public-key registration with a non-empty `excludeCredentials` is
checked by the background; every other one goes to the browser at once. The background
keeps, per tab in session storage, Pateat's latest sign-ins: each assertion it returned
(origin and RP ID) and each login that reached signed in on any route (origin), at most
four per tab for the latest 64 tabs, forgotten when the tab closes and moved to the
new tab ID when Chrome discards the tab (ADR 0021 D). Within five minutes
of such a sign-in to the request's RP ID in that tab, a request whose
`excludeCredentials` lists a passkey Pateat could sign with there, found by the same
lookup a sign-in uses, is refused with `NotAllowedError`, as Chrome answers when its own
prompt is dismissed. Anything else, including a locked vault or a failed lookup, hands
the request on. It never writes to the vault and is not passkey registration.

While a login is running, a request from its tab and top-level origin is answered with
that login's own vault item only, never the site default or the chooser
([ADR 0027](adr/0027-per-account-login-routes.md)). A login counts as running while its
stored attempt record for that tab and origin is neither `authenticated` nor `blocked`,
its result has not settled as unknown since it last moved on, and it is not `watching`.
The record carries that settled mark, so the rule holds the same after a worker restart,
and a stored record that neither ends, settles nor resumes keeps scoping its tab and
origin to the same item until the tab closes. When that item holds no single signable
match, or its search is incomplete, the request is delegated, so Pateat never signs in
as another account.

## Minimal service

Use one optional Cloudflare Worker and D1 for private settings/recipe revisions
and inference. Do not add queues, Durable Objects, browser rendering,
vector search, or an agent framework without a demonstrated need. Use bound SQL
parameters through the approved Drizzle integration, with Hono for API routing
and middleware. Owner scope, conditional revision writes and D1 batch behavior
remain explicit application responsibilities. The current Worker implements the
sync, pairing and device management routes and the recipe generation routes of
[ADR 0018](adr/0018-recipe-generation-route.md), with their limits and the
[ADR 0012](adr/0012-inference-request-log.md) request log, as described in
[its README](../services/api/README.md).

Initial human service authentication uses Cloudflare Access, validated through a
supported integration or verified JWT, not an untrusted email header. Access-free
OIDC/passkey authentication is a later adapter. Self-hosting is the target, but
owner-scoped data allows other operators to serve multiple users later.

Pairing uses the browser's login session to the service
([ADR 0020](adr/0020-direct-device-pairing.md);
[device enrollment](#device-enrollment)), and credentials expire after 90 days unused.
Store only hashed revocable high-entropy device credentials server-side; scope every
query and write by verified owner/device. CORS is not authentication. No shared
universal credential is shipped in the extension. Separate Access-protected pairing from
device-authenticated API routes: a device token does not automatically pass an Access
gate. Steady-state API access must not require an interactive Access cookie for each
call. Service login does not authenticate or unlock a vault.

Initial synced settings are server-readable so service login can restore them
without another recovery key. E2EE settings sync is a later option. Provider
sessions, vault values and unlock material remain device-local. Deployment
configuration lives in cloudflare.config.ts, operator keys in Worker secrets,
and runtime settings/recipes in D1. Use revision-checked settings updates,
explicit conflicts and a durable local last-known-good cache; stale sync must
not silently overwrite newer restrictions. Server revocation stops server
access, not guaranteed erasure of offline cached material.

Claude credentials are per owner
([ADR 0015](adr/0015-per-owner-claude-credentials.md)): the Worker holds only its
OIDC signing key, and D1 holds each owner's Workload Identity Federation
identifiers.

Version recipes immutably with a current pointer and revocation/tombstones.
Sync with conditional reads/cursors and keep a local durable cache. Validate
minimum supported schema, origin scope and device access; reject stale or
incompatible results. Start private per owner. Public recipe sharing and
cross-user learning are deferred to a separate design.

Keep provider selection independent of recipe contracts: Claude for bounded generation
and Clef-flash, Clef and Jev for finite choices are evaluation candidates, not fixed
model requirements. Initial inference uses server-held keys. A future direct adapter
keeps a user's key in trusted extension contexts and out of content scripts.

Expose a simple monetary spending cap and stop new inference after recorded
Pateat usage reaches it. Use returned cost where available; otherwise calculate
an explicitly labeled estimate from usage and versioned prices. This is not an
invoice or strict reservation system: in-flight/concurrent calls may overshoot.
Use a monthly USD limit initially; select the default amount during service
implementation. Timeouts, request limits, bounded retries and sanitized
diagnostics remain necessary.

### Service limits

Status: implemented, except the recipe byte cap below, which the owner chose on
2026-10-14 (07:56 UTC) and [#550](https://github.com/risu729/pateat/issues/550) builds.
The owner asked on 2026-10-11 for common-sense per-owner limits sized for their own use;
Claude chose the other amounts. Revisit them before the service is offered to other
people.

- Requests. The `OWNER_LIMITER` rate-limit binding allows 120 requests a minute per
  owner on `/v1`, counting all of the owner's devices together, and 120 a minute per
  verified Access identity on `/manage/api`. The check runs right after authentication
  and before any body is read; a refused request gets 429 `rate_limited` with
  `Retry-After: 60`. The hosted limiter is approximate and counts per Cloudflare
  location. `/pair` keeps its own 10 a minute per verified Access identity. Recipe
  generation is also bounded by spend and one call at a time
  ([ADR 0018](adr/0018-recipe-generation-route.md)).
- Recipes. An owner holds at most 1,000 active recipes. Creating a recipe or
  republishing a tombstone beyond that answers 409 `recipe_limit`; updating an active
  recipe does not add to the count, and a revocation frees its place. Generation answers
  `unavailable` with `recipe-limit` before any model call when a first page would add a
  recipe, or after the call if the last place was taken meanwhile.
- Recipe history. Each recipe keeps its newest 10 revisions; a winning write deletes
  older ones in the same D1 batch, and a revocation keeps only the tombstone. Nothing
  reads older revisions. At the 128 KiB body limit this bounds an owner's active recipes
  to about 1.2 GiB; generated recipes are a few KiB each. Tombstones are not counted:
  each is two small rows and one change-feed entry.
- Recipe bytes on a device. A device caches the owner's active recipes as one
  `storage.local` value of at most 2 MiB (`MAX_RECIPE_CACHE_BYTES`); a sync page that
  would exceed it is not applied. Serialized, a typical generated recipe (email, Next,
  password, two markers, a TOTP handler) is about 1.1 KiB and an account-list recipe
  with both branches about 2.3 KiB (measured on hand-made examples on 2026-10-14, not on
  the owner's recipes), so 2 MiB holds about 1,800 of the first or 880 of the second;
  1,000 recipes fit only while they average 2 KiB or less. The service cap below leaves
  margin for the cache envelope. A device can still remain blocked by `cache-full`: a
  page of new recipes may coexist with stale large revisions whose shrinking updates
  are already on later pages, even when both service snapshots fit the cap. For example,
  shrinking old recipes frees room for new ones, then another update of those shrunken
  recipes moves their latest heads after the additions in the change feed. The overflow
  leaves the persisted cursor unchanged, so each retry of the same feed repeats the
  additions page and cannot reach the shrinking updates. This can persist indefinitely
  without a further service change or cache reset that lets the page fit.
- Recipe bytes on the service (implemented,
  [#550](https://github.com/risu729/pateat/issues/550)). The owner chose on 2026-10-14
  (07:56 UTC) a cap of 1.5 MiB on the UTF-8 bytes of an owner's active recipe documents,
  so that they fit a device's 2 MiB with room to spare. It applies to creating a recipe
  and to any update that grows one (continuation pages, judge handlers and markers);
  equal or shrinking updates and revocations always pass. Only current active head
  documents count, excluding tombstones and retained historical revisions. The claim SQL
  checks the UTF-8 byte sum atomically with the write. Over the cap, a write answers 409
  `recipe_limit` and generation answers `unavailable` with `recipe-limit`, the reason
  the extension already handles, and generation refuses before a model call when less
  than 32 KiB of room is left, including continuation and entry generation. A judged
  page keeps its answer when the cap refuses its handler or marker write (owner,
  2026-10-16): a challenge page still answers `challenge`, and a signed-in page of a
  recipe that already has a marker, or of another origin of the site, still answers
  `signed-in`; the refusal is logged. Only a first marker on the recipe's own origin
  that the cap refuses answers `recipe-limit`. The cap and
  `MAX_RECIPE_CACHE_BYTES` are defined together in the contracts; no migration is
  required.
- Unchanged. Settings are one document of at most 120 KiB per owner. The inference
  request log is kept 90 days and bounded by the $5 daily spend limit. Devices are not
  counted: each pairing needs an interactive Access login.

### Device enrollment

Status: direct pairing ([ADR 0020](adr/0020-direct-device-pairing.md)) is implemented
and tested locally, including in bundled Chromium against the built Worker behind a
synthetic Access stand-in. It has not yet paired installed Chrome with the deployed
service. It replaced the typed-code flow, which the owner had used to pair a real
Chrome through Access on 2026-10-11. Pairing uses the owner's login session once;
steady-state API calls carry no cookie.

- Route families. One Access application covers the whole service host, so a new route
  is protected by default (owner decision, 2026-10-11). A second, more specific Access
  application with a Bypass policy exempts the paths that cannot pass an interactive
  login: the `/v1` sync routes, which accept only device credentials; `/health`; and the
  two `/.well-known` issuer routes that Anthropic fetches anonymously. The Worker
  verifies the `Cf-Access-Jwt-Assertion` JWT itself:
  signature against the team JWKS, configured audience tag and issuer, and expiry. It
  never trusts the plain identity headers. The owner key is the issuer plus the token
  subject, not the email address. Verification uses Hono's JWT utility with the team
  JWKS, allowing only RS256; Hono's JWK middleware reads only `Bearer` values, and a
  dedicated JWT library would need its own owner decision. Tokens without an expiry or a
  user subject, such as service tokens, are refused. The public keys are edge-cached for
  five minutes, so a rotated key may be refused briefly.
- Pairing. **Pair this device** on the settings page asks for site access to the
  service, then the extension's background service worker sends one `POST /pair` with
  the device label, `credentials: "include"`, `redirect: "manual"` and
  `X-Requested-With: XMLHttpRequest`, so the browser's Access session travels with it.
  The route sits behind Access; the Worker verifies the token (the host-wide
  application's audience, or "pateat pair"'s, which also admits browsers without WARP,
  [ADR 0030](adr/0030-pairing-without-warp.md)) and requires
  `Origin: chrome-extension://<id>` for an ID in `PAIRING_EXTENSION_IDS`, which lists
  Pateat's manifest-pinned production ID. It then limits pairing per identity, creates
  the owner on first pairing and the device, and answers the credential once; only its
  hash is stored. The background writes the credential straight into trusted extension
  storage; it never reaches the settings page. The Worker sends no CORS headers, so no
  web page can read the answer, and pages cannot set an extension `Origin`. An Access
  redirect, a `401`, or a response that is not JSON, such as the Access login page,
  means "sign in first"; a non-JSON `429` or `5xx`, such as a Cloudflare edge error
  page, counts as rate limiting or an unexpected failure instead. On "sign in first" the
  settings page opens `<service>/pair/signed-in` in a new tab once per click, where
  Access signs the browser in and the page asks the user to return; it retries once when
  it is shown or focused again, and offers **Try again** and **Open sign-in page**. A
  refused sign-in, an unlisted extension ID and a service without pairing settings each
  have their own message.
- Lifetime and recovery. A credential expires once it has gone unused for 90 days, and
  each authenticated use renews it; there is no absolute lifetime and no rotation (owner
  decision, 2026-10-11). The service records a device's last use at most once a day
  with a conditional update, so the recorded time can lag by up to a day and a device
  can expire up to a day before 90 days of real non-use. An expired
  credential gets 401 `device_expired`, which the extension handles like a revoked
  device: it stops syncing and asks for a new pairing. A revoked device keeps getting
  `device_revoked`. The Access-protected management page lists the owner's devices
  with their last use, marks expired ones, and revokes devices; a device can revoke
  itself on sign-out. A lost device is
  revoked from another Access login and a replacement pairs again. Revocation stops
  later requests; a request already authenticated may still complete. It stops
  service access only and neither erases offline caches nor touches any vault.

Local tests cover the token's signature, issuer, audience, expiry and subject checks;
the pairing route's Origin list, body validation, per-identity limit, missing CORS
headers and concurrent first pairings; the extension transport's mapping of redirects,
login pages and error codes; the background's storage of the credential; the settings
page's sign-in tab, retry and messages; and, in bundled Chromium with the production
build, a pairing whose request came from the background with the session cookie and
the extension `Origin`, followed by cookie-free `/v1` sync. Cross-owner management,
self-revocation and credential idle expiry with its daily renewal are covered as well.
The browser test's Access stand-in does not model Access's own `401`, denial page or
cookie validation; only the transport unit tests' synthetic responses cover those. JWT
verification worked against the real Access application when the owner paired with
the typed code on 2026-10-11. Credential idle expiry has local tests only so far.

### Owner web UI

Status: design approved by the owner on 2026-10-11, and its reorganisation into Sites
and Devices tabs with a page per site on 2026-10-12 (21:08 UTC). The app, its
Access-checked assets and API, and the devices, sites and site pages are implemented and
tested locally; the deployed service still has the earlier sites, account bindings and
recipes pages until the next deployment. It replaces the extension's settings page
for the data the service holds
([ADR 0013](adr/0013-service-held-recipes-and-settings.md)), except item selection,
field exclusions and custom-field review, which need the device's vault catalog
([ADR 0023](adr/0023-synced-vault-policy.md)).

- Pages. A React app under `/manage`, built with the same approved stack as the
  extension's pages ([ADR 0004](adr/0004-library-composition.md)) and served by the
  Worker as static assets. Its header shows the logo and two tabs, Sites and Devices,
  and its footer the version, links to the source and the GPL text at the built commit
  and to the third-party notices, and the Theme select. React's rendered `<title>` sets
  the tab title to `Devices – Pateat`, `Sites – Pateat` or `<origin> – Pateat`; the
  static HTML keeps `Pateat` before the app renders. Each page is its own path, a full
  page load that the Worker serves only for these paths:
  - Devices (`/manage`): the current list and revocation, moved into the app.
  - Sites (`/manage/sites`): one list of every origin the service holds a recipe, a
    `siteDefaults` entry or a `bindings` entry for, each with badges for its recipe
    count, its default account ("<item> in <account>") and its binding count, and
    opening the site's page; then each `excludedSites` rule (a hostname, optionally with
    its subdomains) with Allow, which deletes it, and a form to add one. Below them,
    Revoked recipes lists each tombstone with its revision and time; a tombstone keeps
    no origin, so it belongs to no site.
  - A site (`/manage/sites/<scheme>/<host>`, one exact origin, the key of defaults,
    recipes and bindings; the Worker serves the app for any host under `http` or
    `https`, and the app shows "No such page." for one that is not a canonical origin):
    a "Pateat on this site" switch with the popup's semantics (turning it off adds a
    rule for the origin's canonical hostname alone, turning it on deletes that rule, and
    a rule that includes subdomains disables it with the reason, since that rule covers
    other sites too); the default account with Remove, which restores the automatic
    single-match choice, and a pointer to the popup for choosing another; the origin's
    active recipes, each with its ID, revision, slots, signed-in markers, rejection
    target, steps, or an entry or chooser recipe's entry, and its JSON, and revocation
    with a tombstone after a confirmation that names the revision shown; and the
    origin's `bindings` entries with Remove, which makes that item fall back to the
    built-in-slot binding. A generated recipe may have no marker yet (ADR 0018).

  The UI does not pick vault items or fields, because the item list exists only on
  devices. Choices are saved by login or by AI generation, and bindings come from AI
  generation. Creating or editing recipe JSON is not offered; development keeps using
  `PUT /v1/recipes/:recipeId`. Item selection and field exclusions are not shown yet;
  once synced ([ADR 0023](adr/0023-synced-vault-policy.md)) the web UI first only lists
  them, and they are edited on the extension's settings page.

  Claude credentials are entered on `/manage/claude`, a temporary script-free page
  ([ADR 0015](adr/0015-per-owner-claude-credentials.md)). The web UI will replace it,
  but its page for Claude credentials is not designed yet.
- Data. The app calls a JSON API under `/manage/api/*`. It does not call `/v1`, whose
  routes accept only device credentials. The API shares the owner-scoped read and write
  code of `/v1/settings` and `/v1/recipes/:recipeId`. Writes carry the revision the page
  last read; a stale write changes nothing and returns the current state. The service
  copy of settings holds no `connections`: the extension uploads none, a web write must
  have none, and the page drops any that another client stored. A web write also stays
  within the 120 KiB document size devices upload. An identity with no paired device has
  no settings to edit and is told to pair one. Devices receive the change on their next
  settings or recipe sync. The device ID columns recording who wrote a settings or
  recipe revision are nullable; null means the web UI wrote it.
- Display names. Site defaults and bindings keep display-only names beside their IDs, so
  the page can name them: `itemName`, the item's label (optional on a site default), and
  an optional `accountName`, the label the owner gave the vault connection the account
  was chosen from on a device. A device sets both when it saves a default or a binding.
  Its settings sync also fills in missing names for entries of a provider account
  connected exactly once there, from the item's label and the connection's label. A name
  already set is kept, even after the item or connection is renamed: devices can label
  one account differently, and a device whose vault has not synced yet still holds the
  old item label, so overwriting would make devices rewrite each other on every sync.
  Saving the default again on a device renames it. Bindings made by AI generation on the
  service have no account name until a device syncs. The page shows the item ID or
  `<provider> account <userId>` where a name is missing. Login usernames are never
  stored there.
- Authentication. The host-wide Access application also covers the app's assets and
  `/manage/api/*`. The Worker verifies the Access token
  on each API request as it does for the current pages, finds the owner by issuer and
  subject without creating one, and accepts a state-changing request only with an
  `Origin` equal to its own. The page's
  Content Security Policy allows scripts from its own origin only, with no framing.

## Identifiers

Every ID that Pateat's production code creates is a UUIDv7 from `newId()` in
[`packages/contracts/src/ids.ts`](../packages/contracts/src/ids.ts): D1 rows such as
`owners.id`, `devices.id` and `inference_log.id`, write and lock IDs, login attempt and
operation IDs, vault and session revisions, connection IDs, the `deviceIdentifier` sent
to Bitwarden and message correlation tokens. UUIDv7 starts with its creation time in
milliseconds, so IDs from one place sort in creation order; code still orders rows by
their `sequence` or time columns. The time is readable by whoever receives an ID, such
as the owner ID in the Claude credential JWT's `sub`. Three kinds of value are not
created IDs and stay as they are: secrets (device tokens and digest keys are random
bytes), content-derived IDs that devices must agree on (generated recipe IDs
`gen-<32 hex>` hash the origin and start path, so devices generating together converge
on one recipe) and log pseudonyms (`bitwarden:5c1e9a` is an HMAC of the connection ID).
IDs from Bitwarden or sites are kept as given, and synthetic probes, tests and the
hosted smoke check may use `crypto.randomUUID()`. Rows created before 2026-10-12 keep
their UUIDv4 IDs; both validate as UUIDs.

## Times

Pateat reads the clock with `Date.now()` and keeps times as epoch milliseconds in
extension storage, IndexedDB and D1, and durations as `*_MS` numbers for timers and
comparisons. In the extension, Chrome's native `Temporal` formats, reads and measures
them (first available in Chrome 144; the current minimum is Chrome 145 for
`Map.prototype.getOrInsertComputed`): `isoTime`, `isoMinute`,
`isoTimeMs` and `isoTimeSchema` in
[`apps/extension/src/time.ts`](../apps/extension/src/time.ts) write and read the ISO
8601 times of the diagnostics report and log export and the stored entry-page presses
and blocks;
the local times on the settings and diagnostics pages, the ages and day counts shown and
the Bitwarden package's checks of server dates use Temporal too. The `Date` header of
the service's health response is an HTTP date, which Temporal does not read, so
`Date.parse` reads it. The service, its owner pages and the packages it imports
(`packages/contracts`, `packages/inference`) use `Date`: workerd has no Temporal and no
compatibility flag that enables it, and lint forbids the global `Temporal` there.

## Deferred interfaces and challenges

Settings read/update, permitted selection, execution requests, status, cancel,
pause and repair operations should be independent of presentation. They can
later serve page UI, the service's HTTPS management UI and MCP. Revalidate caller
authority at every entry point and policy at the executing device. Page UI may
show minimal permitted aliases but cannot grant permissions or remove exclusions.
Use accessible ordinary HTML without extension-origin iframes if added; Shadow
DOM is styling isolation, not a secret boundary.

MCP is low priority and must first prove useful autonomous invocation in intended
clients. A server cannot override their approval settings or action policies.
Design device/target readiness, permitted selection, fill/authentication requests,
status/wait/cancel, failure explanations and bounded repair/pause operations.
Do not return raw passwords, PINs, OTPs or keys. Reject offline-device execution
rather than queueing login for later replay. New tools require their own grants;
MCP does not implicitly grant later writes or post-login operations.

Later challenge adapters retrieve email/SMS codes or continue magic-link
authentication with their own connection and authorization. Bind results to the
intended account, login, origin and expiry. Treat codes and authentication links
as secrets rather than recipe data or model context, and do not treat arbitrary
message links as navigation authority. Provider choices and retrieval transport
belong to that later implementation, not an initial inbox/SMS service.
