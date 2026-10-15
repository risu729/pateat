# Documentation

The repository contains the extension (Bitwarden connection, local settings, the
login executor, recipe generation requests and passkey signing), the settings and
recipe service with its owner web UI and Claude recipe generation, shared contracts and
libraries, and CI/delivery. The service is deployed at `pateat.takuk.me`. The
[plan](plan.md) records what has been verified, including real-account and real-site
results, and the open gates. The initial design was adopted in
[PR #1](https://github.com/risu729/pateat/pull/1).

The architecture describes the agreed product boundaries; the plan separates
initial delivery from later capabilities. In particular, initial read-only vault
use and login-only execution are delivery limits, not permanent product limits.
The service is the source of truth for settings and recipes; the extension runs
from a synced cache ([ADR 0013](adr/0013-service-held-recipes-and-settings.md)).

## Reading order and ownership

| Document                                       | Owns                                                            | Update rule                                                        |
| ---------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------ |
| [Architecture](architecture.md)                | Product scope, proposed runtime boundaries and contracts        | Update with changes; identify unimplemented behavior               |
| [Implementation plan](plan.md)                 | Ordered work, acceptance gates and open decisions               | Track milestone evidence here; no second roadmap                   |
| [Development](development.md)                  | Proposed toolchain and dependency policy                        | Replace proposals with verified commands when bootstrapped         |
| [CI and server delivery](delivery.md)          | Required checks, repository settings and server release process | Update with executable workflows                                   |
| [ADRs](adr/0001-local-login-boundary.md)       | Decision rationale and alternatives                             | Amend explicitly or supersede; preserve history                    |
| [Research](research/2026-10-10-feasibility.md) | Dated observations and primary sources                          | Append new evidence or supersede; never imply current verification |
| [Docs website](../apps/docs/src/index.md) | User-facing pages: installation, setup, permissions, privacy | Derived: update with the document or ADR that owns each fact |

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
private page captures, or raw model requests. Reviewed observations derived from real
pages, with synthetic slot hints, may be committed as evaluation data
([ADR 0012](adr/0012-inference-request-log.md)).

## Decision records

A new ADR starts with `Status:` and `Date:` lines. `Status:` says who accepted it, the
date and UTC time, the owner's words quoted, whether it is implemented and which ADRs
it amends or replaces. The body has Context, Decision, Consequences and Alternatives
sections. Mark anything an agent added beyond the owner's answer as not confirmed by
the owner. After acceptance, change an ADR only through a dated amendment section,
keep the accepted text, and note the amendment in its `Status:`; an ADR that amends
another also updates the other's `Status:`. Number a new ADR after the highest one
(0011 stays unused) and add it to the list below in the same PR.

- [0001: Local login execution and vault adapters](adr/0001-local-login-boundary.md)
- [0002: Maintained tools and independent feature implementation](adr/0002-toolchain.md)
- [0003: Minimal Cloudflare service and provider-neutral inference](adr/0003-service-and-ai.md)
- [0004: Maintained library composition](adr/0004-library-composition.md)
- [0005: Official OSS SDK for local Bitwarden cryptography](adr/0005-bitwarden-local-crypto.md)
- [0006: Atomic local vault cache](adr/0006-atomic-local-vault-cache.md)
- [0007: Existing passkey assertions](adr/0007-existing-passkey-assertions.md)
- [0008: Durable provider sync sessions](adr/0008-durable-provider-sessions.md)
- [0009: Install-time HTTPS site access](adr/0009-install-time-https-site-access.md)
- [0010: Inference field hints and local fill checks](adr/0010-inference-field-hints.md)
- [0012: Inference request log and evaluation data](adr/0012-inference-request-log.md)
- [0013: Service-held recipes, settings and account bindings](adr/0013-service-held-recipes-and-settings.md)
- [0014: Claude Opus 5.5 for recipe generation](adr/0014-claude-generation-provider.md)
- [0015: Per-owner Claude credentials through Workload Identity Federation](adr/0015-per-owner-claude-credentials.md)
- [0016: Automatic recipe generation on pages with a vault match](adr/0016-recipe-generation-trigger.md)
- [0017: Login forms inside frames](adr/0017-login-forms-in-frames.md)
- [0018: Service recipe generation route](adr/0018-recipe-generation-route.md)
- [0019: Local diagnostics page and logs](adr/0019-local-diagnostics-and-logs.md)
- [0020: Direct device pairing from the extension](adr/0020-direct-device-pairing.md)
- [0021: Choosing an account outside the settings page](adr/0021-account-choice-outside-settings.md)
- [0022: Login attempt records per tab and origin](adr/0022-login-attempts-per-tab-and-origin.md)
- [0023: Synced item selection, field exclusions and custom-field review](adr/0023-synced-vault-policy.md)
- [0024: Settings profiles](adr/0024-settings-profiles.md)
- [0025: Automatic Bitwarden vault sync](adr/0025-automatic-vault-sync.md)
- [0026: Signing in to a site through an identity provider](adr/0026-sign-in-through-identity-providers.md)
- [0027: Login routes and second-factor pages chosen per account](adr/0027-per-account-login-routes.md)
- [0028: Login pages that list accounts to choose from](adr/0028-account-chooser-login-pages.md)
- [0029: Local sign-in state after an effect step, with the judge as a fallback](adr/0029-local-sign-in-state.md)
- [0030: Pairing from browsers without WARP](adr/0030-pairing-without-warp.md)
- [0031: Press a site's sign-in entry on pages without a login form](adr/0031-sign-in-entry-pages.md)
- [0032: aube installs the workspace dependencies](adr/0032-aube-package-manager.md)
- [0033: No site-specific features unless strictly necessary](adr/0033-no-site-specific-features.md)
- [0034: Pateat answers a login page's own passkey request](adr/0034-answer-page-passkey-requests.md)
- [0035: Page kinds, and how far Pateat goes on each, per site and profile](adr/0035-page-kinds-per-site.md)
- [0036: Items without a password go on to a passkey after the identifier](adr/0036-passkey-after-the-identifier.md)
- [0037: Fields located by their visible name](adr/0037-fields-by-visible-name.md)
- [0038: The toolbar badge and popup show what a login did](adr/0038-login-status-badge.md)

This layout follows the useful separation in
[Kogane ADR 0041](https://github.com/risu729/kogane/blob/main/docs/adr/0041-documentation-scope.md),
with fewer document classes and no duplicated roadmap/status history.
