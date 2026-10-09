# Proposed architecture

Status: proposed; no runtime is implemented. See [the plan](plan.md) for gates.

## Product boundary

A Chrome MV3 extension logs into the user's configured accounts, including
background tabs operated by another browser agent. Bitwarden is the first vault
adapter, not the product identity. Passwords, custom fields, TOTP, and existing
exportable software passkeys belong in scope. Another vault can be added behind
the same narrow capability boundary when there is a concrete second integration.

The client must work without a native helper or desktop daemon. A remote service
may generate and synchronize recipes. Cached recipes and locally available vault
material must remain usable when that service is unavailable.

Configure accounts and site permissions once, then automatically fill and submit
login forms. Cover multi-page flows and separate branch/account/password fields,
including a username step before a passkey request. Login completion ends this
executor's responsibility; it does not perform transactions, account changes,
credential registration, or CAPTCHA solving. Unsupported challenges produce a
specific result instead of indefinite retries.

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
| Worker API + D1         | Private recipe revisions, device authorization, bounded inference                          | Service credentials only; no vault values or keys               |
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

Expose capabilities, eligible local credential references, semantic field
resolution, sync freshness, and a sign operation. Keep provider-specific cipher
formats and authentication inside the adapter. Do not design a public plugin
marketplace or implement a second provider before validating Bitwarden.

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

Read-only vault access is the default. Password/TOTP retrieval does not write
back. Existing passkeys with nonzero counters may require a synchronized update;
do not silently reset counters or advertise universal read-only passkey support.
Expose this as an adapter capability and settle the counter strategy before
enabling affected credentials.

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
blindly replay a submit. After interruption around a click, observe the new page
and reconcile the outcome before another attempt. Exactly-once effects at a
remote website cannot be guaranteed by local state alone. Apply a finite retry
budget per account/origin, with delay and a terminal outcome for lockout risk.

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
User-specific item IDs and field mappings stay local. AI may map meanings to
observed candidates; it cannot choose a different vault account or relax the
origin policy. Multi-origin SSO needs an explicit configured transition policy.

Extract an allowlisted observation before filling. Exclude values, hidden inputs,
raw HTML, screenshots, query strings, and unrelated page text by default. Labels
can contain private data too: sanitize and bound them, with privacy fixtures and
an abstention path when a useful safe observation cannot be constructed. Model
output must pass structural and semantic checks on the server and again locally.

Use a cached compatible recipe first. On structural mismatch or repeated genuine
recipe failure, request repair within a separate bounded inference budget. Wrong
credentials, MFA, network errors, and account lockout do not trigger endless
relearning or reset submission limits. Inference can abstain, refuse, time out,
or return invalid output; all have explicit local outcomes.

## Existing passkeys

Register the MAIN-world bridge at document start without waiting for remote
configuration. Relay permitted WebAuthn requests to local signing code, then
return standards-compatible assertions. Validate challenge, RP ID, origin,
allowed credential IDs, userHandle, algorithm, signature encoding, backup flags,
counter behavior, cancellation and timeout. Implement existing-key assertions
first; creation/registration is out of initial scope.

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

Use one Cloudflare Worker and D1 for private device-scoped recipe revisions and
inference requests. Do not add queues, Durable Objects, browser rendering,
vector search, or an agent framework without a demonstrated need. Use bound SQL
parameters; no ORM is required initially.

Initial enrollment pairs a device with an owner through setup. Store only hashed
revocable high-entropy device credentials server-side; scope every query and
write by verified owner/device. CORS is not authentication. No shared universal
credential is shipped in the extension. Enrollment transport, expiry, and recovery
are a pre-service acceptance gate, not an invented finished authentication flow.

Version recipes immutably with a current pointer and revocation/tombstones.
Sync with conditional reads/cursors and keep a local durable cache. Validate
minimum supported schema, origin scope and device access; reject stale or
incompatible results. Start private per owner. Public recipe sharing and
cross-user learning are deferred to a separate design.

Provider keys reside in Worker secrets. Keep provider selection independent of
recipe contracts: generative Claude for new bounded recipes is the first
candidate, Jev for finite choices is an optional measured optimization. Known
recipes replay locally. Enforce per-device and global request/cost limits,
timeout, cancellation, bounded retries, and sanitized diagnostics.
