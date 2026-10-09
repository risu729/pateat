# Documentation

This repository is in design: there is no extension, backend, CI, or deployment
yet. The initial PR contains documentation only. Merging it adopts a plan, not
evidence that any login works.

## Reading order and ownership

| Document                                       | Owns                                                            | Update rule                                                        |
| ---------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| [Architecture](architecture.md)                | Product scope, proposed runtime boundaries and contracts        | Update with changes; identify unimplemented behavior               |
| [Implementation plan](plan.md)                 | Ordered work, acceptance gates and open decisions               | Track milestone evidence here; no second roadmap                   |
| [Development](development.md)                  | Proposed toolchain and dependency policy                        | Replace proposals with verified commands when bootstrapped         |
| [CI and server delivery](delivery.md)          | Required checks, repository settings and server release process | Update with executable workflows                                   |
| [ADRs](adr/0001-local-login-boundary.md)       | Decision rationale and alternatives                             | Amend explicitly or supersede; preserve history                    |
| [Research](research/2026-10-10-feasibility.md) | Dated observations and primary sources                          | Append new evidence or supersede; never imply current verification |

ADRs in this initial PR are proposed until merge and accepted by that merge.
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

This layout follows the useful separation in
[Kogane ADR 0041](https://github.com/risu729/kogane/blob/main/docs/adr/0041-documentation-scope.md),
with fewer document classes and no duplicated roadmap/status history.
