# CI and server delivery

Status: foundation CI and guarded manual server delivery are implemented.
Deployment has not been enabled or executed. Extension store publishing and CD
are excluded. The server remains optional for the eventual local login core.

## Current foundation workflows

`ci.yml` runs the complete mise/hk graph, including isolated browser tests, on
every PR and main push. `CI Check` requires successful verification, including
when an upstream job failed, skipped or was cancelled. `codeql.yml` analyzes
TypeScript/JavaScript and Actions separately. GitHub now detects the repository
languages, but native Code Quality setup still reports the feature as unavailable;
preserve its required rule rather than treating that as permanent ineligibility.
See [merging](#merging).

Successful main-push CI packages the exact tested production Worker output with
repository, revision, run/attempt, tool versions and per-file hashes. This health-
only foundation has no D1 migrations or authentication endpoints. Artifact tests
reject tampering and mismatched provenance.

`deploy-server.yml` is manual and disabled until `SERVER_DEPLOY_ENABLED=true`.
Before enabling it, provision the Worker/routing and set repository variables
`CLOUDFLARE_ACCOUNT_ID`, `SERVER_WORKER=pateat-api`, and `SERVER_HEALTH_URL` to its
HTTPS `/health` URL. Put the scoped `CLOUDFLARE_API_TOKEN` secret in the
`production` environment. This repository does not supply or provision them.

Dispatch on main with `ci_run_id` identifying successful main-push CI for the
current revision. The workflow verifies the run's identity, event and conclusion,
restores only its hashed artifact, rechecks main within a non-cancelling release
lock, deploys through the pinned action without rebuilding, and verifies returned
deployment IDs and the hosted revision. Failed delivery stays failed; each retry
or later release requires an explicit dispatch. The complete service release
gates below remain planned, including automatic promotion/failure acknowledgement.

## Repository configuration

Follow Kogane/Kuebiko: public repository, main default branch, squash-only merges,
automatic branch deletion, auto-merge and update-branch available, web commit
signoff required, issues enabled, discussions/wiki/projects/downloads disabled.
Apply their default-
branch rules: prohibit deletion/force-push/creation, require linear history,
signatures and PRs, zero required approvals, required `CI Check` from GitHub
Actions, CodeQL errors/high security alerts, and Code Quality errors. Preserve
administrator bypass; do not weaken rules just because the first PR has no CI.

The initial main commit has an empty tree. The owner authorized the documentation
PR's bypass merge. Missing required checks are not passing checks.
Normal implementation merges must use real checks;
M1 must configure the aggregate job and scanning/quality services or explicitly
resolve unavailable integrations before normal merges. Required checks must not
remain permanent bypass requirements.

Use read-only workflow permissions by default and prohibit Actions from approving
PRs. Require workflow approval for all external fork contributors; retain Actions
artifacts/logs for 90 days, using Kuebiko as the reference for these settings.
Kogane currently requires approval only for first-time contributors. Enable secret
scanning/push protection and security updates consistently
with existing repositories where GitHub supports them. No deployment credentials
are created for this PR.

### Merging

Try an ordinary squash merge first. As of 2026-10-10, the required Code Quality
rule blocks ordinary merges while the repository's Code Quality setup endpoint
reports that the feature is unavailable. Earlier authorized implementation PRs,
through PR #20, were merged with the administrator squash bypass only after CI,
CodeQL and independent review passed. Recheck the live setup state before each
bypass; do not delete or weaken the rule. The standing merge authorization in
[AGENTS.md](../AGENTS.md) does not cover deployment or new library/provider
choices.

## Complete-service CI requirements

- Trigger on every PR and main push; no top-level path filter may leave the
  required check pending. A final aggregate job named exactly `CI Check` always
  evaluates all required results, including skipped/cancelled/failing jobs.
- Install immutable-pinned Actions, exact mise tools and frozen dependencies.
  Run the hk/mise verification graph, documentation links, lint, formatting,
  type checks, unit/runtime tests, extension packaging and relevant browser
  acceptance tests. CodeQL/Code Quality requirements are configured explicitly.
- Test Worker contracts, Access identity validation, device enrollment/revocation,
  owner-scoped settings/recipe access and D1 locally. Verify that service login
  cannot authenticate or unlock a vault. Mock providers and use dummy accounts;
  PR CI needs no production, vault or inference secrets. Untrusted
  PR code is never run under a credential-bearing pull_request_target workflow.
- Test spending accumulation and refusal of new inference at the configured
  monthly limit, including missing usage, failed calls and concurrent in-flight
  requests. Document possible overshoot; strict cost reservations are not a
  release requirement. Provider/model failures must not trigger automatic
  fallback. Verify local saved-recipe execution with an unavailable service or
  exhausted inference budget.
- Run cf under Node; use the committed typed config and Vite build. Credential-
  free build/dry-run verifies generated output. Do not allow automatic project
  detection to create config or install dependencies in CI.
- Cache dependencies by platform/tool versions/lockfile; do not cache vault data,
  tokens, authenticated browser profiles or private captures. Bound diagnostic
  artifacts and scrub page values. Verify package/action updates through Renovate.

## Complete-service build and release requirements

Use cloudflare.config.ts as the maintained configuration. Pin cf and the
Cloudflare Vite plugin together. cf requires Node >=22.18; Bun remains the
package manager, not its runtime. See [research](research/2026-10-10-feasibility.md)
for the typed-config/test-harness compatibility gate.

1. Inside trusted main CI, produce a production-mode `.cloudflare/output/v0/`
   artifact and validate that exact output before `CI Check` can pass. Archive
   it unchanged with migration SQL from the same tested revision. Record commit,
   workflow run, mode, tool versions and digests. A main-only deployment consumes
   that artifact, verifies its provenance/digests, and never rebuilds inside
   deploy. Never promote an arbitrary PR artifact into a privileged workflow.
2. Serialize production migrations, deployment, readback and smoke checks with
   GitHub concurrency and `cancel-in-progress: false`. Inside the lock, before
   the first mutation, recheck the intended release revision and skip superseded
   builds; concurrency does not guarantee source-revision ordering. Once mutation
   starts, finish/reconcile the release instead of cancelling it for a newer run.
   Provision the Worker/D1/routing and scoped credentials in a distinct initial
   bootstrap operation. Keep bootstrap permissions separate from routine code
   releases; resource names, account/database IDs and enrollment are M6 inputs.
   The initial service bootstrap includes Access identity configuration and a
   verified device enrollment/revocation flow. Do not distribute a universal
   service credential with the extension. D1 initially stores private settings
   in server-readable form; vault credentials and decryption keys remain local.
3. Apply additive, backward-compatible D1 migrations using the caller's task and
   a separately scoped credential. cf migrations take a database ID and default
   to remote execution; use explicit local mode in tests. Verify target identity
   before execution. The previous Worker must still run against the new schema.
4. Use the owner's deployment action, pinned to a reviewed full commit SHA, with
   prebuilt output, matching production build/mode, exact Worker/account identity,
   and the normal versions strategy. Routine releases do not update routing or
   triggers implicitly. The action already supports cf; no action PR is planned.
5. Require the action's exact deployment-ID readback plus hosted smoke tests:
   expected source revision, invalid-identity/device rejection, revoked-device
   rejection, tenant separation, D1 access, synthetic settings/recipe round trip,
   and cleanup. Exercise Access and device authorization through their intended
   entry points; an internal handler test does not establish deployed Access
   behavior. A version upload alone is not a successful release. Keep inference
   mocked during routine smoke checks.

As of research, reuse
[wrangler-deploy-action v2.2.1](https://github.com/risu729/wrangler-deploy-action/releases/tag/v2.2.1),
commit `6a93154ef1c550b760d8582bcf59d8d4a0710788`. Recheck the release and inputs
when writing workflows. Caller tasks own migrations and hosted application tests;
the action owns deployment and deployment readback.

## Failure and rollback

If migrations fail, do not deploy. If activation/readback/smoke checks fail,
leave the release failed, retain sanitized evidence, and stop automatic further
promotion. Restore a retained compatible build artifact through the same scoped
action, producing a new version ID, and repeat readback/smoke checks. The action
does not accept an old version ID as a substitute for Build Output. Additive
schema is retained; do not run automatic
destructive down-migrations. A bad recipe has its own revision rollback/revocation
and does not require replacing the whole Worker.

Document actual deployed IDs, schema version and smoke result in release output,
not a manually maintained duplicate state file. Real-model checks and spending
are separately controlled with bounded requests and explicit budget configuration.
The configured monthly spending threshold uses accumulated reported or estimated
cost; it does not promise an exact invoice ceiling. Direct extension inference,
Access-free service authentication, E2EE settings sync and remote MCP are later
options with their own acceptance gates, not dependencies of the initial release.
