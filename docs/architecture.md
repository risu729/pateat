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

DOM-filled values can be read by the receiving page and potentially its debugger.
The local-only vault boundary does not promise invisibility to Chrome use or a
compromised destination page.

## Vault adapter

Distinguish a provider type from a connection and model multiple simultaneous
vault connections from the start. Scope item and field IDs by connection.
Adapters are developer-written and bundled with extension releases; no remotely
loaded executable plugins or speculative second provider implementation.

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
initialization before a security-version floor is checked. The pinned SDK's asynchronous
initialization never settles when it cannot parse those COSE objects and exports no
synchronous parser, so the library first checks their COSE_Sign1 framing locally
(`packages/bitwarden/src/cose.ts`, a strict subset of the SDK's parser) and reads the
version from the payload the SDK has verified. Cipher views withhold the decrypted
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

Local field snapshots detach supported decrypted items from caller mutation.
References bind connection, user, item and snapshot identity; custom fields use
snapshot-scoped positional IDs because Bitwarden does not supply a persistent
field UUID. Resolution requires an explicit field allowlist. Linked aliases
also require permission for every source field, and Boolean fields retain a
typed Boolean result. Metadata lists never include field values or OTP seeds.
The trusted host must assign a fresh snapshot UUID whenever captured item state
changes; caller-supplied identifiers do not prove freshness or authorization.

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

## Settings, eligibility and operation grants

Settings, exclusions, account defaults and inference settings are edited on the
service's owner-authenticated web UI
([ADR 0013](adr/0013-service-held-recipes-and-settings.md)). The extension's settings
page handles vault connection, re-authentication, unlock and service pairing, and still
edits local policy, exclusions and account defaults. The toolbar popup edits only the
active tab's site default account and exclusion, through the same worker-owned store
([ADR 0021](adr/0021-account-choice-outside-settings.md)). Item selection, field
exclusions and custom-field review stay on the extension's settings page once synced
([ADR 0023](adr/0023-synced-vault-policy.md)). The service keeps one settings document
per owner; [ADR 0024](adr/0024-settings-profiles.md) assigns its parts either to a
settings profile that each device will choose later or to the owner. Chrome
use access to these pages is not assumed. Keep settings and execution operations
independent of their UI.

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
eligible provider URI match is used and saved only after the login is `authenticated`; a
saved choice keeps winning when more items match later
([ADR 0013](adr/0013-service-held-recipes-and-settings.md)). Changing it does not log
out the current session. No match or several matches require a choice rather than trying
accounts in turn. Under [ADR 0021](adr/0021-account-choice-outside-settings.md) the
choice is made in the toolbar popup for the refused document and may be one-time. After
a finished login in a tab, the recipe's first step appearing again in that tab's page
asks for a choice again instead of logging in, with the saved default first; the passkey
half of this is not implemented yet. Automatic logout/relogin when the user picks
another account while logged in stays later. Cookies may be shared across tabs even
during initial login. Another tab's login of the origin that is running or ended without
success holds the origin until that tab closes; an `authenticated` one, one that
ended `interrupted` without submitting, or one Pateat itself stopped with nothing in
flight (such as `policy-changed`) does not. A tab keeps one attempt record per
origin and runs one attempt at a time; a page resumes only its own origin's record, and
a top-level attempt that may have submitted ends `left-origin` when the tab moves to
another origin. A record of a site the tab left, including a frame's login on that
site's page, never holds the new site's page or its frames
([ADR 0022](adr/0022-login-attempts-per-tab-and-origin.md)). Wider
shared-session domains need explicit coordination before broader support, not a guessed
relationship between origins.

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
([ADR 0016](adr/0016-recipe-generation-trigger.md)). The request also offers one slot
per custom field a matching item allows (Text, Hidden, or Linked with an allowed
source), named by field name and position, under an opaque ID such as `custom-1`
([ADR 0027](adr/0027-per-account-login-routes.md)). Just before sending, it reads the
matching items' usernames and the values of Text fields and of Linked fields that read
the username or a Text field for their shape, each sent only when all items agree. The
returned recipe enters the recipe cache and starts at once. A page that an effect step
leads to and no check explains is sent to be judged, which can learn the completion or a
second-factor handler ([ADR 0018](adr/0018-recipe-generation-route.md),
[ADR 0027](adr/0027-per-account-login-routes.md); see below). A judgement that changes
the recipe pulls recipes only; settings wait for the next full sync, since a settings
write would stop the login the page belongs to. Inactive, frozen, discarded, and
navigated documents are different states; only live documents can execute.

Do not inject `chrome-extension://` iframes, automatic overlays or unlock windows into
the flow. There is no page UI; use an icon badge, the toolbar popup and manually opened
settings. The one extension window is the passkey chooser of
[ADR 0021](adr/0021-account-choice-outside-settings.md), opened for a pending request
from a focused page, with several matches or after Pateat signed in from the same tab,
and never in incognito. Do not attach our own
debugger in normal operation. Another installed extension can still inject a conflicting
frame; coexistence requires an explicit compatibility test and documented settings.

Use a per-document attempt state machine: detected -> resolving -> filling ->
awaiting-result -> authenticated / retryable / blocked. One writer owns an attempt for a
tab/document, and a tab runs one attempt across all of its frames; other tabs can
progress independently. Revalidate origin, account binding, target elements, and
document immediately before each fill or click. Expire late AI results after navigation
and cancel outstanding work. Synthetic events and lack of trusted user activation may
limit some sites. An attempt starts when a recipe's first step, that of its start-page
`passkey` route or of any of its `password` variants, is ready on the page, including
after a same-document URL change, and each later fill or click waits a bounded time for
its elements ([ADR 0013](adr/0013-service-held-recipes-and-settings.md#recipe-lookup)).
The browser-provided `sender.url` keeps a document's load URL, so the executor takes a
top-level document's current path from the tab's committed URL.

MV3 workers can stop. Persist only resumable metadata, never an instruction to
blindly replay a submit. Input and change handlers can submit without a click.
Declare whether a fill prepares fields, advances a flow or submits it; an
input-triggered advance or submission uses one explicit event and initially one
field. Record intent before any field mutation or event, including preparation
fills. An acknowledgement proves local execution, not remote acceptance.
After interruption around a fill or click, observe the current page and
reconcile the outcome before another attempt. An uncertain fill must not be
repeated merely because the original fields remain visible. Only a confirmed
failure before mutation can permit a bounded retry. Never use an observation
timeout to fall back from an input-triggered submission to a click. Recipes for
ordinary click flows must explicitly describe tested preparation behavior.
Exactly-once effects at a
remote website cannot be guaranteed by local state alone. Apply a finite retry
budget per account/origin, with delay and a terminal outcome for lockout risk.
The submission budget reserves each executor effect before delivery; only a
validated failure proving that the current operation made no mutation can
release its reservation. A separate retry budget still applies. Initiated or
possibly initiated effects remain counted, not proven server requests: one page
handler can itself issue more than one request.
Each fill step writes only inputs inside one form (or only inputs outside any
form). A provider password goes only into a password input, and a TOTP code only
into a one-time-code or short numeric input, so a recipe cannot place them in a
search box. A Hidden custom field goes only into a password or short numeric input,
and a Linked custom field follows the field it reads.
Before a fill step that writes a secret but not the username (a site that remembers
the account and asks only for the password), the background sends the selected item's
username to the content script with that one fill. The content script compares it with
the account identifiers shown in the form, or the page when there is no form, and the
first eight `h1`-`h3` headings; every element boundary separates words, and `mailto:`
links, `<address>` and `<footer>` are skipped as contact addresses. The username never
leaves the content script or reaches status. An email username is compared with shown
email addresses. A username of digits only is compared with masked IDs that show at
least two characters (`****1234`), and only on a step that fills a password or Hidden
field, because a one-time-code page usually shows the masked phone number the code was
sent to. If comparable identifiers are shown and none fits (`myaccount@example.com` or
`****9999` shown while `my2@example.com` or `00001234` is selected), the step fills
nothing and the attempt ends `wrong-account` without a retry or a spent submission. A
masked value consistent with the username (`m***@example.com`, `****1234`) proceeds,
as does an item without a username, a username of another kind (`taro99`) or a page that
shows no comparable identifier. A masked number that is not the account, such as a card
number on a password page, still stops a digits-only username: a known limitation.
A recipe can name an `accountSwitch` target: the button or `<a href>` link that switches
to another account (`{ "by": "text", "value": "Use another account" }`; text locators
match link text only here and in a completion target; the recipe must not use it for a
click step or `rejection`).
When the page shows another account, nothing was submitted in the attempt, and that
target matches exactly one shown link or button that does not submit a form, the
background first records the attempt as `account-switched` (blocked, no submission
spent) and then has the content script click it. The click happens only within 10
seconds, on the same path, while the target still matches exactly that element;
otherwise the record becomes `wrong-account` and keeps holding that origin in the tab.
After the click,
the tab's next document of that origin that reports ready starts a new attempt instead
of resuming, so
a recipe that starts on the page the switch leads to logs in, such as an email page at
`/signin/id` after a password page at `/signin/pwd` that showed `myaccount@example.com`
(owner decision, 2026-10-11). That attempt carries the switch and never clicks another:
a page that still shows another account ends it `wrong-account`. Without the target,
or when it is missing or ambiguous, the attempt ends `wrong-account` as above. A switch
that changes the account in place, without loading a new document, does not continue
the login.
Before a fill step writes anything, the content script checks every value against its
input ([ADR 0010](adr/0010-inference-field-hints.md)): non-empty, within the input's
`maxlength` and `minlength` (ignored on `number` inputs), and a valid email or number
for those input types (`valueMismatch` in `packages/contracts/src/values.ts`). A
22-character password and an input with `maxlength="8"` fills nothing and ends the
attempt `value-mismatch` without a retry or a spent submission. After a preparing fill,
the content script waits 500 ms for the page's own handlers and ends the attempt
`fill-rejected`, without a retry or the click, when a filled input is
invalid (`validity.valid`, which unlike `checkValidity()` fires no `invalid` event),
became `aria-invalid="true"`, or a visible alert shows text that no such region showed
before the fill. Alerts are `role="alert"` and `aria-live="assertive"` regions
anywhere, and `role="status"` and polite regions inside the filled form or named by a
filled input's `aria-describedby` or `aria-errormessage`. A message the page already
showed and renders again is not new, nor is a mark the input had before the fill. The
text stays in the content script; only the outcome leaves it. A fill that submits
through its own event is checked only before filling. When a filled input was replaced
during the wait, nothing is clicked and the attempt observes the page instead.
Explicit credential rejection stops retries with that credential. Structural
mismatch can request bounded repair; unknown submission outcomes require
reconciliation before any resubmission.

A new login reads its item's facts once and records them in its attempt
([ADR 0027](adr/0027-per-account-login-routes.md)): a non-empty, not excluded password
and TOTP field from the catalog's value-free `empty` flags (an allowed Linked field that
reads one counts like it), and any usable or discoverable passkey from one item-scoped
vault search per RP ID the origin may use. The facts never leave the extension. The
attempt also records its route. A recipe may have a start-page `passkey` route, one
click on the start page's passkey sign-in button; it is taken first when the item has a
discoverable passkey, needs no binding, and a login on it that reaches no signed-in page
ends `challenge`: it never falls back to typing the password, and after `authenticated`
it saves only the site default. A recipe's `password` route has one to four variants,
one per identifier set its start page offers (such as branch and account numbers, or a
contract number), and the attempt records the variant it took: the first, in recipe
order, whose binding resolves on the item and whose every bound password or TOTP field,
built in or Linked to one, has its fact; the item's own password must also be present. A
saved binding is the only source for its item, so a variant whose slots it does not hold
is skipped. When none fits, a recipe with one variant refuses the page with that
variant's reason, and a recipe with several refuses it `no-route`, with the first
variant's reason as the logged refusal's detail. A running or resumed login checks only
its recorded variant and never reads the facts again
([ADR 0027](adr/0027-per-account-login-routes.md#implementation-choices)). After each
effect step the executor checks the completion, the rejection and the plan's next step,
then the recipe's handlers on the page's path. A click or an `advance` fill continues
when its next step's elements are unique on that step's path, if that path is another
one. An `advance` whose next route step is on its own path, as an identifier-first form
that swaps in its password form in place, continues only once that step's elements are
ready as the step waits for them (each fill field a shown writable input, a click's
button shown and enabled, an `assert`-present step's element present), none of them was
ready or matched several elements when the content script measured them in the same task
as the click or the fill's first input, just before it, and none is one of the advance's
own elements ([ADR 0013](adr/0013-service-held-recipes-and-settings.md)). This holds in
the same document, after a `history.pushState` that keeps the path, and in a new
document the form posts back to that path once the advance's answer arrived. So a page
that still shows only the account form, or showed the password form from the start,
never continues, and Next is never clicked again; it settles as any advance its next
step never confirmed, after 10 seconds. The measurement is kept in the worker's memory
only, so after a worker restart such an advance settles that way too. As on another
path, the next step comes before the recipe's handlers: a page that shows the password
form beside a handler's elements on that path gets the password, not the handler.
"Shown" is the content script's visibility check, which ignores occlusion, opacity,
off-screen position, `aria-hidden` and `inert`, so a password form revealed under a
captcha or consent overlay counts as ready: a known limitation. A click that submits
never continues on its own path, and handler steps keep their own rules.
A handler that has not run is entered
once per login when all its elements are unique and usable: its code field a shown
writable input, its button shown, enabled or not, since many code pages enable Verify
only once the code is typed (the click step waits for it to be enabled). Its steps
follow the effect step and grow the attempt's step and submission budget (at most 4
handlers, 40 steps and 12 submissions). A `totp` handler whose button is also a route
step's on that path is entered only while none of the route's fill fields there shows. A
handler that already ran counts as shown again when its elements are present at all,
hidden or disabled. The `passkey` handler clicks a button such as "Use security key"
only for an item with a usable passkey. The `totp` handler fills a code from the item's
built-in TOTP field into its code field under the TOTP fill rule and clicks its button
once; it needs the TOTP fact and that field allowed for the account, and a binding that
names another field for the code ends `challenge`, since Pateat cannot make a code from
a custom field yet. When several handlers show, the first that qualifies is entered, a
`passkey` handler before a `totp` handler; one is passed over when it already ran, the
item lacks its fact, or, for a `totp` handler, the login already types a TOTP code
(`code-used`), since a login types at most one code. When every shown handler is passed
over, the attempt ends `challenge`. After the code goes in, the content script watches
the page for 2 seconds before the click: a submit event, the document unloading or
navigating, the field or form disabled, removed or replaced, the field cleared, the
button gone, hidden, busy, disabled after it was enabled or still disabled half a second
after the code went in, or a new busy indicator in the form each mean the page submitted
the code by itself. So do a page that leaves the path or shows the completion or the
rejection without the button before the click, and a new document after the fill. Each
counts as the handler's click (`AUTO_SUBMITTED`); the code is never filled again or
followed by a click. A button rendered again at the same locator and a status message
alone, such as a digit counter, are not signs, and a status message never refuses the
code. While a handler's or the `passkey` route's clicked button, or the button of a code
the page submitted itself, still shows in that document, the page is neither judged nor
settled for up to two minutes; then it ends `challenge`. A new document of the tab that
shows the `passkey` route's button again ends `challenge` at once, and so does one that
shows a handler that already ran and no other that qualifies; a handler shown there that
still qualifies, such as a `totp` handler beside a `passkey` handler that already ran,
is entered. When the result settles, a page no check explains is sent to be judged
unless it still shows a fill field of any of the route's variants on a route path or the
completion marker (on the `passkey` route, its button or a fill field of any `password`
variant on its path or a `password` route path); this applies to later documents of the
tab too, while the attempt has not ended. At most 2 pages count per effect step: the
attempt counts a page once its complete description is in hand, before the request, so a
restart during the request cannot resend without bound. A page is given back only after
a temporary refusal before any model call (a busy service, the service's own 429, an
unreachable service, no paired service, a rejected device, or a request that failed
before the model). Permanent refusals such as `already-judged`, `not-judgeable` or
`recipe-conflict` count, and so do the provider's rate limit, a timeout and an
unexpected answer, which may follow a model call; so a settled login sends at most 2
counted pages per effect step plus retries after temporary refusals. A page whose
description is incomplete, failed or of another path is not sent and does not count. A
handler's click is a new effect step. A `challenge` verdict that added a handler hands
back the newer revision: the attempt takes it over (`REVISED`) when it only adds
handlers or a completion, and runs the handler on the page it is on. A resumed attempt
accepts a newer cached revision on the same terms only while the worker still holds its
recorded revision; after a worker restart only the recorded revision resumes.

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

The worker fetches `/health` only for a paired service with site access, and
`/v1/device` only then and while the service has not rejected the credential, with a 5 s
timeout; that route reads the database and imports the signing key, but signs nothing
and never exchanges a Claude token. It
fetches `{api}/config` only for an enabled connection whose provider permission sync
also requires, with a 5 s timeout and no credentials. It never reads the config's
`environment` (host URLs) or a third-party server's name other than Vaultwarden.
**Copy for bug report** shows the exact text before copying it; that text leaves out the
unlock KDF parameters. It ends with the log's last update
(`Updated <time> from <revision>`), its warnings and errors of the last 24 hours (newest
10, one line each with the time, level, event and allowlisted field values) and the
count of passkey requests left to the browser in those 24 hours by reason. The worker
builds these lines from the log and numbers sites and recipes in them as in a download,
but separately, so `site-1` there can be another site than in **Download logs**. Labels,
emails, item names and IDs, URLs and host names are never part of the summary.

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
| `vault.sync` | info for a result and for `cancelled`, else warn | connection pseudonym, the settings-page Sync's result kind or error code, and the account mismatch check when there is one |
| `vault.refresh` | debug for `refreshed`, else warn | connection pseudonym; `refreshed`, `restored` (the session was put back after a network failure, timeout, 429 or 5xx), `rejected`, `account-mismatch` or `failed` (a non-retryable error drops the claim's refresh token so the sync sign-in needs the password; a store error leaves the claim to resume; a conflict means forget or a password sign-in replaced it); the transport or store error code and HTTP status when there is one |
| `service.sync` | debug for `synced`, `incomplete`, `not-connected`, `busy` unless a recipe was added, updated or removed, then info; info for `unreachable`; else warn | recipe and settings sync outcome; `full`, or `recipes` for a recipes-only run after a judged page; recipes added, updated and removed in the cache |
| `settings.changed` | info | `synced` (a settings sync wrote local settings) or `saved` (the settings page); the settings revision when the entry is written. Running logins and passkey requests stop |
| `login.attempt` | debug when a new page resumes the attempt without changing its state or outcome; otherwise info for `authenticated` and `retryable`, warn for `blocked` and when the result settles as unknown (`unknown-submit`, marked `settled`), so a login that did not finish counts as a warning, else debug | origin, recipe ID, route and `password` variant, state, step, step count, the current step's kind (`fill`, `click`, `wait`, `assert`) and effect (`prepare`, `advance`, `submit`), the entered handler the step belongs to, outcome; for `policy-changed`, its cause and a refused plan's reason |
| `login.handler` | info | origin, recipe ID, handler index, kind, step count; `entered`, `shown-again` (left to the person after this login ran it), `missing-fact` (the item lacks what the handler needs, including a `totp` handler's built-in TOTP field), `code-used` (a `totp` handler in a login that already types a TOTP code) or `no-room` (the attempt's step or submission budget is spent) |
| `login.refused` | debug for `recipe-not-found`, `stale-document`, `generating`, and `tab-busy` in a frame (a held tab refuses every frame on its page, such as ad frames); else info | origin, reason, `frame` for a frame; for `no-route` on a recipe with several `password` variants, the first variant's reason as its detail |
| `recipe.generate` | debug for `skipped` with `no-vault-match`, else info | origin, outcome (`recipe`, `abstained`, `failed`, `unavailable`, `skipped`) and its reason: the abstention, failure or unavailable code, `device-rejected`, `error` for a thrown error, or why nothing was sent (`sending`, `sent`, `no-vault-match`, `incomplete-observation`, `extract-failed`, `no-slots`, `not-connected`, `storage-unavailable`); a page that is not sent is logged once per document |
| `recipe.judge` | debug for `sent`, else info | origin, recipe ID and revision, route; `sent` when the page goes out, then the verdict (`signed-in`, `rejected`, `challenge`, `unclear`, `retry`); for `unclear` and `retry`, the transport, service or model code (for example `already-judged`, `busy`, `timeout`); for a returned revision, whether this login took it over; `not-sent` when the page after an effect step is not sent to the judge, with why: the step's two pages were already sent (`page-limit`), a sign-in field of the route still shows on a sign-in path (`sign-in-shown`), the completion marker shows but does not prove the sign-in, as on another path than its own (`marker-shown`), a field in a shadow root (`shadow-field`), one that cannot be filled (`unfillable-field`: read-only, disabled, transparent or tiny), one without a usable locator (`unlocated-field`), more than 48 fields (`too-many-fields`), nothing to describe (`no-candidates`), a refused path or a description that fails its schema (`unsupported-page`), a response that fails its check (`invalid-page`), a cancelled login (`cancelled`), a page that changed meanwhile (`page-changed`) or could not be asked (`unreachable`) |
| `passkey.request` | info | the passkey report described in [development](development.md#why-a-passkey-request-was-delegated) |
| `error.unhandled` | error | `error` or `rejection`, class name, message only when it is a Pateat error code, up to five `file.js:line:column` positions inside the extension |
| `log.dropped` | warn | origin, events dropped over the page limit |
| `log.debug` | info | when debug logging ends |

Connection and item IDs become HMAC pseudonyms. An origin or RP ID is kept in full only
when a site default, binding, excluded site or cached recipe names it; any other
becomes `origin:7d2b91aa` or `rp:7d2b91aa`. The rule applies when the entry is
written, so a site set up later keeps its earlier pseudonymous entries, also in a
download with site addresses included.

The causes of `policy-changed` are `settings-synced` and `settings-saved` (the settings
changed while the login ran), `settings-revision` (a check found a settings revision
other than the login's, also when a page resumes the login), `settings-unavailable`,
`plan` (the settings or vault no longer allow the login's account on this page, with the
plan's refusal reason such as `connection-disabled`, or `account-changed`),
`vault-replaced` (a vault sync replaced the snapshot that authorized a value before it
was delivered) and `field-unavailable` (a vault field could not be read).

Login, judgement, handler, recipe generation and passkey events are limited to 20 per
minute per tab and origin, and unhandled errors to 20 per minute in all. The first event
dropped in a window is logged at once as `log.dropped` with `count: 1`; the rest are
counted when the window ends and the next event or prune runs, so a worker that stops
first loses only that remainder. `debug` entries are written only for 24 hours after
**Enable debug logging**. Retention: 14 days; `debug` entries for 24 hours; at most
5,000 `debug` and `info` entries (oldest `debug` first, then `info`) and 1,000 `warn`
and `error` entries, pruned at worker start and every 500 writes.

The diagnostics page sends `diagnostics.logs.export` (with `includeSites`),
`diagnostics.logs.clear` and `diagnostics.logs.debug`, accepted from the same page URL
only. **Download logs** previews the exact JSON Lines text and saves it through a `Blob`
link (no `downloads` permission): a header line with the version, revision and export
time, then one line per entry. **Copy all** puts the same text on the clipboard in full,
without selecting the scrolled preview by hand, and reports how many entries it copied.
Unless **Include site addresses and recipe IDs** is checked, every origin, pseudonymized
origin and RP ID becomes `site-N` and every recipe ID `recipe-N`, numbered within that
export. **Clear logs** deletes every entry and replaces the pseudonym key.

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

A generated recipe has no completion target until the page after its first sign-in
is judged ([ADR 0018](adr/0018-recipe-generation-route.md)). Until then the executor
never reports `authenticated` with it: a submission ends `credential-rejected`, moves
to a later step, or stays unknown (`unknown-submit`), so no account choice is saved.
An unknown attempt stays in `reconciling` until its tab closes or, for a top-level
attempt, until the tab shows a page of another origin that Pateat may run on
(`left-origin`, ADR 0022): meanwhile it holds the origin. The extension sends a page
no check explains to be judged, which settles such attempts
([Background execution](#background-execution)).

A login in progress keeps off the writes that would stop it. A passkey chosen in the
chooser as a site default is not saved, nor is an account choice from another tab's
login while this worker runs a login.
The vault replacement waits ([ADR 0025](adr/0025-automatic-vault-sync.md)), and so does
the settings sync's local write, for at most two minutes, counted from the first
deferred write until a sync runs with no login in progress. An attempt counts until it
ends or its result settles as unknown, also between pages and after a worker restart,
and a settled one counts again only while the extension checks or judges one of its
pages. A settled attempt stays until its tab closes, so counting it would use up the two
minutes for every later login. A policy write while an attempt is settled stops it as
`POLICY_CHANGED`, so its later pages are no longer judged
([ADR 0027](adr/0027-per-account-login-routes.md)).

A completion may also list up to four `absent` elements. The executor reports
`authenticated` only when the completion target is unique on its path and every `absent`
element is missing. The completion target may be a link named by its text, such as an
account page link without an `id`, matched as an account switch's is. A learned
completion on a page that signs in on its own path lists that path's sign-in fields
there, because the executor checks the completion after every step and counts hidden
elements: a login page that keeps a hidden "Sign out" link never counts as signed in. A
site that keeps its sign-in inputs hidden in the page after signing in therefore never
reports `authenticated` with such a completion; its attempts stay unknown. A recipe's
completion and absent elements, its rejection and any one step's elements together stay
within one 24-element observation.

A step names its element with an allowlisted locator, never CSS: an `id` or `name` (any
ASCII except whitespace and control characters, as in `ctl00$Main$txtUserId` or
`user[login]`), a `data-testid` (`[A-Za-z0-9_.:-]`), or, for a click or a state check
only, a button's text: `{ "by": "text", "value": "ログイン" }` names the `<button>`
whose rendered text (or, without any, its images' `alt`), the
`<input type="submit|button">` whose value, or the `<input type="image">` whose `alt`
equals the value after whitespace is collapsed (owner decision, 2026-10-11). Hidden
buttons and hidden text inside a button do not count, and text over 120 characters gives
no locator. A script button is a control only scripts make clickable: a script link, or
another element with `role="button"`, but never a form control or anything inside an
`<a href>`. A script link is an `<a>` without `href` that has an `onclick` attribute or
`role="button"`, such as `<a id="login" onclick="document.loginForm.submit()">`, or an
`<a href>` that runs a script instead of following the link: a `javascript:` URL (or a
`data:` or `vbscript:` one, which Chrome never follows from a page), such as
`<a href="javascript:;" onclick="login()">ログイン</a>`, or an empty or fragment-only
`href` on a link with an `onclick` attribute or `role="button"`, such as
`<a id="login" href="#" onclick="document.loginForm.submit()">` (some pages' scripts add
`href="#"` after load). The owner chose on 2026-10-11 that such `href` links are clicked
as buttons, so pages whose login control is one, such as MyJCB and SMBC Direct, can get
a generated recipe. A text locator names a script link by its rendered text, but only
when no native button carries that text, shown or hidden: native buttons are matched
first, so a login tab such as `<a href="#" onclick="...">Login</a>` never makes the
`<input type="submit" value="Login">` below it ambiguous, and a text locator waits for a
hidden native button rather than clicking a script link with its text. A recipe that
names a script link by text clicks a native button instead if the page later adds one
with the same text. Other script buttons are often widgets such as menus and toggles, so
only their `id`, `name` or `data-testid` names them, and the extractor leaves out a
script button without a locator instead of marking the page incomplete. It does the same
for an icon button that never submits (`type="button"` with no text of its own), such as
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
completion marker). A click is not tied to the form the previous fill used: a page that
shows a second, previously hidden button with the same text stops the attempt as
ambiguous, but if the observed button is removed and another button with the same text
remains, that one is clicked.

A text locator is stored in the recipe, unlike observation labels, which only reach
inference. Redaction keeps email addresses and long numbers out of it, but a button
such as "Continue as taro_y" still carries an account name, and so can a completion
marker's link text, such as a header link showing the person's name: the judge is told
never to pick one, and text with a digit never names a marker, but nothing enforces the
rest. Recipes are per owner today; before recipes are shared between users, such
locators need a review.

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
lives in `packages/contracts` and the offline role adapters in `packages/inference`;
see [AI evaluation harness progress](plan.md#ai-evaluation-harness-progress).
Exclude values, hidden inputs,
raw HTML, screenshots, query strings, and unrelated page text by default. A page whose
path may carry a session ID or another token is not observed, so such a path never
reaches the service or its request log
([AI evaluation harness progress](plan.md#ai-evaluation-harness-progress)). Labels
can contain private data too: sanitize and bound them, with privacy fixtures and
an abstention path when a useful safe observation cannot be constructed. The owner
chose on 2026-10-11 to redact observed text before it is sent: email-like strings,
including masked ones, become `[email]`; runs of three or more `*`, `●`, `•` or `＊`
become `[masked]`; and runs of four or more ASCII or fullwidth digits become
`[number]` (`口座番号 ****1234` becomes `口座番号 [masked][number]`). Names cannot be
detected and stay. When such a page already shows a chosen account and offers a
button or link to use another one, the generation role may name it as the plan's
`accountSwitch`; it must be an observed button or link that the plan neither fills nor
uses as its action. The generated recipe keeps the first switch a page names that no
step clicks. Only links inside the login form are observed, so a switch link outside it
is not named. A button whose text a link elsewhere on the page shows too, and a button
that would submit a form, are never clicked as a switch; the attempt then ends
`wrong-account`. Locating links by text means in-form links without an `id`, `name` or
`data-testid` are now observed as well, with their redacted labels, and a switch
link's redacted rendered text is stored in the recipe. Model
output must pass structural and semantic checks on the server and again locally.
Screenshot, audio and video collection are deferred. A provider's multimodal
support does not enable these inputs without a separate privacy/evaluation gate.

Use a cached compatible recipe first. On structural mismatch or repeated genuine
recipe failure, request repair within a separate bounded inference budget. Wrong
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
assigning `get`, so it answers claimed requests first. Conditional mediation and
real-extension coexistence require separate compatibility tests.

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
It shows only item names, passkey user names and connection labels. The background
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

While a login is running, a request from its tab and top-level origin is answered with
that login's own vault item only, never the site default or the chooser
([ADR 0027](adr/0027-per-account-login-routes.md)). A login counts as running while its
stored attempt record for that tab and origin is neither `authenticated` nor `blocked`
and its result has not settled as unknown since it last moved on. The record carries
that settled mark, so the rule holds the same after a worker restart, and a stored
record that neither ends, settles nor resumes keeps scoping its tab and origin to the
same item until the tab closes. When that item holds no single signable match, or its
search is incomplete, the request is delegated, so Pateat never signs in as another
account.

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

Status: implemented. The owner asked on 2026-10-11 for common-sense per-owner limits
sized for their own use; Claude chose these amounts. Revisit them, and add a byte
quota, before the service is offered to other people.

- Requests. The `OWNER_LIMITER` rate-limit binding allows 120 requests a minute per
  owner on `/v1`, counting all of the owner's devices together, and 120 a minute per
  verified Access identity on `/manage/api`. The check runs right after authentication
  and before any body is read; a refused request gets 429 `rate_limited` with
  `Retry-After: 60`. The hosted limiter is approximate and counts per Cloudflare
  location. `/pair` keeps its own 10 a minute per verified Access identity. Recipe
  generation is also bounded by spend and one call at a time
  ([ADR 0018](adr/0018-recipe-generation-route.md)).
- Recipes. An owner holds at most 1,000 active recipes. Creating a recipe or
  republishing a tombstone beyond that answers 409 `recipe_limit`; updating or revoking
  an active recipe always works, and a revocation frees its place. Generation answers
  `unavailable` with `recipe-limit` before any model call when a first page would add a
  recipe, or after the call if the last place was taken meanwhile.
- Recipe history. Each recipe keeps its newest 10 revisions; a winning write deletes
  older ones in the same D1 batch, and a revocation keeps only the tombstone. Nothing
  reads older revisions. At the 128 KiB body limit this bounds an owner's active recipes
  to about 1.2 GiB; generated recipes are a few KiB each. Tombstones are not counted:
  each is two small rows and one change-feed entry, left for the later byte quota.
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
  The route sits behind Access; the Worker verifies the token and requires
  `Origin: chrome-extension://<id>` for an ID in `PAIRING_EXTENSION_IDS`, which lists
  Pateat's manifest-pinned production ID. It then limits pairing per identity, creates
  the owner on first pairing and the device, and answers the credential once; only its
  hash is stored. The background writes the credential straight into trusted extension
  storage; it never reaches the settings page. The Worker sends no CORS headers, so no
  web page can read the answer, and pages cannot set an extension `Origin`. An Access
  redirect, a `401`, or a response that is not JSON, such as the Access login page,
  means "sign in first"; a non-JSON `429` or `5xx`, such as a Cloudflare edge error
  page, counts as rate limiting or an unexpected failure instead. On "sign in first" the
  settings page opens `<service>/manage` in a new tab once per click, retries once when
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

Status: design approved by the owner on 2026-10-11. The app, its Access-checked assets
and API, and the devices, sites, account bindings and recipes pages are implemented,
tested locally and deployed with the service. It replaces the extension's settings page
for the data the service holds
([ADR 0013](adr/0013-service-held-recipes-and-settings.md)), except item selection,
field exclusions and custom-field review, which need the device's vault catalog
([ADR 0023](adr/0023-synced-vault-policy.md)).

- Pages. A React app under `/manage`, built with the same approved stack as the
  extension's pages ([ADR 0004](adr/0004-library-composition.md)) and served by the
  Worker as static assets. The first version has these pages:
  - Devices: the current list and revocation, moved into the app.
  - Sites: add and delete `excludedSites` entries; list and delete `siteDefaults`
    entries. Deleting a default restores the automatic single-match choice.
  - Account bindings: list and delete `bindings` entries. Deleting one makes that item
    fall back to the built-in-slot binding.
  - Recipes: list active and revoked recipes, show one recipe's steps, completion and
    rejection targets and its JSON, and revoke it with a tombstone. A generated recipe
    may have no completion yet (ADR 0018).

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
