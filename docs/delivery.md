# Proposed CI and server delivery

Status: plan only. This PR adds no workflow or deployment configuration. Extension
store publishing and extension CD are deliberately excluded.

## Repository configuration

Follow Kogane/Kuebiko: public repository, main default branch, squash-only merges,
automatic branch deletion, auto-merge and update-branch available, web commit
signoff required, issues enabled, discussions/wiki/projects/downloads disabled.
Apply their default-
branch rules: prohibit deletion/force-push/creation, require linear history,
signatures and PRs, zero required approvals, required `CI Check` from GitHub
Actions, CodeQL errors/high security alerts, and Code Quality errors. Preserve
administrator bypass; do not weaken rules just because the first PR has no CI.

The initial main commit has an empty tree. The owner will separately decide when
to bypass-merge the documentation PR. Missing required checks at this stage are
expected, not passing checks. Normal implementation merges must use real checks;
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

## PR CI

- Trigger on every PR and main push; no top-level path filter may leave the
  required check pending. A final aggregate job named exactly `CI Check` always
  evaluates all required results, including skipped/cancelled/failing jobs.
- Install immutable-pinned Actions, exact mise tools and frozen dependencies.
  Run the hk/mise verification graph, documentation links, lint, formatting,
  type checks, unit/runtime tests, extension packaging and relevant browser
  acceptance tests. CodeQL/Code Quality requirements are configured explicitly.
- Test Worker contracts, authorization and D1 locally. Mock providers and use
  dummy accounts; PR CI needs no production, vault or inference secrets. Untrusted
  PR code is never run under a credential-bearing pull_request_target workflow.
- Run cf under Node; use the committed typed config and Vite build. Credential-
  free build/dry-run verifies generated output. Do not allow automatic project
  detection to create config or install dependencies in CI.
- Cache dependencies by platform/tool versions/lockfile; do not cache vault data,
  tokens, authenticated browser profiles or private captures. Bound diagnostic
  artifacts and scrub page values. Verify package/action updates through Renovate.

## Server build and release

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
3. Apply additive, backward-compatible D1 migrations using the caller's task and
   a separately scoped credential. cf migrations take a database ID and default
   to remote execution; use explicit local mode in tests. Verify target identity
   before execution. The previous Worker must still run against the new schema.
4. Use the owner's deployment action, pinned to a reviewed full commit SHA, with
   prebuilt output, matching production build/mode, exact Worker/account identity,
   and the normal versions strategy. Routine releases do not update routing or
   triggers implicitly. The action already supports cf; no action PR is planned.
5. Require the action's exact deployment-ID readback plus hosted smoke tests:
   expected source revision, invalid-auth rejection, tenant separation, D1 access,
   synthetic recipe round trip, and cleanup. A version upload alone is not a
   successful release. Keep inference mocked during routine smoke checks.

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
