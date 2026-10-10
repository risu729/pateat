# Implementation plan

Status: M0 completed in [PR #1](https://github.com/risu729/pateat/pull/1).
M1-M3 are in progress; M4-M6 are unstarted. The current foundation is not a working
autologin product or a completed M1 acceptance claim.
This plan becomes the single work tracker until an issue is needed for a concrete
slice.
Issues and PRs link to these gates rather than maintaining a second roadmap.

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
requires an explicit allowlist for both a linked alias and its source fields.
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
execution remains a separate integration gate. Provider authentication remains transient
in this slice; service-worker restart can require sign-in again for remote sync, while
the local cached vault restores independently. Durable provider-session refresh and
revocation remain required M3 follow-up work.

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

- The URI matcher is not yet connected to live vault data and site execution.
  Prepared accounts do not yet retain domain or equivalent-domain context; do not
  derive `allowedOrigins` from URIs without it.
- The live vault is not yet connected to the declarative executor.
- Real Bitwarden connections, individual MFA methods and optional host-permission
  prompts in installed Chrome remain separate gates.

## AI evaluation harness progress

`packages/inference` holds the first offline M4 slice. A proposed sanitized observation
contract carries bounded, value-free element roles, locators and labels; incomplete
observations are rejected before inference. The generation/repair role uses AI SDK
structured output and the finite-choice role uses the SDK decision contract with an
explicit none option per question. Both resolve observation-local candidate IDs, check
slot/role compatibility, joint mapping uniqueness and the shared recipe step contract,
and return explicit ok, abstained or failed outcomes with per-attempt usage where
missing usage is unknown. Retries default to none and are bounded; timeouts, caller
cancellation and complete-request byte limits are enforced locally.

A 15-page synthetic Japanese/English corpus covers bank branch/account/password,
identifier-first and password steps, one-time codes, decoy search/sign-up/SSO controls,
label injection, unlabeled ambiguity and a page without a login form. The harness
reports semantic accuracy, false submits, abstentions, joint-mapping rejections,
errors, p50/p95 latency and usage. Fake-provider tests cover malformed output,
nonexistent targets, malformed probabilities, refusal, truncation, timeout, rate limits,
oversized and incomplete inputs and the absence of fallback.

No provider or model is selected and no paid inference has run. Remaining M4 AI work:
provider adapters after owner selection, real benchmark runs and their report, the
service route and monthly spend stop, and the extension observation extractor with
privacy fixtures. Move the observation contract to `packages/contracts` when the
service shares it.

## Initial delivery and later scope

The [architecture](architecture.md) owns the product contracts. These boundaries
order delivery; deferred capabilities remain product scope, without requiring
their implementation in M1-M6.

Initial delivery includes a human-operated extension settings page, multiple
vault connections, connection/item/field/site policies, saved site account
defaults, local cached-recipe execution, Bitwarden password/custom-field/TOTP
use, and existing zero-counter software passkey assertions. The first server
configuration uses Cloudflare Access, server-readable private settings sync and
server-side AI. The local core must remain usable without the Pateat service.

Later work includes independently permitted vault create/update operations,
nonzero passkey counter writeback and passkey creation; Bitwarden provider login
with passkeys, API keys, SSO or device approval; external email/SMS OTP and magic
links; and separately authorized post-login actions, including transactions and
approvals. UI extensions, account switching, direct AI, additional service auth,
E2EE settings sync and MCP are also deferred. They are extension points, not
implicit permissions or initial acceptance requirements.

## Ordered milestones

| Milestone                                     | Deliverable                                                                                              | Acceptance evidence                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0: Documentation bootstrap                   | Empty main root, repository settings, this docs PR                                                       | Empty tree/root verified; rules read back; independent docs review. Owner merges separately                                                                                                                                    |
| M1: Tooling and runtime probes                | WXT skeleton, shared Valibot contracts, mise/hk, mandatory CI                                            | Frozen installation; full checks; packaged extension build; early injection/background execution in isolated Chromium and a small installed-Chrome/Chrome-use dummy-page coexistence probe; compatible cf/Workers test harness |
| M2: Local login engine and settings           | Dummy vault adapter, settings page, multi-connection policies, saved site defaults, declarative executor | Multi-field/multi-page fixtures; policy precedence, excluded-site pass-through, background, navigation, interruption and concurrency tests; no automatic extension UI                                                          |
| M3: Bitwarden passwords                       | First real adapter, local sync/crypto, persistent unlock, custom fields and TOTP                         | Synthetic protocol/crypto vectors; supported environment/authentication and TOTP cases below; restart/unlock; no vault writes; explicit unsupported cases; controlled account test only when authorized                        |
| M4: Private settings/recipe service and AI    | Worker+D1, Access enrollment, settings/recipe sync, role-specific AI adapters, Clef/Jev evaluation | Owner/device isolation, revocation, redaction, offline cache, revision conflicts, malformed AI output, bounded complete inputs, explicit abstention, retry and monthly spend-stop tests; provider selection evidence |
| M5: Existing software passkeys                | Request bridge and Bitwarden-backed zero-counter assertion capability                                    | Standards/wire vectors, RP ID and cancellation tests, truthful UV/UP policy, controlled interoperability; reject nonzero counters; no registration                                                                             |
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
| Passkeys              | Existing zero-counter software key, nonzero-counter rejection, secure context, RP ID/public suffix, challenge, ancestor/topOrigin/crossOrigin, denied iframe Permissions Policy, allowCredentials/userHandle, signature encoding, truthful UV/UP, abort/timeout, competing provider/conditional mediation                                                      |
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
- Establish truthful UV/UP behavior before M5. Initial assertions use existing
  zero-counter keys; nonzero-counter synchronization is deferred. Fully unattended
  operation is not guaranteed for all requested ceremonies.
- Settle device enrollment/recovery, credential lifetime, AI pricing sources and
  the monthly monetary budget default before service deployment. Initial spending
  control aggregates usage and stops later inference after the limit is reached;
  in-flight/concurrent requests can overshoot. Atomic maximum-cost reservation is
  not required. Verify actual Anthropic Console credit before paid inference.
- Benchmark generation/repair and finite-choice roles separately on the same
  Japanese/English synthetic login corpus. Evaluate Claude for generation and
  Clef-flash, Clef and Jev for decisions: semantic correctness, false-submit count,
  abstentions, joint mapping consistency, p50/p95 end-to-end latency and usage/cost.
  Test invalid candidate IDs, malformed probabilities, context overflow and incomplete
  observations. Clef vendor latency/price claims are research inputs, not Pateat
  measurements. Present results to the owner for provider/model selection; evaluation
  does not authorize adoption. There is no latency promise. Use only the configured
  provider/model for each role; its failure is an error, not an automatic fallback.
  Existing local recipes continue after an AI/budget failure.

Before implementing deferred features, add their concrete slice and evidence to
this plan: write capabilities need independent connection permissions and no
automatic permission upgrade; post-login actions need site/action authorization
separate from credential use; provider passkey login needs authentication versus
vault-unlock and PRF/RP/origin checks; external challenge adapters need explicit
channel permissions. None requires a blanket prompt on every operation once a
user has authorized its supported scope.

Future page UI must avoid extension iframes, preserve accessible keyboard/focus
behavior and recheck policy locally. HTTPS management UI and MCP must share the
internal operation contracts. Before implementing MCP, verify that the target
client can autonomously invoke allowed dummy operations after connection approval;
MCP does not bypass client rules. One-time account overrides and automatic
logout/re-login require shared-session/race tests. Direct AI requires trusted
extension key storage and provider compatibility tests. Alternative service auth,
E2EE sync and Vaultwarden require their own interoperability/recovery evidence.

Extension publishing/CD, public recipe sharing and hosted browser installation
are outside the current delivery plan. Extension build and automated tests remain
in CI scope. Native helpers are not required by the product.
