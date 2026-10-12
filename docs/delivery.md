# CI and server delivery

Status: CI and guarded server delivery after main CI are implemented, and the service
has been released automatically to `pateat.takuk.me` since 2026-10-11. Extension
releases on GitHub Releases, Chrome Web Store publishing if its policies allow, and a
mode without the service are planned for [phase 3](plan.md#phase-3-public-release).

## Current foundation workflows

`ci.yml` runs the complete mise/hk graph, including isolated browser tests, on every PR
(except a documentation-only one, see `Changes` below) and main push, split over the
jobs below. The packaged-extension suite (`tests/extension`, 123 tests at the time, one
after another in one worker) took about six minutes on Linux, the longest step of every
run (about 8.5 minutes in total on 2026-10-11). It therefore runs as six shards of one
`Browser` job (`Browser (1/6)` to `(6/6)`): each shard sets
`PATEAT_E2E_SHARD=<current>/<total>`, which `tests/extension/playwright.config.ts` turns
into Playwright's `shard`, and the six shards together run every test once. The suite
splits by test (`fullyParallel`) because splitting by file left `login.spec.ts` alone in
a shard of about three minutes; each job still runs one worker. The `Verify` job runs
the rest of the graph (lint, typecheck, unit and component tests, build checks) with
`PATEAT_SKIP_E2E=1` (any non-empty value), which turns `//tests/extension:test` into a
no-op there; without that variable, as in a local `mise run check`, the suite runs
whole. With four shards the first sharded runs took 4 to 7 minutes (mean 4m41s over 37
runs on 2026-10-11 and 12), where each shard still repeated the rest of the graph;
`Verify` and the shards run side by side now. With six shards and `Verify` split out, 16
PR runs on 2026-10-12 between 06:11 and 07:24 UTC (JST 15:11 to 16:24) took 4m06s on
average (3m19s to 5m28s) and 11 successful main runs 4m44s (3m28s to 8m00s); the slowest
ones overlapped other runs. Every run is 9 jobs (`Changes`, `Verify`, six `Browser`
shards, `CI Check`), or 3 for a documentation-only PR (`Changes`, `Verify`, `CI Check`);
a main push adds a tenth, `Deploy tested server`, which a pull request skips. The owner
decided on 2026-10-12 that CI runs no Windows job at all: the tests drive Playwright's
Chromium, not the owner's Chrome, no extension code branches on the platform, and no
Pateat defect was ever found only on Windows (the Windows failures seen were a local
missing SideBySide assembly, system-drive I/O stalls and a 30 s timeout of unknown
cause). Installed-Chrome behaviour on Windows is covered by the real-Chrome checks, not
by CI. `CI Check` requires `Changes` and `Verify` to succeed and `Browser` to be
`success`, or `skipped` exactly when `Changes` reported a documentation-only PR; it runs
even when an upstream job failed. A `Changes` job (no checkout, on `ubuntu-slim`)
decides whether a PR needs the browser tests: a PR whose changed files are all under
`docs/` or are `AGENTS.md` or `README.md` skips the `Browser` job, runs only `Verify`
(which still checks the documentation) and passes `CI Check` with the shards skipped;
any other change, every main push and every manual run runs them. The owner chose
[dorny/paths-filter](https://github.com/dorny/paths-filter) (pinned at v4.0.3) on
2026-10-12 because on a `pull_request` event it reads the changed files through the API,
so the job needs no checkout and only `pull-requests: read`; workflow-level `paths`
filters are not used because a skipped workflow reports no `CI Check`. If the `Changes`
job fails, `CI Check` fails. `Changes` adds a few seconds before the browser shards
start. A newer push to a PR cancels its older run, but each main push finishes its own
run; otherwise frequent merges would cancel every main run before it could package a
release and deploy it. `codeql.yml` analyzes TypeScript/JavaScript and Actions
separately. Linux jobs pin `ubuntu-26.04`; the `CI Check` aggregate only compares
results, so it runs on the single-CPU `ubuntu-slim` runner. CodeQL needs no Actions
cache: dependency caching is off by default in advanced setup and its TRAP cache is
disabled, so the workflow sets `cache-mode: none`. In `ci.yml` the `Verify`, `Browser`
and `Deploy tested server` jobs share their checkout, mise and Bun install steps through
YAML anchors (`&checkout`, `&mise`, `&install`), so those pins appear once in `ci.yml`;
zizmor warns that it audits anchored workflows on a best-effort basis. GitHub Code
Quality is not used: since its
[2026-07-20 general availability](https://github.blog/changelog/2026-06-16-github-code-quality-generally-available-july-20-2026)
it is a paid product for GitHub Team and Enterprise Cloud organizations, and this
repository is user-owned. On 2026-10-11 the owner removed its ruleset rule here and in
the other active risu729 repositories. See [merging](#merging).

A main-push `Verify` job packages the production Worker output that it built and
checked, with repository, revision, run ID and per-file hashes, plus the committed
top-level D1 migration files (`services/api/migrations/*.sql`), the D1 database ID and
the Worker's Custom Domains recorded in the build, and uploads it as `server-<sha>`
(overwritten when "Re-run all jobs" packs the revision again). The `pateat` database was
bootstrapped on 2026-10-11 in the owner's account with an APAC location hint, and its ID
is in `cloudflare.config.ts`; packing refuses a build whose `DB` binding has no ID,
because cf deploy would provision a new database. The deploy job of the same run
downloads that artifact, so no later run, attempt or branch can substitute another one;
a failed deployment is retried with "Re-run failed jobs" (the artifact stays) or "Re-run
all jobs"; a retry of a revision that is already live repeats the release, so the
readback and smoke checks run again. The service browser tests in the browser shards
build their own copy of the Worker output. The setup order below sets the release
credentials last, after pairing works through Access; the typed-code enrollment did when
the owner paired on 2026-10-11. Installed Chrome first paired directly with the deployed
service on 2026-10-11 ([device enrollment](architecture.md#device-enrollment)). A
deployment also needs the `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `ACCESS_PAIR_AUD`
Worker secrets; the owner pages answer 503 without the first two, and cf refuses to
deploy without any of them. Artifact tests reject tampering and mismatched provenance.

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
  [ADR 0020](adr/0020-direct-device-pairing.md)) must not be added to the Bypass
  application: it needs the owner's Access session.
- Pairing without WARP: the owner decided on 2026-10-12 that browsers without WARP,
  such as an agent's cloud computer, may pair permanently
  ([ADR 0030](adr/0030-pairing-without-warp.md)). A third self-hosted Access
  application, "pateat pair", covers `pateat.takuk.me` with path `pair` (and the paths
  below it) and takes precedence there. Its Login method is One-time PIN, the team's
  only identity provider (checked 2026-10-12), as on the host-wide application.
  Policy 1 is the same reusable policy as the host-wide application (email domain and
  WARP); Policy 2 includes the owner's email address only and requires the One-time PIN
  login method, without WARP.
  Session Duration is 15 minutes, and Cookie Path Attribute and Binding Cookie are on.
  Its Application Audience (AUD) Tag is the `ACCESS_PAIR_AUD` Worker secret; the
  Worker accepts it on `/pair` and `/pair/signed-in` only, and an empty value turns
  it off while "pateat pair" does not exist; once it exists, Access issues only its
  audience on `/pair`, so emptying the secret then stops all pairing. `/manage` keeps
  requiring WARP. If another identity provider is added under Integrations, Identity
  providers, Policy 2 still admits One-time PIN sign-ins only. After pairing on a
  vendor's machine, open `/cdn-cgi/access/logout` there.
- Pairing extension IDs: `PAIRING_EXTENSION_IDS` is a committed JSON variable in
  `cloudflare.config.ts` that lists Pateat's production extension ID. It is not a
  secret, workflows do not synchronize it, and it needs no GitHub environment variable
  or Worker secret; a release deploys the committed list.
- Worker secrets: `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_PAIR_AUD`, `OIDC_ISSUER`
  and `OIDC_SIGNING_KEYS` are set once during bootstrap; workflows never synchronize
  them. cf refuses to create a Worker without its declared secrets, so the first deploy
  passes all five at once with
  `cf deploy --prebuilt --mode production --secrets-file <file>` (JSON) and deletes the
  file afterwards; later changes use
  `cf workers secrets update <NAME> --worker pateat-api --type secret_text --text <value>`;
  cf refuses the update without `--type secret_text`. With several accounts visible to
  the login, cf also needs `CLOUDFLARE_ACCOUNT_ID`. Versions created by routine releases
  keep the secrets.
- Adding `ACCESS_PAIR_AUD` (2026-10-12): cf also refuses a release whose declared secret
  is missing, and the AUD tag exists only after "pateat pair" is created, while
  creating it before the Worker accepts its tag stops all pairing. The order is
  therefore: set `ACCESS_PAIR_AUD` to the placeholder `none`, which no Access token
  carries; merge the change and let it release; create "pateat pair"; then immediately
  set `ACCESS_PAIR_AUD` to its Application Audience (AUD) Tag.
- Delivery: the `Deploy tested server` job of `ci.yml` releases automatically after
  `CI Check` passes on a main push (the owner chose this single workflow on
  2026-10-12; it replaced a separate `deploy-server.yml` started by `workflow_run`).
- Preview: there is no preview deployment for now. Without the owner web UI there is
  nothing to review in a browser: the routes outside Access are `/health`, the OIDC
  discovery documents and the device-authenticated `/v1/*`, which the
  Worker tests cover, and a useful preview would need its own D1 database and Access
  setup. Add a `worker-preview` deployment with a separate preview D1 binding, as biwa
  does for its docs, when the owner web UI exists. The web UI now exists; adding the
  preview is not scheduled yet.

The deploy job has no enable switch: the owner decided on 2026-10-11 that every
successful main-push CI run starts a release. Until the production credentials exist,
each run fails at the job's first step without changing anything. Set the release
credentials last: first bootstrap the Worker and its Custom Domain, the Access
applications and the Worker secrets, and verify pairing through Access; otherwise a
release would apply migrations and then fail to activate a missing Worker. Then set the
`production` environment variables `CLOUDFLARE_ACCOUNT_ID`, `SERVER_WORKER=pateat-api`
and `SERVER_HEALTH_URL=https://pateat.takuk.me/health`; the account ID is not a secret.
Put the `CLOUDFLARE_API_TOKEN` secret in the `production` environment only. The owner
chose on 2026-10-11 to use this one token for both the migrations and the deployment, as
in kogane, because both run in the same job. It is an Account API token, not a user API
token, so it does not depend on one person's login, and its scope is as narrow as
Cloudflare allows (owner decision, 2026-10-11). The token created on 2026-10-11 is
"pateat-github-actions-production" with Individual Workers Editor on `pateat-api` only
and D1 Write for the whole account, because the dashboard offers no per-database D1
scope. The release limits itself to the recorded database ID, and routine releases do
not touch the Custom Domain, so the token needs no zone permission. The `production`
environment accepts deployments only from `main` (Deployment branches and tags: selected
branch rule `main`, set by the owner on 2026-10-11), so a workflow on another branch
cannot read the token. This repository does not supply or provision them.

Each main push releases its own tested revision, but only when that revision is ahead of
the live server. Main often gains merges faster than CI finishes, so releases can reach
the lock out of order, and the lock keeps only one waiting job: a job that arrives later
cancels the one already waiting, whichever revision it holds. The server can therefore
stay on an older revision until the next main push releases; re-running the cancelled
deploy job releases that revision if it is still ahead of the live one. Inside the
non-cancelling lock the job compares the revision with the one `/health` reports and
releases only one that is ahead of it, so the server never moves back; an identical or
older revision is skipped with a note in the step summary, except that a retry (run
attempt 2 or later) of the live revision repeats the release. When `/health` gives no
revision, only the current main head may be released. A live revision that is not on
main fails the run instead of skipping, and every later run fails the same way: the
owner puts a main revision live by hand (a local `cf deploy` of that checkout with the
production token), after which the next main push releases normally. (The earlier
`workflow_run` design released the newest main revision whose CI had passed, which
needed a run lookup, and `workflow_dispatch` with a CI run ID for retries and
replacements. The owner dropped both on 2026-10-12: the job releases its own run's
artifact, a retry is a re-run, and no dispatch replaces a live revision outside main.) A
waiting release that is cancelled makes its run show as cancelled while its `CI Check`
passed. The job fails before any change when the token is empty or the account ID is not
a 32-character hex ID. It restores only the hashed artifact of its own run (revision,
run ID, event, branch, per-file and migration digests, Worker name, the account ID and a
health URL on the Worker's Custom Domain), applies the released migrations, deploys
through the pinned action without rebuilding, and verifies returned deployment IDs and
the hosted revision; it tries `/health` up to 30 times, 2 seconds apart, while the new
version propagates. The action creates the 100% deployment and then reads it back from
the Cloudflare API within a fixed 30 seconds; it never repeats an upload or activation
itself, and a late or missing answer fails with `deployment_readback_pending`. On
2026-10-12, three of four releases between 12:26 and 12:54 UTC failed in activation:
ffa712f and e199920 with `deployment_readback_pending` (about 31.5 s after the upload;
the passing releases read the deployment back about 3 s after it), and 0a73b56 with
`504 Gateway Timeout` on the version upload (no version or deployment was created). The
action prints no HTTP statuses, so the reason for the missing readback (error 10336
"not visible yet" or no timely answer) is not confirmed. The job therefore waits 30
seconds and runs the activation a second time when the first one fails; the retry must
pass the same strict readback, and when both fail the job fails (check `/health` before
re-running; a re-run is safe in either case). The retry runs after any failed first
activation, including a readback that found a different current deployment, which the
action alone would refuse; only an out-of-band change (a dashboard rollback, a manual
`cf deploy`) within that window can cause it, and the retry then deploys the newest
released build over it. The lock serializes releases, so a retry never re-activates an
older version. Before `cf d1 migrations apply`, it reads the database by the recorded ID
and requires the name `pateat`; afterwards no migration may remain unapplied. A failed
migration stops the release before activation. Before the first public release,
migrations need not be additive and the previously serving Worker need not keep running
on the new schema
([compatibility before release](development.md#compatibility-before-release)); cf
compares applied migrations by name only, so an applied migration file is never edited.
`cf d1 migrations` is a preview command of the pinned beta cf; recheck this step when cf
is updated. Only the activation is retried automatically, once; otherwise the next
successful main CI run releases its revision if that is ahead of the live one, or re-run
the failed main run's jobs. Routine
releases never change the Custom Domain or other triggers; the bootstrap applies them
once. The complete service release gates below remain planned, including automatic
promotion/failure acknowledgement.

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

If migrations fail, do not deploy. If activation/readback/smoke checks fail (after the
one automatic activation retry described above), leave the release failed, retain
sanitized evidence, and stop automatic further promotion. Restore a retained compatible
build artifact through the same scoped action, producing a new version ID, and repeat
readback/smoke checks. The action does not accept an old version ID as a substitute for
Build Output. Additive schema is retained; do not run automatic destructive
down-migrations. A bad recipe has its own revision rollback/revocation and does not
require replacing the whole Worker.

Document actual deployed IDs, schema version and smoke result in release output,
not a manually maintained duplicate state file. Real-model checks and spending
are separately controlled with bounded requests and explicit budget configuration.
The configured monthly spending threshold uses accumulated reported or estimated
cost; it does not promise an exact invoice ceiling. Direct extension inference,
Access-free service authentication, E2EE settings sync and remote MCP are later
options with their own acceptance gates, not dependencies of the initial release.
