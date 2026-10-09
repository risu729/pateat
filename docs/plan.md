# Implementation plan

Status: proposed; all milestones are unstarted. This plan becomes the single
work tracker in the repository until an issue is needed for a concrete slice.
Issues and PRs link to these gates rather than maintaining a second roadmap.

## Ordered milestones

| Milestone                                     | Deliverable                                                                      | Acceptance evidence                                                                                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M0: Documentation bootstrap                   | Empty main root, repository settings, this docs PR                               | Empty tree/root verified; rules read back; independent docs review. Owner merges separately                                                                                                                                    |
| M1: Tooling and runtime probes                | WXT skeleton, shared Valibot contracts, mise/hk, mandatory CI                    | Frozen installation; full checks; packaged extension build; early injection/background execution in isolated Chromium and a small installed-Chrome/Chrome-use dummy-page coexistence probe; compatible cf/Workers test harness |
| M2: Local login engine                        | Dummy vault adapter, declarative recipes, deterministic form executor            | Multi-field/multi-page fixtures; background, navigation, interruption and concurrency tests; no automatic extension UI                                                                                                         |
| M3: Bitwarden passwords                       | First real adapter, local sync/crypto, persistent unlock, custom fields and TOTP | Synthetic protocol/crypto vectors; restart/unlock; read-only behavior; explicit unsupported cases; controlled account test only when authorized                                                                                |
| M4: Private recipe service and inference      | Worker+D1, enrollment, recipe sync, Claude adapter, optional Jev evaluation      | Tenant isolation, revocation, redaction, offline cache, malformed AI output and bounded retry/cost tests; provider selection evidence                                                                                          |
| M5: Existing software passkeys                | Request bridge and Bitwarden-backed assertion capability                         | Standards/wire vectors, RP ID and cancellation tests, counter/UV policy decided, controlled interoperability; no registration                                                                                                  |
| M6: Integrated acceptance and server delivery | Chrome use coexistence, operational docs, hosted service release                 | Installed Chrome dummy-account tests plus artifact-verified deployment and hosted synthetic smoke checks; measured limits documented                                                                                           |

M1's small cf compatibility probe may precede a backend skeleton; it must not
provision resources. M2 starts with a dummy adapter so login correctness does not
depend on account secrets. Bring the WebAuthn document-start probe forward into
M1; defer full signing to M5. Each milestone can be several focused PRs.

## Mandatory acceptance matrix

| Area                  | Minimum cases                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab/document identity | Inactive live tab, active-tab switch during inference, two tabs, nested/cross-origin permitted frames, navigation invalidating a late response, frozen/discarded tab classification                                                                                       |
| Login execution       | Branch/account/password, username then password/passkey, dynamic React inputs, delayed render, success versus credential rejection/MFA/network error, no duplicated click after restart                                                                                   |
| MV3 and coexistence   | Worker suspension/restart, browser restart, no page extension iframe, official BW coexistence, actual Chrome use attach and concurrent input                                                                                                                              |
| Secret boundary       | Malicious page messages, origin mismatch, redirects, unauthorized frames, storage access level, redacted observations/logs, no secrets in server/provider payloads                                                                                                        |
| Vault                 | PBKDF2 and Argon2id, authenticated ciphertext corruption, encoding, organization/custom fields capability, TOTP clock behavior, sync expiry, persistent unlock and revocation                                                                                             |
| Passkeys              | Existing software key, secure context, RP ID/public suffix, challenge, ancestor/topOrigin/crossOrigin, denied iframe Permissions Policy, allowCredentials/userHandle, signature encoding, UV/UP policy, counters, abort/timeout, competing provider/conditional mediation |
| Service/AI            | Device ownership, replay/revocation, schema compatibility, offline cache, injection text, nonexistent targets, refusal/truncation/timeout/rate-limit, shared spend and attempt limits                                                                                     |

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
- Finalize passkey counter synchronization and truthful UV/UP behavior before M5.
  Fully unattended operation is not guaranteed for all requested ceremonies.
- Settle device enrollment/recovery and inferencing spend limits before service
  deployment. Verify actual Anthropic Console credit before paid inference.
- Benchmark Claude and Jev on the same Japanese/English synthetic login corpus:
  semantic correctness, false-submit count, abstentions, p50/p95 latency and
  cost. No fixed model, latency promise or automatic provider fallback yet.

Extension publishing/CD, additional vault adapters, public recipe sharing,
passkey creation, hosted browser installation, and native helpers are outside
this plan. Extension build and automated tests remain in CI scope.
