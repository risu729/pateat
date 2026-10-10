# Documentation

The repository contains local policy settings, manual Bitwarden connection setup, shared
contracts, isolated transport/local-crypto libraries, a packaged offscreen crypto host,
a local vault cache with offline restoration, a localhost-only synthetic login executor
probe, a device-authenticated settings/recipe sync Worker skeleton and
CI/manual-delivery foundations. Connection setup and its live metadata integration
passed synthetic native-browser tests; real-account compatibility is unproven. An
offline AI evaluation harness scores role adapters on a synthetic Japanese/English
corpus with fake providers only. The settings page can pair a device with the
service; production login activation, settings/recipe sync in the extension, provider
inference and passkey execution remain unimplemented. The service is not
deployed. The initial design was adopted in
[PR #1](https://github.com/risu729/pateat/pull/1).

The architecture describes the agreed product boundaries; the plan separates
initial delivery from later capabilities. In particular, initial read-only vault
use and login-only execution are delivery limits, not permanent product limits.
Settings and local recipe execution do not depend on the optional service.

## Reading order and ownership

| Document                                       | Owns                                                            | Update rule                                                        |
| ---------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| [Architecture](architecture.md)                | Product scope, proposed runtime boundaries and contracts        | Update with changes; identify unimplemented behavior               |
| [Implementation plan](plan.md)                 | Ordered work, acceptance gates and open decisions               | Track milestone evidence here; no second roadmap                   |
| [Development](development.md)                  | Proposed toolchain and dependency policy                        | Replace proposals with verified commands when bootstrapped         |
| [CI and server delivery](delivery.md)          | Required checks, repository settings and server release process | Update with executable workflows                                   |
| [ADRs](adr/0001-local-login-boundary.md)       | Decision rationale and alternatives                             | Amend explicitly or supersede; preserve history                    |
| [Research](research/2026-10-10-feasibility.md) | Dated observations and primary sources                          | Append new evidence or supersede; never imply current verification |

The initial ADRs were accepted by merging PR #1.
Acceptance does not mean implementation. A later replacement links the old and
new ADRs. A narrow implementation detail does not need another ADR.

Keep one authoritative location for each fact. Plans link to contracts rather
than copying them. Do not create a chat transcript, chronological decision log,
parallel status catalogue, or permanent document for each small implementation
PR. Verification belongs in the PR; retain a dated report only when it supports
a lasting compatibility or operational claim.

Implementation PRs update the relevant reference and mark the corresponding
plan gate complete only with linked evidence. Distinguish local tests, installed
Chrome coexistence, deployed service behavior, and real-account compatibility.
Use synthetic examples; never commit credentials, real account identifiers,
private page captures, or raw model requests.

## Decision records

- [0001: Local login execution and vault adapters](adr/0001-local-login-boundary.md)
- [0002: Maintained tools and independent feature implementation](adr/0002-toolchain.md)
- [0003: Minimal Cloudflare service and provider-neutral inference](adr/0003-service-and-ai.md)
- [0004: Maintained library composition](adr/0004-library-composition.md)
- [0005: Official OSS SDK for local Bitwarden cryptography](adr/0005-bitwarden-local-crypto.md)
- [0006: Atomic local vault cache](adr/0006-atomic-local-vault-cache.md)
- [0007: Existing passkey assertions](adr/0007-existing-passkey-assertions.md)
- [0008: Durable provider sync sessions](adr/0008-durable-provider-sessions.md)
- [0009: Install-time HTTPS site access](adr/0009-install-time-https-site-access.md)

This layout follows the useful separation in
[Kogane ADR 0041](https://github.com/risu729/kogane/blob/main/docs/adr/0041-documentation-scope.md),
with fewer document classes and no duplicated roadmap/status history.
