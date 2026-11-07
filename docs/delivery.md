# CI and server delivery

Status: CI and guarded server delivery after main CI are implemented, and the service
has been released automatically to `pateat.takuk.me` since 2026-10-11. A manual workflow
packs an extension release as a draft GitHub Release ([extension
releases](#extension-releases)); no extension release has been drafted or published yet.
Automatic extension releases, Chrome Web Store publishing if its policies allow, and a
mode without the service are planned for [phase 3](plan.md#phase-3-public-release).

## Current foundation workflows

`ci.yml` runs the complete mise/hk graph on every PR and main push and on manual runs,
split over these jobs (times from main
[run 42211009805](https://github.com/risu729/pateat/actions/runs/42211009805),
2026-11-06):

| Job | Runs | When | Time |
| --- | --- | --- | --- |
| `Verify` | `mise run check` with `PATEAT_SKIP_E2E=1`, `PATEAT_SKIP_ORDERS=1`, `PATEAT_SKIP_COMPONENTS=1` and `PATEAT_COVERAGE=1`: hk's static checks, every typecheck and unit test (with [coverage](development.md#test-coverage)) and the server build checks, without a browser; on a main push it also packs the server artifact | always | 4 to 6 minutes before 2026-11-06 (5m48s in that run) |
| `Orders and components` | `mise run //packages/contracts:test:orders` (the walks over every order of events of the small logins) beside the three Chromium component suites `//tests/options:test`, `//apps/extension:test:dom` and `//tests/manage:test` (one at a time, with coverage) | always | about 3 minutes expected |
| `Browser (1/6)` to `(6/6)` | `mise run //tests/extension:test` with `PATEAT_E2E_SHARD=<n>/6`, the packaged-extension Playwright suite | always | 2.5 to 4 minutes |
| `CI Check` | fails unless every job above succeeded (a failed, cancelled or skipped job fails it); the only required status check | always, even after a failure | seconds |
| `Deploy tested server` | releases the tested server (below) | main push after `CI Check` passed | about 1 minute |

Rules and their reasons:

- No workflow-level path filters: a skipped workflow reports no `CI Check`. Every PR,
  documentation-only ones included, runs every job; the `Browser` shards are shorter
  than `Verify` and run beside it, so they add no time. A `Changes` job with
  dorny/paths-filter skipped them for documentation-only PRs until 2026-11-06; the
  owner removed it after it hung for 10 minutes on a main push, failed `CI Check` and
  stopped that deployment
  ([run 42060813609](https://github.com/risu729/pateat/actions/runs/42060813609)).
- The three `PATEAT_SKIP_*` variables only move work into parallel jobs; a local
  `mise run check` without them runs everything. The order walks and the Chromium
  component suites leave `Verify` because beside its unit tests they compete for the
  four CPUs: each walk took about 50 s and hit Vitest's 5 s test timeout
  ([run 40034957203](https://github.com/risu729/pateat/actions/runs/40034957203)), and
  the component suites, which run one at a time after both extension builds, made up the
  last 2 minutes of `Verify`
  ([run 42211009805](https://github.com/risu729/pateat/actions/runs/42211009805));
  started beside the unit tests instead, they still took 2m40s there because the type
  check gating the builds and the suites themselves slowed down
  ([run 42225972636](https://github.com/risu729/pateat/actions/runs/42225972636)). Keep
  `Orders and components` under the longest `Browser` shard.
- The Playwright suite runs as six shards, one worker each, split by test
  (`fullyParallel`). `tests/extension/shard-reporter.ts` deals the tests out in turn,
  keeping a `serial` or `default` mode suite together, because Playwright's contiguous
  ranges put all 21 `login-generation.spec.ts` tests in one shard
  ([run 39795207166](https://github.com/risu729/pateat/actions/runs/39795207166)).
- Browsers are installed without `--with-deps`: the `ubuntu-26.04` image already has
  every library Chromium links and the tests are headless, while apt once spent 8 to 9.5
  minutes fetching fonts and `xvfb` from a slow Azure mirror. `Verify` and the shard
  that holds `vaultwarden.spec.ts` run the pinned Vaultwarden and Mailpit images from
  `ghcr.io` with the runner's Docker
  ([Vaultwarden test server](development.md#vaultwarden-test-server)).
- No Windows job (owner, 2026-10-12): the tests drive Playwright's Chromium, no
  extension code branches on the platform, and no Pateat defect was ever found only on
  Windows. Installed Chrome on Windows is covered by the real-Chrome checks.
- A newer push to a PR cancels its older run; each main push finishes its own run,
  otherwise frequent merges would cancel every main run before it could deploy. A main
  run can still end `cancelled` when its waiting `Deploy tested server` job is replaced
  by a later one (see below); that is expected.
- Linux jobs pin `ubuntu-26.04`; `CI Check` only compares results and runs on
  `ubuntu-slim`.
- `.github/actions/setup` holds the mise install (`jdx/mise-action` with the pinned mise
  version and `--locked`), the frozen aube install and, with `browser: "true"`, the
  browser install, for every job in `ci.yml`, `pricing.yml` and `release.yml` that runs
  mise. Jobs call it as `uses: $/.github/actions/setup`, GitHub's
  [self-repository syntax](https://github.blog/changelog/2026-07-30-reference-same-repository-actions-with-self-repository-syntax/),
  which loads it from the running commit; zizmor's `self-repository` audit flags the
  `./` form.

The other workflows:

- `codeql.yml` analyzes TypeScript/JavaScript and Actions on every PR, every main push
  and weekly. Like CI, only a newer PR push cancels a running analysis, so every main
  commit keeps its own result. It needs no Actions cache: dependency caching is off by
  default in advanced setup and its TRAP cache is disabled, so the workflow sets
  `cache-mode: none`.
- `pricing.yml` refreshes the committed Claude rates daily (ADR 0014): on a change it
  commits through the contents API, so GitHub signs the commit, opens a PR from
  `pricing/claude-rates`, and starts `ci.yml` there by `workflow_dispatch`, since a push
  or PR made with the job token starts no workflow. Opening that PR needs the repository
  setting that allows GitHub Actions to create pull requests.
- `release.yml` maintains the extension release PR and publishes merged ones
  ([extension releases](#extension-releases)).

GitHub Code Quality is not used: since its
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
- Pairing without WARP: the owner decided on 2026-10-12 that browsers without WARP, such
  as an agent's cloud computer, may pair permanently
  ([ADR 0030](adr/0030-pairing-without-warp.md)). A third self-hosted Access
  application, "pateat pair", covers `pateat.takuk.me` with path `pair` (and the paths
  below it) and takes precedence there. Its Login method is One-time PIN, the team's
  only identity provider (checked 2026-10-12), as on the host-wide application. Policy 1
  is the same reusable policy as the host-wide application (email domain and WARP);
  Policy 2 includes the owner's email address only and requires the One-time PIN login
  method, without WARP. Session Duration is 15 minutes, and Cookie Path Attribute and
  Binding Cookie are on. Its Application Audience (AUD) Tag is the `ACCESS_PAIR_AUD`
  Worker secret; the Worker accepts it on `/pair` and `/pair/signed-in` only, and an
  empty value turns it off while "pateat pair" does not exist; once it exists, Access
  issues only its audience on `/pair`, so emptying the secret then stops all pairing.
  `/manage`, and `/extension/profiles` where the extension edits other settings profiles
  ([ADR 0076](adr/0076-settings-profiles-delivered.md)), keep requiring WARP. If another
  identity provider is added under Integrations, Identity providers, Policy 2 still
  admits One-time PIN sign-ins only. After pairing on a vendor's machine, open
  `https://<team domain>/cdn-cgi/access/logout` there (the `ACCESS_TEAM_DOMAIN` host);
  the service's own `/cdn-cgi/access/logout` finds no Access cookie in that browser,
  because "pateat pair"'s cookie is sent below `/pair` only.
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
"not visible yet" or no timely answer) is not confirmed. The job therefore runs the
activation a second time, right away, when the first one fails. Until 2026-11-06 it
first waited 30 seconds; the owner removed that fixed wait (in 100 main runs from
2026-10-20 the retry ran once, in
[run 41823239311](https://github.com/risu729/pateat/actions/runs/41823239311), and
passed). The retry must
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

## Extension releases

`release.yml` ("Extension release") releases the extension the way biwa does with
release-plz (owner, 2026-11-03 03:19 UTC:
「リリースworkflowはbiwaみたく、マージしたら走る感じで」), with
[release-please](https://github.com/googleapis/release-please-action):

1. Every push to main runs the `Release PR` job, which opens or updates one release PR.
   It raises `version` in the root `package.json` and in `apps/extension/package.json`
   (x.y.z) and adds the release's section to `CHANGELOG.md`, from the Conventional
   Commit titles since the last release: `feat` and breaking changes raise the minor
   version and `fix`, `perf` and `revert` the patch version, while 0.x lasts
   (`bump-minor-pre-major`). Commits that touch only
   `services/`, `apps/docs/`, `docs/` or `tests/` are left out, since the service and
   the docs website deploy on their own. `release-please-config.json` and
   `.release-please-manifest.json` hold the settings and the last released version;
   `bootstrap-sha` is where the history starts. `bun.lock` keeps the old workspace
   version, which installs accept.
2. Merging the release PR is the release. On that push the same job tags `v<version>`
   at the merge commit and creates a draft GitHub Release with the changelog section.
   Only the owner merges a release PR, or Claude on the owner's word; the rule that
   Claude merges its own green PRs does not cover it.
3. The `Pack` job (read-only token) checks out that commit, installs the locked tools
   and dependencies, runs `mise run check:sdk-source` and
   `mise run //apps/extension:zip` with `PATEAT_RELEASE=true`, the release build
   ([ADR 0019](adr/0019-local-diagnostics-and-logs.md#amendment-debug-logging-stays-on-before-publishing)),
   then `.github/scripts/extension-release.mjs pack`, and checks that the packed tag is
   the one release-please made.
4. The `Publish release` job, which alone holds `contents: write` and never checks out
   or runs repository code, downloads the packed files, checks `SHA256SUMS` and that the
   release text names this commit and tag, attaches the ZIP and `SHA256SUMS` to the
   draft, appends the release text to it and publishes it as the latest release. If
   `Pack` or `Publish release` fails, the release stays a draft with its tag; fix the
   cause and re-run the failed jobs.

The release PR and the tag are made with the bot GitHub App's token, because a PR or tag
made with `GITHUB_TOKEN` starts no workflow and the release PR would get no `CI Check`.
The App's client ID is the repository variable `BOT_APP_CLIENT_ID`, which a job's `if`
can read (an environment's variables come only after the job starts), and its private
key is the `release` environment's secret `BOT_PRIVATE_KEY`; the App needs contents and
pull requests write access to this repository. Until the variable is set, the
`Release PR` job is skipped. The App is `pateat-release-bot` (App ID 5594177), owned by
risu729, private, with no webhook, Contents and Pull requests read and write, and
installed on this repository only; it was created on 2026-11-03 from the owner's PC at
the owner's request, its private key went straight into the secret and the downloaded
file was deleted. Its first run,
[41630408709](https://github.com/risu729/pateat/actions/runs/41630408709), made the
token and finished the `Release PR` job. To replace the key, generate a new one on the
App's page, set it with `gh secret set BOT_PRIVATE_KEY --env release`, and delete the
old key there. Nothing uploads to the Chrome Web Store or uses a signing key.

Started by hand with the `dry-run` input, on any branch, the workflow only runs `Pack`
for that branch and keeps the files as the run's artifact. Use it to check a release's
files before merging its release PR.

The pack script refuses a dirty checkout, another revision than `PATEAT_REVISION`, and a
manifest that is not the production build of that version (fixed `key`, HTTP(S) host
access). It writes to `work/extension-release/`:

- `pateat-<version>-chrome.zip`: the built extension.
- `SHA256SUMS`: its SHA-256.
- `notes.md`: the release text, with links to the revision and the run, the tag's
  "Source code" archives that GitHub attaches to every release, and the Bitwarden SDK
  source at the commit the bundled package's `VERSION` names.

The release attaches no source archive of its own: like most GPL projects, its source is
the repository at the release tag, with `bun.lock` pinning the other packages, and the
SDK's upstream archive (owner, 2026-11-03 12:45 UTC:
「一般より手厚くするの不要なため、できるだけ配布物が小さくなるようにして」;
[release source](sdk-source.md#release-source)). Releases are never deleted (owner,
2026-11-03 12:34 UTC, "ずっと残す").

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
required independent review pass. Before merging, read the PR's description and
comments: a question to the owner or a hold that is still open there blocks the merge
(added after the owner found PRs called mergeable whose descriptions held open
questions, 2026-10-18 02:12 UTC). A merge that releases the service to production,
including the paid calls the release starts within the spending caps, needs no separate
owner confirmation (owner, 2026-10-19 04:43 UTC, answering a request to merge and
release a change that re-judged pages: 「今後聞かなくていい」, "no need to ask from now
on"). Normal merges do not use the administrator bypass, except for a PR blocked only
by unsigned commits (owner, 2026-10-19 01:01 UTC: "i allow bypass merging for PRs with
unsigned commits"). Implementation is not deferred to later or follow-up work unless it
is very large (owner, 2026-10-19 21:00 UTC:
「実装を後回しにするのは基本的によほど大きくない限りやめて」).

### Branch cleanup

A branch whose contents are not needed, for example because they are already
squash-merged into `main` or were superseded, may be deleted without asking the owner
each time (owner, 2026-11-02 07:01 UTC:
「ブランチは消してよいです。中身が必要でなければ常に」, "branches may be deleted,
always, when their contents are not needed"). The branch of an open PR, including a
parked one, still holds needed contents and stays.

### Issue labels

Every issue gets one `type:` label and, where it applies, one `area:` label. Labels were
set up on the owner's request (2026-10-23 21:34 UTC), replacing GitHub's defaults.

| Label | Use |
| --- | --- |
| `type: bug` | Pateat does something wrong, or nothing where it should act |
| `type: feature` | New behaviour or a change to how Pateat works |
| `type: refactor` | Code change with no change in behaviour |
| `type: docs` | Documentation only |
| `type: task` | Maintenance or tracking work that is none of the above |
| `area: extension` | `apps/extension` and `packages/bitwarden`: content scripts, worker, popup, options |
| `area: service` | `services/api` and `packages/inference`: API, `/manage`, recipe generation |
| `area: ci` | GitHub Actions, build and release |
| `security` | Affects how credentials or vault data are protected |
| `accessibility` | Barrier affecting people with disabilities |
| `status: needs real chrome` | Waiting for a check in the owner's real Chrome |
| `status: needs log` | Waiting for the diagnostics log of the failed attempt |
| `status: needs decision` | Waiting for the owner's decision |
| `resolution: not reproducible` | Closed: a check on a later build did not show the problem |
| `resolution: duplicate` | Closed: the same problem is tracked in another issue |
| `resolution: by design` | Closed: the behaviour is intended |
| `resolution: won't fix` | Closed: the owner decided not to change it |

An issue in `packages/contracts` gets the area of the side it breaks, or both.
Remove a `status:` label once its wait ends. Close an issue as not reproducible only
after a recorded check failed to show the problem: add `resolution: not reproducible`,
close it as "not planned", and comment with the build (commit link), where it was
checked (real Chrome or cloud Chromium) and what was seen. An issue that only waits for
a log keeps `status: needs log` and stays open. `dependencies` and the package-manager
labels (`bun`, `mise`, `github-actions`, ...) are added by Renovate.

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
Cloudflare Vite plugin together. cf requires Node >=22.18; aube is the
package manager and Node the runtime. See [research](research/2026-10-10-feasibility.md)
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

Use the [operations runbook](operations.md) for current triage, retry commands and
recovery limits. A failed run does not pause future automatic releases; the
promotion/failure-acknowledgement gate remains unimplemented.

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

## Docs website delivery

The separate `pateat-docs` Worker serves only static assets at
`https://pateat.takuk.me/docs/` and `/docs/ja/`. Its exact `/docs` and `/docs/*` routes
take precedence over the API Worker's Custom Domain without capturing other paths. The
build is described in [development](development.md#docs-website).
[Cloudflare documents this route precedence](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#interaction-with-routes).
The pages sit in a `docs/` directory of the Worker's assets instead of using an
[asset base path](https://developers.cloudflare.com/workers/static-assets/routing/advanced/serving-a-subdirectory/):
the first bootstrap on 2026-11-07 at 06:39 UTC failed with Cloudflare API error 100343,
"A non-root assets.base_path is not enabled for this account", after uploading the
assets and before creating the Worker or its routes.

Every CI run packages and checks the docs without credentials. A trusted main-push
Verify job archives the tested output as `docs-<sha>`, recording repository,
revision, run ID and file digests. After `CI Check` passes, `Deploy tested docs`
downloads that artifact from the same run, verifies its provenance, asset-only
configuration and digests, and deploys that exact output with the pinned deployment
action. No build or PR artifact is promoted inside the credential-bearing job.
The docs lock is separate from the server lock; an old run that acquires it after
main advanced skips release. Deployment readback and public revision, English and
Japanese page smoke checks must pass.

The owner saved the Access change on 2026-11-07 at 03:43 UTC, as recorded in
[issue 1322](https://github.com/risu729/pateat/issues/1322). The `pateat bypass`
application covers `/v1/*`, `/health`, `/.well-known/openid-configuration`,
`/.well-known/jwks.json`, `/docs` and `/docs/*`. Pairing keeps its own
`pateat pair` application on `/pair`. A cookie-free check at 03:44 UTC found
`/docs`, `/docs/` and `/docs/guide` reaching the API's JSON 404 without an
Access page, `/manage` still returning Access 403, and `/health` returning 200.
The docs routes are not deployed by that Access change.

### Docs bootstrap

The owner authorized deployment in
[issue 1322](https://github.com/risu729/pateat/issues/1322). Until the new `docs`
environment has its credential, the deploy job fails at its first step without
checking out code or changing Cloudflare. It uses no enable switch and leaves the
API Worker's separate production job and token unchanged.

The Worker must exist before its token is created: the Account API token form
only lists existing Workers under Specified Workers (checked by the owner's local
session on 2026-11-07 at 03:46 UTC; owner decision at 03:47 UTC). After this change
merges, the owner's local session uses the pinned toolchain and its own Cloudflare
login, with the intended account selected, and runs from the repository:

```sh
mise run //apps/docs:bootstrap
```

The task builds and checks the docs, then executes these commands in `apps/docs`:

```sh
node ../../node_modules/cf/bin/cf deploy --prebuilt --mode production
node ../../node_modules/cf/bin/cf workers triggers deploy --prebuilt --mode production
```

The first deploy creates `pateat-docs`; the trigger command installs only the exact
`/docs` and `/docs/*` routes. These two routes replace the issue's broader
`/docs*` proposal so paths such as `/docs-other` still reach the API. The
[prebuilt cf commands](https://developers.cloudflare.com/cf/projects/#deploy-a-prebuilt-build)
do not rebuild or run automatic project configuration. Check the public English
`https://pateat.takuk.me/docs/` and Japanese `/docs/ja/` pages after bootstrap.

Only then, in the owner's Chrome:

1. Create the **Account API token** `pateat-github-actions-docs`, never a user token.
2. Set **Individual Workers Editor**, **Specified Workers = pateat-docs**.
3. Set **Workers Routes Edit**, **Specified Domains = takuk.me**.
4. Create the GitHub environment `docs`, restricted to branch `main`, with secret
   `CLOUDFLARE_API_TOKEN` containing this token and variable `CLOUDFLARE_ACCOUNT_ID`
   containing the exact account ID. The same secret name in the separate environment
   does not reuse the service's production token.

Later main pushes deploy through CI. Routine versions preserve the bootstrap
routes with `deploy-triggers: false`. No token is created or read by a cloud agent.

### Docs previews

Per-PR previews remain a proposal. A same-repository PR build can still execute
attacker-controlled dependencies or build code, so giving it even a docs-only
token changes the delivery trust model. This implementation has no privileged
`pull_request_target` path, no fork previews and no automatic upload of PR code.
After an owner decision, a separate preview workflow can use isolated docs-only
credentials and preview hosting without changing the production routes.
