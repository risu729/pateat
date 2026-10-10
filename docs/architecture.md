# Proposed architecture

Status: accepted reference design. The foundation implements local metadata-only policy
settings, status contracts, a localhost-only synthetic executor probe and a
health-only Worker. The capabilities below remain planned unless
[the plan](plan.md) records their implementation and evidence.

## Product boundary

A Chrome MV3 extension logs into the user's configured accounts, including
background tabs operated by another browser agent. Bitwarden is the first vault
adapter, not the product identity. Passwords, custom fields, TOTP, and existing
exportable software passkeys belong in scope. Another vault can be added behind
the same narrow capability boundary when there is a concrete second integration.

The client works without a native helper, desktop daemon or Pateat account.
Local settings, eligible vault material, explicit field mappings and compatible
saved recipes remain usable without a Pateat server. Missing recipes produce an
explicit result rather than guessing. Bitwarden sync still needs its own service.
An optional self-hosted Worker provides the initial inference and settings/recipe
sync path. Direct extension-to-AI calls with user-owned keys are a later option,
not the recommended initial setup.

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
| MV3 service worker      | Vault sync/decryption, account selection, recipe cache, attempt coordination, signing      | Yes, extension-owned contexts only                              |
| Isolated content script | Extract sanitized form structure, validate document identity, execute fixed DOM operations | Only the specific values being filled, briefly                  |
| MAIN-world bridge       | Mediate WebAuthn requests and return results to the site                                   | No vault keys; assertions necessarily reach the requesting site |
| Settings page           | Initial account/device setup, policy, status and recovery                                  | Deliberate user setup only; no auto-opening during login        |
| Worker API + D1         | Private settings and recipe revisions, device authorization, bounded inference             | Service credentials only; no vault values or keys               |
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

The initial transport library fixes service paths for each selected environment.
Reject endpoint credentials, query/fragment components and unsupported custom
service layouts. Do not follow redirects or send browser cookies. Each provider
operation owns its method, path and request shape; no generic authenticated
request function is exposed. Bound response bytes while reading, support explicit
cancellation and report sanitized errors without request bodies or tokens.
Prelogin, password/refresh-token requests and encrypted sync are isolated library
operations; settings does not yet create an authenticated extension connection.
Password requests accept explicit manual authenticator/email codes and new-device
OTP values. Return bounded challenge categories and provider IDs, never raw
challenge parameters, server descriptions or URLs. Code delivery and interactive
providers need separate integration. Keep successful token and encrypted-account
results local; they do not establish account ownership or unlock a vault by
themselves. Preserve unknown encrypted format metadata
for later crypto validation; successful HTTP parsing does not prove decryptability
or authorize use of a newly fetched snapshot.
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

The isolated local-crypto library uses the owner-approved official OSS SDK,
with no SDK HTTP/token provider. It validates supported input shapes, rejects
partial decryption and binds each session to one connection. V2 initialization
verifies signed state before a security-version floor is checked. Disposal
withholds stale results; native cleanup waits for in-flight operations, while
Worker termination is the hard cancellation boundary. The current browser host
is synthetic-only. Local password-authorization hashing uses the SDK's primary
KDF followed by native WebCrypto's protocol-specific single-iteration PBKDF2.
Preserve the password exactly and normalize the authentication salt according to
the pinned SDK, independently of vault-unlock parameters. Provider settings,
cache reconciliation and persistent unlock still need their own integration and
acceptance tests.

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

Persistent automatic unlock across browser restarts is a requirement. Store
encrypted vault data and the necessary unlock material locally, not in browser
sync. Restrict storage access to trusted extension contexts, exclude secrets from
logs/backups/telemetry, and define revoke/lock/delete behavior. This intentionally
accepts the local-device risk of retaining a usable decryption key. An
extension-only design cannot claim native OS-keystore protection it does not use.
Initial setup and server-side session/MFA expiry remain distinct from unlocking
a local cache. Authentication failure must not erase a usable cache silently.

Initially vault use does not write back: passwords, TOTP and counter-zero
assertions only. Nonzero counters produce an unsupported result. Do not reset
them to zero or keep an unsynchronized local substitute. Later writeback needs
provider sync/conflict handling and separate read, create and update grants per
connection. New capabilities do not automatically gain grants. Future automatic
password saving can be enabled without confirmation on every save, within those
grants and applicable policy. Read-only is an initial scope, not the provider API.

Handle all custom field types: Text, Hidden, Boolean and Linked. Preserve leading
zeros and duplicate names; use stable field references rather than a name-only
map and resolve Linked fields to their source. Second passwords and card PINs
are valid field roles. Prefer explicit mappings; abstain from ambiguous mappings
instead of trying every candidate. Values never go to inference.

Generate TOTP locally and preserve stored parameters. Test raw Base32, standard
TOTP URIs and Bitwarden's Steam variant. Unsupported OTP formats must not be
silently interpreted as TOTP. Bitwarden setup's manually entered verification
codes are distinct from future automatic email/SMS challenge retrieval.

## Settings, eligibility and operation grants

Ship a human-operated extension settings page from the start, usable without a
server. Include connections, exclusions, account defaults, inference settings,
service connection, status and recovery. Chrome use access to this page is not
assumed. Keep settings and execution operations independent of their UI.

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

The initial account choice is a saved site default applied on the next login.
Changing it does not log out the current session. Missing or ambiguous selection
requires configuration rather than trying accounts in turn. One-time overrides
and automatic logout/relogin are later operations. Cookies may be shared across
tabs even during initial login. The first executor conservatively locks an origin
to one owner tab until closure; wider shared-session domains need explicit
coordination before broader support, not a guessed relationship between origins.

Credential eligibility does not grant arbitrary post-login actions. Later
transactions/approvals require separate site/action grants and deterministic
execution checks. Users may preauthorize bounded automatic operations without
confirmation every time; AI cannot expand those grants. The initial action
vocabulary contains login operations only.

## Background execution

Address tabs explicitly by `tabId`, frames by `frameId`, and documents by
`documentId`. Never select the target by whichever tab happens to be active.
Use declarative content scripts/host permissions and browser events, not a popup
or focus event as the execution trigger. Inactive, frozen, discarded, and
navigated documents are different states; only live documents can execute.

Do not inject `chrome-extension://` iframes, automatic overlays, unlock windows,
or passkey choosers into the flow. Start with no page UI; use an icon badge and
manually opened settings. Do not attach our own debugger in normal operation.
Another installed extension can still inject a conflicting frame; coexistence
requires an explicit compatibility test and documented settings.

Use a per-document attempt state machine: detected -> resolving -> filling ->
awaiting-result -> authenticated / retryable / blocked. One writer owns an
attempt for a tab/document; other tabs can progress independently. Revalidate
origin, account binding, target elements, and document immediately before each
fill or click. Expire late AI results after navigation and cancel outstanding
work. Synthetic events and lack of trusted user activation may limit some sites.

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
Explicit credential rejection stops retries with that credential. Structural
mismatch can request bounded repair; unknown submission outcomes require
reconciliation before any resubmission.

Chrome use coordination is an open integration gate. Expose a scoped status
contract for a future trusted consumer, but do not assume Chrome use already
waits for it. Coexistence tests must include overlapping actions; avoid claiming
race-free operation before a wait/ownership mechanism is established.

## Declarative recipes and AI

Share Valibot contracts for observations, recipes, inference results, and sync.
A recipe contains schema/version, allowed origin/path applicability, structural
fingerprint, semantic slots, stable element candidates, bounded steps, completion
and failure conditions, and provenance. The vocabulary is packaged code such as
fill, click, wait-for-state, and assert-state. There is no eval, remote JavaScript,
arbitrary fetch, or model-selected secret destination.

Site recipes contain meanings such as branch-number/account-number/password.
Keep account-specific bindings separate and resolve them locally. Optional
private settings sync may store references/bindings, never credential values;
these private bindings do not belong in AI input. Multi-origin SSO needs an
explicit configured transition policy.

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

Extract an allowlisted observation before filling. Exclude values, hidden inputs,
raw HTML, screenshots, query strings, and unrelated page text by default. Labels
can contain private data too: sanitize and bound them, with privacy fixtures and
an abstention path when a useful safe observation cannot be constructed. Model
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
standards-compliant verification. Do not spoof successful verification as the
default design. Determine which requests can complete unattended and explicitly
block or request a supported ceremony for the rest. Hardware-bound keys cannot
be unlocked merely by changing flags. Conditional mediation and simultaneous
official-Bitwarden interception require separate compatibility tests.

## Minimal service

Use one optional Cloudflare Worker and D1 for private settings/recipe revisions
and inference. Do not add queues, Durable Objects, browser rendering,
vector search, or an agent framework without a demonstrated need. Use bound SQL
parameters through the approved Drizzle integration, with Hono for API routing
and middleware. Owner scope, conditional revision writes and D1 batch behavior
remain explicit application responsibilities. These integrations are planned,
not implemented by the current health-only Worker.

Initial human service authentication uses Cloudflare Access, validated through a
supported integration or verified JWT, not an untrusted email header. Access-free
OIDC/passkey authentication is a later adapter. Self-hosting is the target, but
owner-scoped data allows other operators to serve multiple users later.

Enrollment pairs a device with a verified owner through setup. Store only hashed
revocable high-entropy device credentials server-side; scope every query and
write by verified owner/device. CORS is not authentication. No shared universal
credential is shipped in the extension. Enrollment transport, expiry, and recovery
are a pre-service acceptance gate, not an invented finished authentication flow.
Separate Access-protected enrollment from device-authenticated API routes: a
device token does not automatically pass an Access gate. Steady-state API access
must not require an interactive Access cookie for each call. Service login does
not authenticate or unlock a vault.

Initial synced settings are server-readable so service login can restore them
without another recovery key. E2EE settings sync is a later option. Provider
sessions, vault values and unlock material remain device-local. Deployment
configuration lives in cloudflare.config.ts, operator keys in Worker secrets,
and runtime settings/recipes in D1. Use revision-checked settings updates,
explicit conflicts and a durable local last-known-good cache; stale sync must
not silently overwrite newer restrictions. Server revocation stops server
access, not guaranteed erasure of offline cached material.

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

## Deferred interfaces and challenges

Settings read/update, permitted selection, execution requests, status, cancel,
pause and repair operations should be independent of presentation. They can
later serve page UI, optional HTTPS management UI and MCP. Revalidate caller
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
