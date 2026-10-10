# Implementation plan

Status: M0 completed in [PR #1](https://github.com/risu729/pateat/pull/1).
M1 and M2 are in progress; M3-M6 are unstarted. The current foundation is not a working
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
assembly. Installed Chrome/Chrome use coexistence remains a separate, untested M1 gate;
the synthetic Playwright result does not replace it. Code Quality setup must be
rechecked after language detection; its existing required rule is retained.

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
The declarative executor, real provider protocol and actual Chrome use coexistence
remain unimplemented or unverified; neither M1 nor M2 is complete.

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
- Choose Argon2id implementation after interoperability, memory/time, browser
  lifecycle and maintenance checks. Use native crypto where it matches the
  protocol; do not implement cryptographic primitives ourselves.
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
