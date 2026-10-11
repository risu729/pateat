# CI and server delivery

Status: CI and guarded server delivery after main CI are implemented, and the service
has been released automatically to `pateat.takuk.me` since 2026-10-11. Extension store
publishing is excluded. Extension releases on GitHub Releases, and a mode without the
service, are planned for [phase 3](plan.md#phase-3-public-release).

## Current foundation workflows

`ci.yml` runs the complete mise/hk graph, including isolated browser tests, on every PR
and main push, and repeats the packaged-extension browser tests on Windows. The
packaged-extension suite (`tests/extension`, 123 tests one after another in one worker)
took about six minutes on Linux and seven on Windows, the longest step of every run
(about 8.5 minutes in total on 2026-10-11). Both jobs therefore run as four shards
(`Verify (1/4)` to `(4/4)` and `Windows browser (1/4)` to `(4/4)`): each shard sets
`PATEAT_E2E_SHARD=<current>/<total>`, which `tests/extension/playwright.config.ts` turns
into Playwright's `shard`, and the four shards together run every test once. Every Linux
shard still runs the rest of the graph; only shard 1 packs the server artifact on a main
push. The suite splits by test (`fullyParallel`) because splitting by file left
`login.spec.ts` alone in a shard of about three minutes; each job still runs one worker.
`CI Check` requires every job of both matrices to succeed, including when an upstream
job failed, skipped or was cancelled. A newer push to a PR cancels its older run, but
each main push finishes its own run; otherwise frequent merges would cancel every main
run before it could package a release and start `deploy-server.yml`. `codeql.yml`
analyzes TypeScript/JavaScript and Actions separately. Linux jobs pin `ubuntu-26.04`;
the `CI Check` aggregate only compares results, so it runs on the single-CPU
`ubuntu-slim` runner. CodeQL needs no Actions cache: dependency caching is off by
default in advanced setup and its TRAP cache is disabled, so the workflow sets
`cache-mode: none`. In `ci.yml` the two jobs share their checkout, mise and Bun install
steps through YAML anchors (`&checkout`, `&mise`, `&install`), so those pins appear once
in `ci.yml`; zizmor warns that it audits anchored workflows on a best-effort basis.
GitHub Code Quality is not used: since its
[2026-07-20 general availability](https://github.blog/changelog/2026-06-16-github-code-quality-generally-available-july-20-2026)
it is a paid product for GitHub Team and Enterprise Cloud organizations, and this
repository is user-owned. On 2026-10-11 the owner removed its ruleset rule here and in
the other active risu729 repositories. See [merging](#merging).

Successful main-push CI packages the production Worker output that `Verify (1/4)` built
and checked, with repository, revision, run/attempt, tool versions and per-file hashes,
plus the committed top-level D1 migration files (`services/api/migrations/*.sql`) and
the D1 database ID recorded in the build. The `pateat` database was bootstrapped on
2026-10-11 in the owner's account with an APAC location hint, and its ID is in
`cloudflare.config.ts`; packing and restore refuse a build whose `DB` binding has no ID,
because cf deploy would provision a new database. Restore also checks that the
migrations match both the manifest and the checked-out revision. The artifact name
carries the run attempt, so a failed main run is retried with "Re-run all jobs": after
"Re-run failed jobs" with `Verify (1/4)` green, the artifact stays on the earlier
attempt and the deployment rejects it. The service browser tests in other shards build
their own copy of the Worker output. The setup order below sets the release credentials
last, after pairing works through Access; the typed-code enrollment did when the owner
paired on 2026-10-11. For direct pairing, only the post-deploy probe has run against the
deployed service so far; no installed build has paired directly yet
([device enrollment](architecture.md#device-enrollment)). A deployment also needs the
`ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` Worker secrets; the owner pages answer 503 without
them. Artifact tests reject tampering and mismatched provenance.

### Production settings

The owner decided these on 2026-10-11, following the kogane repository:

- Host: the Worker serves only the Custom Domain `pateat.takuk.me`
  (`cloudflare.config.ts`); `workers.dev` and version preview URLs stay off.
- Access: one Access application covers the whole host, so a new route is protected
  by default. It uses the owner's existing reusable Access policy, which allows the
  owner's email domain and requires a device connected through Cloudflare Gateway
  (WARP); the owner decided on 2026-10-11 that owner pages need not open from a phone
  without WARP. A more specific Access application with a Bypass policy exempts the
  paths clients call without an Access login: `/v1/*` (device credentials from the
  extension's background), `/health` (release check),
  and `/.well-known/openid-configuration` and `/.well-known/jwks.json` (fetched
  anonymously by Anthropic for Workload Identity Federation). The Worker still
  verifies the Access token itself on the owner pages. `POST /pair` (direct pairing,
  [ADR 0020](adr/0020-direct-device-pairing.md)) stays under the host-wide application
  and must not be added to the Bypass application: it needs the owner's Access session.
- Pairing extension IDs: `PAIRING_EXTENSION_IDS` is a committed JSON variable in
  `cloudflare.config.ts` that lists Pateat's production extension ID. It is not a
  secret, workflows do not synchronize it, and it needs no GitHub environment variable
  or Worker secret; a release deploys the committed list.
- Worker secrets: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `OIDC_ISSUER` and
  `OIDC_SIGNING_KEYS` are set once during bootstrap; workflows never synchronize them.
  cf refuses to create a Worker without its declared secrets, so the first deploy
  passes all four at once with `cf deploy --prebuilt --mode production --secrets-file
  <file>` (JSON) and deletes the file afterwards; later changes use
  `cf workers secrets update`. With several accounts visible to the login, cf also
  needs `CLOUDFLARE_ACCOUNT_ID`. Versions created by routine releases keep the secrets.
- Delivery: a successful main-push CI run starts `deploy-server.yml` automatically,
  as in kogane; `workflow_dispatch` with a CI run ID remains for retries.
- Preview: there is no preview deployment for now. Without the owner web UI there is
  nothing to review in a browser: the routes outside Access are `/health`, the OIDC
  discovery documents and the device-authenticated `/v1/*`, which the
  Worker tests cover, and a useful preview would need its own D1 database and Access
  setup. Add a `worker-preview` deployment with a separate preview D1 binding, as biwa
  does for its docs, when the owner web UI exists. The web UI now exists; adding the
  preview is not scheduled yet.

`deploy-server.yml` has no enable switch: the owner decided on 2026-10-11 that every
successful main-push CI run starts a release. Until the production
credentials exist, each run fails at its first step without changing anything. Set the
release credentials last: first bootstrap the Worker and its Custom Domain, the two
Access applications and the Worker secrets, and verify pairing through Access;
otherwise a release would apply migrations and then fail to activate a missing Worker.
Then set the `production` environment variables `CLOUDFLARE_ACCOUNT_ID`,
`SERVER_WORKER=pateat-api` and `SERVER_HEALTH_URL=https://pateat.takuk.me/health`; the
account ID is not a secret. Put the `CLOUDFLARE_API_TOKEN` secret in the `production`
environment only. The owner chose on 2026-10-11 to use this one token for both the
migrations and the deployment, as in kogane, because both run in the same job. It is an
Account API token, not a user API token, so it does not depend on one person's login,
and its scope is as narrow as Cloudflare allows (owner decision, 2026-10-11). The token
created on 2026-10-11 is "pateat-github-actions-production" with Individual Workers
Editor on `pateat-api` only and D1 Write for the whole account, because the dashboard
offers no per-database D1 scope. The release limits itself to the recorded database ID,
and routine releases do not touch the Custom Domain, so the token needs no zone
permission. The `production` environment accepts deployments only from `main`
(Deployment branches and tags: selected branch rule `main`, set by the owner on
2026-10-11), so a workflow on another branch cannot read the token. This repository
does not supply or provision them.

An automatic run releases the newest main revision whose push CI passed, not necessarily
the one whose CI run started it: main often gains merges faster than CI finishes, main
CI runs can finish out of order, and the release lock keeps only the newest pending run.
Requiring the current main head instead left the server unreleased for as long as merges
kept coming (observed on 2026-10-11). A manual dispatch releases the `ci_run_id` it is
given for the main revision it started on. Inside a non-cancelling release lock, every
run compares the chosen revision with the revision `/health` reports and releases only
one that is ahead of it, so the server never moves back; a dispatch may also repeat the
live revision. When `/health` gives no revision, only the current main head may be
released. A live revision that is not on main fails an automatic run instead of
skipping; after checking the server, the owner replaces it with a dispatch. The workflow
fails before any change when the token is empty or the account ID is not a 32-character
hex ID. It verifies the run's identity, event and conclusion, restores only its hashed
artifact, applies the released migrations, deploys through the pinned action without
rebuilding, and verifies returned deployment IDs and the hosted revision; it tries
`/health` up to 30 times, 2 seconds apart, while the new version propagates. Before
`cf d1 migrations apply`, it reads the database by the recorded ID and requires the name
`pateat`; afterwards no migration may remain unapplied. A failed migration stops the
release before activation. Before the first public release, migrations need not be
additive and the previously serving Worker need not keep running on the new schema
([compatibility before release](development.md#compatibility-before-release)); cf
compares applied migrations by name only, so an applied migration file is never edited.
`cf d1 migrations` is a preview command of the pinned beta cf; recheck this step when cf
is updated. There is no automatic retry; the next successful main CI run releases the
newest tested revision, or retry with a dispatch. Routine releases never change the
Custom Domain or other triggers; the bootstrap applies them once. The complete service
release gates below remain planned, including automatic promotion/failure
acknowledgement.

## Repository configuration

Follow Kogane/Kuebiko: public repository, main default branch, squash-only merges,
automatic branch deletion, auto-merge and update-branch available, web commit
signoff required, issues enabled, discussions/wiki/projects/downloads disabled.
Apply their default-
branch rules: prohibit deletion/force-push/creation, require linear history,
signatures and PRs, zero required approvals, required `CI Check` from GitHub
Actions, and CodeQL errors/high security alerts (no Code Quality rule). Preserve
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

Merge an authorized PR with an ordinary squash merge once CI, CodeQL and the
required independent review pass. Normal merges do not use the administrator
bypass.

## Complete-service CI requirements

- Trigger on every PR and main push; no top-level path filter may leave the
  required check pending. A final aggregate job named exactly `CI Check` always
  evaluates all required results, including skipped/cancelled/failing jobs.
- Install immutable-pinned Actions, exact mise tools and frozen dependencies.
  Run the hk/mise verification graph, documentation links, lint, formatting,
  type checks, unit/runtime tests, extension packaging and relevant browser
  acceptance tests. CodeQL requirements are configured explicitly.
- Test Worker contracts, Access identity validation, device pairing/revocation,
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
2. Serialize production migrations, deployment, readback and smoke checks with GitHub
   concurrency and `cancel-in-progress: false`. Inside the lock, before the first
   mutation, compare the intended revision with the live one and skip anything not ahead
   of it; concurrency does not guarantee source-revision ordering. Once mutation starts,
   finish/reconcile the release instead of cancelling it for a newer run. Provision the
   Worker/D1/routing and scoped credentials in a distinct initial bootstrap operation.
   Keep bootstrap permissions separate from routine code releases; resource names,
   account IDs and pairing are M6 inputs. The D1 database was bootstrapped early, on
   2026-10-11, and its ID is in the config. The initial service bootstrap includes
   Access identity configuration and a verified device pairing/revocation flow. Do
   not distribute a universal service credential with the extension. D1 initially stores
   private settings in server-readable form; vault credentials and decryption keys
   remain local.
3. Apply D1 migrations using the caller's task and the production token above. cf
   migrations take a database ID and default to remote execution; use explicit local
   mode in tests. Verify target identity before execution. After the first public
   release, migrations must be additive and backward-compatible, and the previous Worker
   must still run against the new schema; before it, neither is required
   ([compatibility before release](development.md#compatibility-before-release)).
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

The hosted smoke checks are in
[services/api/README.md](../services/api/README.md#hosted-smoke-checks). They obtain
owners and devices without a person and without changing Access: the deploy job,
which already holds D1 write access for migrations, inserts synthetic owners and
device rows into D1 and then uses those devices through the hosted `/v1` routes.
Issuing a device through Access is therefore not exercised by a hosted check, so that
part of item 5 stays open. It is covered by Worker tests with synthetic Access tokens
and by pairing in the owner's Chrome; automating it would need an Access service token
that the Worker accepts as an owner, which is a separate owner decision.

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
