# Development workflow

The foundation has an aube-installed workspace, pinned tools, local policy settings,
shared contracts, and a settings/recipe sync Worker skeleton. A separate localhost probe
exercises the declarative login executor with synthetic values. Manual Bitwarden setup
and local vault caching are implemented, and the settings page can pair with a sync
service; production login activation, settings/recipe sync in the extension and provider
inference remain unimplemented; AI roles are evaluated offline only. M1 is not complete
until its required checks and acceptance gates pass.

## Workspace and tasks

The workspace uses one lockfile, `bun.lock`, which aube installs from
([ADR 0032](adr/0032-aube-package-manager.md)):

```text
apps/extension/       WXT entrypoints and extension shell
apps/docs/            VitePress docs website with the user-facing pages
services/api/         Cloudflare Worker sync API and D1 schema
packages/contracts/  Shared Valibot schemas and inferred types
packages/bitwarden/  Provider-specific endpoint and transport boundary
packages/inference/  Offline AI role adapters, evaluation corpora and harness
tests/extension/      Isolated synthetic browser fixtures and tests
tests/options/        React component tests in isolated Chromium
tests/vaultwarden/    Synthetic Vaultwarden and Mailpit containers, seeding and a self-check
```

Keep feature code inside its owner until an actual shared boundary warrants another
package. The Drizzle schema in `services/api/src/db/schema.ts` owns the D1 schema;
`mise run //services/api:generate:migrations` writes SQL to `services/api/migrations/`
without contacting a database, and the check graph fails if committed migrations drift.

The ordinary judged-page completion rule of
[ADR 0029](adr/0029-local-sign-in-state.md#implementation-notes) lives in
`apps/extension/src/login/completion-policy.ts`: pure functions select an undecided
candidate, settle it from the fresh reading and disabled-field omission, and choose the
judged outcome. `runtime.ts` retains the asynchronous page re-read, current-run checks,
handler takeover and reporting. Its `judgeMove` and `judgeStop` keep their distinct
completion rules. The policy's table tests pin the existing behavior; extracting it
does not change what an undecided answer means.

`mise.toml` owns exact tool versions and installation. Tool lockfiles use format
version 3 and `lockfile_mode = "generate"`, rebuilding them from current requests
while reusing unchanged artifacts. The repository-wide tasks live in the root
`tasks.toml`, which the root `mise.toml` loads with `[task_config] includes`
(owner decision, 2026-10-12); each project's tasks stay in its own `mise.toml`. Use
native workspace mise tasks, not package.json scripts or wrapper scripts that duplicate
the task graph. aube installs dependencies; pinned supported Node executes tools that
require it, notably cf, and Bun writes the lockfile and runs the two inference scripts
that use it. aube's settings are in `aube-workspace.yaml`: its `packages` list must
match the `workspaces` globs in `package.json`, which Bun and Renovate read, and
`paranoid: true` makes an install fail on a dependency build script missing from
`allowBuilds`, on a version newer than 24 hours when it resolves one, and on an OSV
malicious-package hit. Commit `mise.lock`, the aube tool locks under `.mise/locks/` and
`bun.lock` after resolving them, never hand-author a purported installed dependency
graph. Bun writes `bun.lock`: change dependencies with `bun add --exact`, `bun remove`
or `bun update`, each with `--lockfile-only` so that only aube installs packages and
runs their build scripts, then `mise run install`, because aube 2.7.0 rewrote
`bun.lock` into a form its own frozen install refused
([ADR 0032](adr/0032-aube-package-manager.md)); the fixes released in aube 2.7.1 are
not checked here yet ([lockfile gaps](research/2026-10-12-aube-lockfile-gaps.md)).
Renovate updates `bun.lock` with Bun too.

`min_version` in the root `mise.toml` stays at 2026.10.8 (owner decision, 2026-10-13).
The owner's Windows mise comes from winget, which lags mise releases and refuses
`mise self-update`, so a higher minimum stops every mise command there. Do not lower it
to the oldest version that works, and raise it by hand only when the repository needs
a newer mise. CI pins the mise version in `jdx/mise-action`, which Renovate updates, so
a mise release that breaks the repository fails CI. The shared Renovate preset raised
`min_version` with every mise release; that manager moves to risu729/dotfiles
([risu729/renovate-config#2696](https://github.com/risu729/renovate-config/pull/2696)).

The repository is a mise monorepo (owner decision, 2026-10-11). The root `mise.toml`
sets `monorepo_root = true` and lists `apps/extension`, `apps/docs`, `services/api`,
`packages/*` and `tests/*` as config roots. Each of those directories has its own
`mise.toml` with the tasks for its code, run from that directory, and the tools and
environment come from the root. A task's full name is its path and name, such as
`//services/api:build`; inside that directory `mise run :build` also works. Each project
has a `test` task (the extension's `test` runs its `test:<area>` tasks) and each except
`packages/contracts` has a `typecheck` task, so `mise run '//...:typecheck'` type-checks
everything. mise reads the workspace graph, so `mise run --affected '//...:test'` tests
the workspace packages with changes since `HEAD~1` (including uncommitted and untracked
files) and the packages that depend on them. A change outside a workspace package, such
as `docs/`, `scripts/`, `tests/*`, the root `mise.toml` or `tasks.toml`, selects every
package, and the `tests/*` suites are not workspace packages, so `--affected` never
selects them. Repository-wide tasks (`install`, `check`, `fix`, `check:runtime`,
`check:docs`, `check:sdk-source`, `test:tools`, `coverage:summary`, `browser:install`,
the probe servers, `render:icons` and `generate:oidc-key`) stay in the root
`tasks.toml`. Run them by their plain names from the root, or as `//:check:runtime` from
inside a project.

`check:runtime` is one dependency graph rather than a list of separate `mise run` calls:
it depends on `//...:typecheck`, `//...:test`, `//services/api:check:*` and
`test:tools`, so a new project task with one of those names joins it, each
build runs once, and independent tasks run in parallel. Ordering is declared where it
matters: the extension build waits for the tasks that read `.wxt`, and the Vitest
Browser Mode and Playwright suites run after both builds and one at a time, because a
build that rewrites watched files reloads the Vitest page and the suites share one port.
The Vitest Browser Mode suites all use the repository root, so each sets its own Vite
`cacheDir`; with one shared cache, a suite run after another found the other suite's
optimized dependencies, optimized its own mid-run and reloaded a running test. CI
still runs everything; `--affected` is for local runs only.

A development tool used only as a command is a mise tool, not a devDependency: the
TypeScript compiler is `npm:typescript` in `mise.toml`, so `tsc` comes from mise. A
package that code or configuration imports stays in `package.json` even when it also has
a command, as cf (`cloudflare.config.ts`), drizzle-kit (`drizzle.config.ts`), WXT,
Vitest and Playwright do. Each version is pinned in one place only; aube's version is
the `aube` tool in `mise.toml`, with no `packageManager` field, and mise
installs its `npm:` tools with aube because `npm.package_manager` is left unset. aube
also installs TypeScript as a peer of `@risu729/tsconfigs` (and an optional peer of WXT
and Valibot) and, unlike Bun, links that copy at the root as `node_modules/.bin/tsc`.
`node_modules/.bin` comes before the mise tools on `PATH`, so the `typecheck` tasks run
the `bun.lock` copy: keep its version equal to the `npm:typescript` pin when either
moves.

`mise.toml` names each tool by its short name in mise's registry, with mise's default
backend for it (owner decision, 2026-10-12 13:06 UTC); Renovate resolves short names
through the same registry. A tool keeps a `backend:name` form only when no short name
installs it: `npm:typescript` has none, and the registry's `oxlint` (the aqua backend)
expects `apps_v` release tags, which oxc stopped using after 1.84.0, so
`npm:oxlint` stays.

`python` and `uv` run `yamllint`, which mise installs with its `pypi` backend from the
uv graph that `mise lock` records under `.mise/locks/yamllint/`. Keep `python` on 3.14
until every package in that graph publishes a wheel for the next minor version.
PyYAML 6.0.3, which yamllint needs, has wheels only up to cp314, and a locked install is
wheel-only (`uv sync --frozen --no-build`). With `python` moved to 3.15.0, `mise lock`
still succeeded but `mise install --locked` failed with "can't be installed because it
is marked as `--no-build` but has no binary distribution" (checked 2026-10-11 with
mise 2026.10.7 and uv 0.13.0).

`hk.pkl` imports [risu729/hk-config](https://github.com/risu729/hk-config) at a pinned
release tag. hk provides the single complete check entrypoint,
delegating work to mise. Avoid recursion between hk check and mise checks.

The automatic custom `aube_workspace` mise deps rule prepares the existing frozen aube
installation before tasks and `mise exec` when an input changes or `node_modules` is
missing (the owner allowed mise's experimental features on 2026-10-19;
[platform features](#platform-features)). Its inputs include `bun.lock`, every declared
workspace manifest, `aube-workspace.yaml` and `bunfig.toml`, so a dependency or
install-policy change cannot reuse stale preparation. The built-in aube provider
requires `aube-lock.yaml`, which this repository does not use.
`mise deps --explain aube_workspace` explains freshness; `mise run install` forces a
repair. CI seeds the same rule explicitly with `mise deps --force aube_workspace`; when
`CI=true`, the rule runs the existing clean `aube ci` instead of the local frozen
install. Later tasks reuse that preparation. Deployment retains its existing artifact
flow. This extends the existing installation policy without changing its package manager
or lockfile format.

Install the pinned tools and frozen dependencies, then use the complete check
entrypoint:

```sh
mise install
mise run install
mise exec -- hk check --all --no-fail-fast
```

The shared checks include Oxlint, Oxfmt, separate TypeScript checking,
Markdown/TOML/YAML validation, GitHub Actions hygiene, `mise fmt` for `mise.toml`,
`mise task validate` for `mise.toml` and `tasks.toml`, `hk validate` and Pkl formatting
for `hk.pkl`, and Betterleaks secret scanning. Betterleaks reports only medium- and
high-confidence matches: fixtures, tests and the synthetic corpus are full of
low-confidence generic matches such as `password: "password"`, while vendor token
formats (GitHub `ghp_`, Anthropic `sk-ant-`, Cloudflare API tokens) are medium
confidence or higher. A secret without a vendor prefix, such as a Bitwarden API
`client_secret`, only matches the generic rules and is not reported. CI uses the same
task graph. `mise run fix` applies explicit formatting/lint fixes; the check task must
not mutate source files. Renovate tracks the pinned dependencies and tooling.

Oxlint's `max-lines` keeps every source and test file at 1,000 lines or fewer, blank
lines and comments included (owner, 2026-10-23). Files that were already longer are
listed in the last override of `.oxlintrc.json` with the rule off until each is split;
remove a file from that list when its split lands, and do not add new ones.

Focused tasks are available for diagnosis:

| Task | Purpose |
| --- | --- |
| `mise run //apps/extension:prepare` | Generate WXT types |
| `mise run //apps/extension:build` | Package the Chrome extension shell |
| `mise run //apps/extension:build:probe` | Build the isolated synthetic browser-test variant |
| `mise run render:icons` | Render `apps/extension/icons/*.svg` (listed in `scripts/render-icons.mjs`) into the committed PNG icons (needs `browser:install`) |
| `mise run probe:login` | Serve the synthetic login site on loopback port 3847 |
| `mise run probe:passkeys` | Serve the synthetic passkey relying party on loopback port 3848 |
| `mise run //apps/extension:typecheck` | Check extension source after WXT preparation |
| `mise run //packages/contracts:test` | Test shared schemas, eligibility and revisioned settings storage |
| `mise run //packages/bitwarden:test` | Test provider endpoints and bounded transport with synthetic responses |
| `mise run //packages/bitwarden:typecheck` | Check provider source and test types |
| `mise run //apps/extension:test:login` | Test login executor sources with synthetic vault results |
| `mise run //apps/extension:test:service` | Test sync service pairing and transport with synthetic responses |
| `mise run //packages/inference:test` | Score AI role adapters on the synthetic corpus with fake providers and check the real-page corpus |
| `mise run //packages/inference:typecheck` | Check AI adapter, corpus and harness types |
| `mise run //packages/inference:corpus:formasaurus <checkout>` | Regenerate the real-page corpus from a local Formasaurus checkout ([plan](plan.md#ai-evaluation-harness-progress)) |
| `mise run //packages/inference:corpus:japanese (--refresh [--web] \| --report <file> <url>...)` | Observe public login pages live: refresh the Japanese corpus (or with `--web` the English one), or report listed pages to label ([plan](plan.md#ai-evaluation-harness-progress)) |
| `mise run //packages/inference:bench --paid [--corpus real\|japanese\|web\|judge] [--from n --count n] [--model id] [--effort level] [--speed fast]` | Run the paid Claude benchmark on the synthetic corpus, the Formasaurus real-page corpus, the Japanese pages, the English pages or the sign-in judge's pages, whole or one batch, with the service's model or another one to compare, in fast mode where the model offers it; needs `ANTHROPIC_API_KEY` (in cloud sessions, `PATEAT_ANTHROPIC_API_KEY`) and owner approval for each run |
| `mise run //packages/inference:bench --provider heuristic [--corpus real\|japanese\|web] [--from n --count n]` | Score the free model-free comparator on the same cases, whole or one batch |
| `mise run test:tools` | Test artifact/provenance helpers |
| `mise run coverage:summary` | Merge the coverage that test runs with `PATEAT_COVERAGE=1` wrote and print one row per project ([test coverage](#test-coverage)) |
| `mise run //services/api:generate:migrations` | Generate D1 migration SQL from the Drizzle schema |
| `mise run generate:oidc-key [kid]` | Print a new ES256 key set for the `OIDC_SIGNING_KEYS` Worker secret ([ADR 0015](adr/0015-per-owner-claude-credentials.md)) |
| `mise run //services/api:check:migrations` | Fail when committed migrations differ from the schema |
| `mise run //services/api:test` | Run Worker tests against local Miniflare D1 with committed migrations |
| `mise run //services/api:build` | Generate production Build Output and Worker types |
| `mise run //services/api:typecheck` | Check Worker/config/test types after a server build |
| `mise run //services/api:check:output` | Validate existing production output with cf's prebuilt dry run |
| `mise run //services/api:check:artifact` | Execute that emitted bundle in a fresh local runtime |
| `mise run browser:install` | Install the pinned isolated Chromium browser |
| `mise run //tests/extension:test` | Exercise the extension against synthetic local pages |
| `mise run //tests/options:test` | Exercise settings components with a synthetic client in Chromium |
| `mise run //tests/vaultwarden:test` | Seed a synthetic Vaultwarden server in Docker and read it back with the Bitwarden package ([Vaultwarden test server](#vaultwarden-test-server)) |
| `mise run //apps/extension:test:dom` | Extract observations, resolve element locators, collect diagnostics and run the vault, provider-session and diagnostics stores on native IndexedDB in Chromium |
| `mise run //tests/options:typecheck` | Check component-test and browser-provider types |
| `mise run check:docs` | Check local documentation links |
| `mise run //apps/docs:dev` | Serve the docs website with live reload ([docs website](#docs-website)) |
| `mise run //apps/docs:build` | Render the docs website into `apps/docs/.vitepress/dist/` |
| `mise run //apps/docs:test` | Build the docs website and check every local link and fragment in the built pages |
| `mise run //apps/docs:preview` | Build and serve the built docs website |
| `mise run check:sdk-source` | Validate installed SDK metadata against its pin and render [exact source notices](sdk-source.md#pinned-upstream-source) without writing files |

On Linux, `mise run browser:install --with-deps` also installs the browser's system
dependencies; CI omits it ([delivery](delivery.md#current-foundation-workflows)). Server
type checking and the artifact checks depend on the server build, whose generated files
they read. Set `PATEAT_REVISION` before the build and artifact check to verify a
particular source revision. Without it, local builds use `development`. The default
extension build excludes the test probe; neither variant grants vault or real-site login
capability. Both the extension and `/manage` set Vite's `build.cssTarget` to
`chrome145`, matching their supported minimum, so production CSS preserves native
`light-dark()` theme colors without fallback custom properties. The Worker's inline
`PAGE_CSS` string is not transformed.

Local success is scoped to the tested component. Worker tests and artifact
checks have passed locally; they do not establish production deployment or
installed Chrome use compatibility. Current evidence and unresolved browser
acceptance results are recorded in [dated research](research/2026-10-10-feasibility.md).

Pass one task to each `mise run` invocation; listing several task names turns the
later names into arguments of the first. To run every static check without the
runtime graph, use `mise exec -- hk check --all --no-fail-fast --skip-step runtime`.

### Vaultwarden test server

`tests/vaultwarden/compose.yaml` pins the latest Vaultwarden image and Mailpit by digest
([ADR 0059](adr/0059-latest-vaultwarden-server.md)); Renovate's docker-compose manager
updates both. `startVaultwarden()` in `server.ts` runs it with
`docker compose -p <unique project> up -d`, publishes plain HTTP on random `127.0.0.1`
ports, waits on `GET /alive` (the image's own healthcheck runs once a minute) and on
Mailpit's `/readyz`, and its `stop()` runs `down -v`. Each call starts with an empty
database, so Playwright global setup or a single spec can use it. `seed.ts` registers
synthetic PBKDF2 accounts and encrypts login items with the pinned SDK's `PureCrypto`,
can turn on authenticator and email two-step, and adds the item `bw import` makes from a
passkey export (its credential holds `"response": null`). `mailpit.ts` reads two-step
codes by recipient. The `test` task reads the seeded vault back with the Bitwarden
package; `tests/extension/vaultwarden.spec.ts` signs in to it with the production build
through the settings page over `http://localhost`, including authenticator and email
two-step. Both need Docker with the compose plugin, so `check:runtime`, a local
`mise run check` and `//tests/extension:test` do too. A failed test gets both
containers' logs (`vaultwarden.log` in the Playwright test's output folder, printed by
the self-check). A run killed before `stop()` leaves its project behind:
`docker compose ls --filter name=pateat-vaultwarden` lists them and
`docker compose -p <project> down -v` removes one.

### Docs website

`apps/docs` is the user-facing docs website, built with VitePress 2, which the owner
chose on 2026-10-11 before its stable release
([decisions still requiring evidence](plan.md#decisions-still-requiring-evidence)).
`vitepress` is pinned exactly to `2.0.0-alpha.20`, the npm `next` tag on 2026-10-15. Its
English pages are in `apps/docs/src`: an introduction, installation, setup, permissions
and a draft privacy policy with the Chrome Web Store Limited Use statement. Their
Japanese translations are at the same paths under `apps/docs/src/ja/`, served under
`/ja/` with `hreflang` links when `PATEAT_DOCS_URL` is set
([ADR 0047](adr/0047-japanese-user-docs-locales.md)). The site
serves the extension's own `apps/extension/icons/icon.svg` through a small Vite plugin
in `.vitepress/config.ts` instead of keeping a copy, and `.vitepress/theme/brand.css`
sets VitePress's default theme to the icon's green, darkened where text needs 4.5:1
contrast. The pages link to this `docs/` directory, which the site does not include, by
absolute GitHub URLs.

VitePress fails the build on a dead link between pages. `//apps/docs:test` builds the
site and then checks, with `apps/docs/check-links.mjs`, that every local link, asset
and fragment in the built HTML resolves; it is one of the `//...:test` tasks, so
`check:runtime` and CI's `Verify` job build the site on every run. A pull request that
changes only `docs/` or `apps/docs/` skips the browser shards
([CI](delivery.md#current-foundation-workflows)).

The owner decided on 2026-10-23 that the site is deployed as a public Cloudflare Worker
that serves only static assets, with a preview for each pull request, as biwa does
(12:36 UTC), and that its publishing and deployment follow the owner's other
repositories, whose setup the owner was changing at the time; that deployment is a
separate pull request. The privacy policy's contact is `pateat@takuk.me` (owner, 12:37
UTC). The owner kept the Limited Use statement's approach: while each service serves
only its owner, the request log is the owner reading their own data, and the developer
reads no one else's (2026-10-23). Claude's defaults, pending the owner's confirmation
(2026-10-15): the site lives in `apps/docs` as a workspace package, and its tasks run
VitePress with the mise-pinned Node like the other projects, where biwa runs it with
Bun. The installation page assumes a release is a ZIP file on GitHub Releases, loaded
with **Load unpacked**. `apps/docs/package.json` has no `license` field, like
`services/api`, until the owner decides whether [LICENSING.md](../LICENSING.md)'s
installation material covers the site.

### Test coverage

CI measures test coverage and reports it without failing on it (owner decision,
2026-10-12). The Verify job runs `mise run check` with `PATEAT_COVERAGE=1`, so every
Vitest run writes `coverage/<run>/coverage-final.json` with `@vitest/coverage-v8`; each
`test:<area>` task of the extension names its own `<run>` directory. The next step,
`mise run coverage:summary`, merges those files with `@vitest/istanbul-lib-coverage`
(Vitest's maintained fork of `istanbul-lib-coverage`) and writes line, branch, function
and statement coverage per project (`apps/extension/src`, `packages/*/src`,
`services/api/src`, `services/api/web`) to the job summary; the step runs even after a
failed check and never fails the job. A file reached by several runs, such as extension
code tested by a unit area and a Browser Mode suite, counts once. No threshold fails CI.
The packaged-extension Playwright suite (`tests/extension`) is not measured, so code
that runs only there, such as `apps/extension/src/login/content.ts`, `crypto/worker.ts`
and the connections, crypto and vault `probe.ts` files, shows as uncovered. For the same
table locally, delete `coverage/`, run `mise run check:runtime` with `PATEAT_COVERAGE`
set to any non-empty value, then `mise run coverage:summary`.

Not adopted: Codecov, which adds an external service and an upload token, and GitHub
Code Quality's pull-request coverage, which requires Code Quality; GitHub offers Code
Quality only on GitHub Team and GitHub Enterprise Cloud plans
([GA changelog](https://github.blog/changelog/2026-06-16-github-code-quality-generally-available-july-20-2026/),
checked 2026-10-12), and this repository belongs to a personal account.

### Extension ID

The production build has a fixed extension ID, `PATEAT_EXTENSION_ID` in
`packages/contracts/src/extension-id.ts`. Chrome derives it from the manifest `key`,
which is the public key in `apps/extension/manifest-key.ts`
([ADR 0020](adr/0020-direct-device-pairing.md)). `src/service/manifest-key.test.ts`
checks that derivation, and the browser tests check that Chrome loads the production
build under that ID. Loading an unpacked build needs no private key. A self-hosted build
may use its own key; it then replaces both files with its own public key and ID, and
lists that ID in `PAIRING_EXTENSION_IDS` on its server. The synthetic probe build has no
`key`. It keeps the ID that Chrome derives from its folder, so it never shares storage
with a production install.

The first production build with the `key` changes the ID of an install that was loaded
without one. No key can reproduce the old ID, which Chrome derived from the folder path.
The new ID starts with empty extension storage. These are lost:

- the vault connection, the local vault cache and the retained unlock key, so automatic
  unlock must be set up again;
- the Bitwarden sync sign-in, which may ask for Bitwarden's new-device verification;
- the service pairing and the recipe cache;
- item selection and field exclusions, which are not synced;
- Chrome's site-access choices for the extension and its toolbar pin.

Settings, bindings and recipes held by the service return after pairing again. Reset
an existing install once:

1. Disconnect the service in the old build, or revoke that device on `/manage` later.
2. Remove the old Pateat entry in `chrome://extensions`. Do not press Reload.
3. Load the new build and check that its ID equals `PATEAT_EXTENSION_ID`.
4. Set up the vault connection and automatic unlock again.
5. Pair again (see
   [installed Chrome service pairing](#installed-chrome-service-pairing)).
6. Redo item selection and field exclusions.
7. Optionally remove the old Pateat device from Bitwarden's device list.

### Installed Chrome service pairing

`tests/extension/pairing-service.spec.ts` pairs the production build in bundled Chromium
with the built Worker behind a synthetic stand-in for Cloudflare Access; it is not
evidence for installed Chrome or the deployed service. The stand-in does not model
Access's own `401`, denial page or cookie validation; only the transport unit tests'
synthetic responses cover those. After a release that contains
`POST /pair`, check the deployed path once from installed Chrome:

1. Before the [one-time reset](#extension-id), in the console of the old install's
   service worker, whose path-derived ID is not in `PAIRING_EXTENSION_IDS`, run:

   ```js
   fetch("https://pateat.takuk.me/pair", {
     method: "POST",
     credentials: "include",
     redirect: "manual",
     headers: { "Content-Type": "application/json" },
     body: JSON.stringify({ version: 1, label: "Probe" }),
   });
   ```

   While signed in to Access it must answer `403` with `extension_not_allowed` and
   create no device. This confirms that the session cookie and `Origin` reach the
   Worker. A production build with the committed ID would pair instead. If the old
   install is already gone, run the same probe in the service worker of the synthetic
   probe build (`apps/extension/.output/chrome-mv3-probe/`), whose path-derived ID is
   not in the list either; running it from the production build would create a device.
2. With an SDK-containing production build that meets
   [Corresponding Source](sdk-source.md), pair from the settings page while signed in to
   Access; the device appears on `/manage` with its label.
3. Sign out at `https://pateat.takuk.me/cdn-cgi/access/logout` and pair again: one
   sign-in tab opens on `/pair/signed-in`, and pairing completes after coming back or
   after **Try again**. Then confirm that the first sync completes, disconnect, and
   check that `/manage` shows the device revoked.

Record the date, Chrome version, commit, the Access application's cookie settings and
the results in the [plan](plan.md#remaining-m4-service-gaps). This is service-pairing
evidence, not real-account login evidence.

### Windows notes

Quote `git rev-parse 'HEAD^{tree}'` in PowerShell. CI runs no Windows job (the owner's
decision on 2026-10-12, see [delivery](delivery.md#current-foundation-workflows)). One
local host on 2026-10-10 hit a missing SideBySide assembly ("side-by-side configuration
is incorrect") before the downloaded Chromium launched; a clean `windows-2025` runner on
2026-10-11 launched it and passed all 92 packaged-extension tests (see the
[foundation progress](plan.md#foundation-progress)). If browser tests time out on a slow
local Windows disk, point `TEMP` and `TMP` at a faster drive: on GitHub's `windows-2025`
runners in 2026-10, profiles in the default temp directory on the system drive hit
5-25 s I/O stalls that timed out random tests.

### Cloud sessions

Notes for agents working in a cloud container, observed on 2026-10-12 and 2026-10-13:

- If `mise install` stops because a tool's declared skills cannot be fetched
  (`declared skill(s) ... are not installed`), set `MISE_SKILLS_FETCH=false` for every
  mise command.
- Do not run `playwright install`. When the container's Chromium is another build than
  the one `@playwright/test` pins, point `PLAYWRIGHT_BROWSERS_PATH` at a directory that
  links the container's browser under the pinned build's directory names
  (`chromium-<build>` and `chromium_headless_shell-<build>`, each with an
  `INSTALLATION_COMPLETE` marker); otherwise browser tests fail with "Executable doesn't
  exist". A pass on that other Chromium is no evidence for tab focus or visibility
  behavior; only CI's pinned build is.
- `hk check --from-ref origin/main` checks committed changes only, so commit before
  running it.
- A PR that conflicts with main gets no CI runs at all; merge main into it to start CI.

### Installed Chrome synthetic login probe

This procedure prepares a manual acceptance run; its availability is not evidence
that installed Chrome or Chrome use has passed. Use only the synthetic probe build.
The probe grants host access only to `http://127.0.0.1/*` so the coordinator can
recheck browser-provided tab URLs. Production grants no host access. The probe build has
its own [extension ID](#extension-id) and storage, separate from a production install.

1. Run `mise run //apps/extension:build:probe` and `mise run probe:login`. The latter
   serves only `http://127.0.0.1:3847` and stops with Ctrl+C. It does not contact a
   vault or AI.
2. With the owner's installation approval, load
   `apps/extension/.output/chrome-mv3-probe/` as an unpacked extension in Chrome.
   Record the exact source commit, build, Chrome version and other extensions.
3. Manually open Pateat settings. Add `http://127.0.0.1:3847` as a site default
   for **Demo personal vault / Demo primary account**; it saves at once. Keep the demo
   connection and its branch, username and password fields eligible.
4. Open `http://127.0.0.1:3847/identity` through Chrome use in an inactive tab.
   The extension must fill and advance through the password page itself. Verify
   the fixture's authenticated result, matched-field flags and one click per step.
   Do not fill the fields through the test controller to manufacture success.
5. Close the owner tab before each new attempt. Another tab's login that is running
   or ended without success keeps a new tab from starting until it closes; an
   `authenticated` one, one that ended `interrupted` without submitting, or one Pateat
   itself stopped with nothing in flight lets another tab log in.
   Test `/single`, `/rejection`, `/unknown` and `/ambiguous`; the latter cases
   must stop or abstain without trying another account or repeating submission.
6. Verify site/field exclusion, policy changes, navigation and concurrent Chrome
   use separately. Keep actual observations and unresolved limits in the run's
   evidence. An isolated Playwright pass does not establish these Chrome results.

The fixture exposes synthetic match flags and click counts, not a real account
session. Automated fixtures additionally count POSTs on the local server and can
hold a response to distinguish a delivered request from an observed result.
Probe-only interruption controls pause after durable intent but before delivery,
or after execution but before acknowledgement. Only validated messages from the
extension settings page can configure these controls; web pages cannot. Worker
restart tests reconcile the retained intent without repeating a fill or click.
The probe's login configuration can also shorten the 10-second wait for a step's
elements and an advance's confirmation (`stepWaitMs`), so a test runs past that wait
by waiting for its result instead of sitting it out; the production build always waits
the full time. The probe's login status also counts the observations of each document's
page that a login got back, so a test can wait until a held page was checked again.
The probe has no real-provider adapter. Its fixed localhost recipes and
setup messages are excluded from the production build. Chrome use may not be
able to operate another extension's settings page; manual setup is a supported
test prerequisite, not a reason to expose settings mutations to a web page.

### Installed Chrome synthetic passkey probe

This prepares a manual acceptance run of the passkey bridge; it is not evidence
that installed Chrome has passed. The probe build adds passkey scripts for
`http://localhost/*`, where its synthetic source signs only for RP ID `localhost` with
the public WebAuthn Level 3 test-vector key. HTTPS pages get the production bridge and
vault source; automated tests reach them on `https://synthetic.example.test`, which
never resolves, with the probe build's synthetic Bitwarden account. No real vault,
passkey or provider is involved. The probe build has its own
[extension ID](#extension-id) and storage, separate from a production install.

1. Run `mise run //apps/extension:build:probe` and `mise run probe:passkeys`. The latter
   listens only on loopback `127.0.0.1:3848`, is opened as `http://localhost:3848`, and
   stops with Ctrl+C.
2. With the owner's installation approval, load
   `apps/extension/.output/chrome-mv3-probe/` as an unpacked extension. Record the
   source commit, Chrome version and other extensions, especially any passkey
   provider such as the official Bitwarden extension.
3. Open `http://localhost:3848/`. **Wrapped at document start** must read
   `true`. Another passkey provider's wrapper also reads `true`; only the next
   steps show that Pateat answered.
4. Click **Sign in with a passkey**. It must report
   `Pateat, flags 0x1d, signature verified` without any browser or provider
   prompt. Then click **Sign in requiring UV** in the same tab. Because Pateat signed in
   from this tab, its chooser window opens
   ([ADR 0021](adr/0021-account-choice-outside-settings.md) part D) with its checkbox
   unticked; choose the synthetic passkey, and the page must report the same.
5. Open **Request on page load** in a new tab. Without a gesture it must also report a
   verified Pateat assertion. In the tab of step 4 it would open the chooser instead.
6. Open **Permissions Policy denies passkeys** and click the first button. The
   page must report the browser's `NotAllowedError`, not a Pateat assertion.
7. Record whether another installed passkey provider's UI appeared at any step. With
   another provider installed, steps 4 and 5 must still report Pateat assertions without
   that provider's UI; Pateat's own chooser window in step 4 is expected.
   **Another provider wraps later**, **Another provider falls back** and
   **Another provider is locked** add a synthetic provider wrapper to the page for runs
   without one.

### Filing a bug report

Open Pateat settings and follow **Diagnostics** in the section list, or open
`chrome-extension://<id>/diagnostics.html`. Click **Copy for bug report**, check the
preview, then click **Copy** and paste the text into the report. It names the build
revision, Chrome version and the state of each connection and the Pateat service under
pseudonyms, with no labels, emails, item names, URLs or host names
([architecture](architecture.md#diagnostics)). Add the steps that led to the problem.

For a problem that happened earlier, click **Download logs** on the same page, check the
preview and click **Save file**, then attach the `.jsonl` file, or click **Copy all**
and paste the whole text. Site addresses and recipe IDs are included; check
**Hide site addresses and recipe IDs** to replace them with `site-1` and `recipe-1`. To
record more detail, click **Turn on debug logging**, reproduce the problem, then
download the logs ([local log](architecture.md#local-log)). Until Pateat is published,
debug logging stays on until **Turn off debug logging** turns it off; a published build
turns it off after 24 hours, and its button reads
**Turn on debug logging for 24 hours**.

### Why a passkey request was delegated

The production build logs one `passkey.request` entry per bridged request, at most 30
per minute per tab and origin. Download the logs from the diagnostics page, or open the
service worker console, which shows a `Pateat passkey.request` line for each entry
written while it is open: turn on **Developer mode** in `chrome://extensions`, click
**service worker** under Pateat, then make the passkey request on the site. Each entry
holds:

- `origin`, `outcome` (`assertion`, `delegate`, `cancelled`, `not-allowed` when the
  chooser window was still open as the wait ran out, or `withheld` for a conditional
  request kept unanswered after a Pateat login of its page signed in, or after four
  minutes of waiting for that login or for a pick after a logout) and the delegate
  `reason`. Any request of a hostname listed under "Sites whose passkey requests go to
  the browser" on the settings page is handed on first, as `browser-site`
  ([ADR 0007](adr/0007-existing-passkey-assertions.md), amended 2026-10-23).
  A conditional request is handed on as `no-recipe` (no recipe for the site),
  `no-login` (no login of its page started), `login-ended` (the login did not sign in)
  or `no-pick` (the popup offered its page a choice of accounts outside a logout, with
  an item that holds a passkey, and nothing was picked within four minutes)
  ([ADR 0034](adr/0034-answer-page-passkey-requests.md)). A request outside conditional
  mediation that names its credentials, in a tab whose Pateat login of the origin signed
  in with no logout detected since, is a re-verification while signed in and is handed
  on as `confirm-fill`
  ([ADR 0035](adr/0035-page-kinds-per-site.md#passkey-re-verification));
- once the request is admitted, `rpId` and `allowCredentials` (how many credential IDs
  the site listed);
- once the vault was searched, `stored` (eligible stored passkeys with that RP ID in
  searched connections; excluded and quarantined items are not counted), `accepted`
  (those the request accepts), `siteDefault` and `siteDefaultAccepted` (the same counts
  for the origin's site default item), `siteDefaultItem` (`unset`, `unresolved` when
  the saved account matches no connection, `not-searched` when the item is ineligible
  or its connection was not searched, or `searched`) and `complete`;
- when the chooser window opened, `chooser`: `chosen`, `browser` (the user chose "Just
  once" under "Use the browser or another extension"), `browser-site` (the user chose
  "Always for this site" there), `closed` (the window or its tab was closed),
  `unavailable` (the window could not open, or another request held it), `timeout` (the
  wait ran out; the outcome is `not-allowed`) or `cancelled` (the page cancelled the
  request). A `browser`, `browser-site`, `closed` or `unavailable` ending delegates with
  the reason `chooser-` plus that value; a choice that the settings no longer offer when
  it is looked up again delegates with `settings-changed`, or `vault-incomplete` when
  the vault could not be searched in full;
- `signedBefore` when Pateat had signed for this RP ID in the tab, so the request asks
  again, or `logoutClicked` when instead a control that logs out was clicked on the RP
  ID's site in the tab and still waits for the site's first step (at most 10 minutes,
  while the tab stays on the site), or, after such a click was used, the tab keeps a
  logout state for an origin of the site (ADR 0021 D). Such a request that cannot open
  the window is delegated with `chooser-unavailable`;
- `cause`: for a `cancelled` outcome, who cancelled it (`page-cancelled` or
  `settings-changed`); for the `assertion-failed` reason, the step that threw
  (`browser-site-lookup`, `login-wait`, `account-lookup`, `passkey-lookup`,
  `signed-before-lookup`, `chooser` or `signing`);
- `mediation`: the request's mediation when it names one (`optional`, `conditional`,
  `required`, `silent`, `immediate` or `other`), whatever the outcome;
- `uiMode`: `immediate` for Chrome's Immediate UI, separately from mediation
  ([ADR 0052](adr/0052-immediate-ui-stored-passkeys.md)). Such a request without a user
  gesture delegates with `no-user-activation`, one with a nonempty allow list with
  `immediate-allow-credentials`, and one in incognito with `immediate-incognito`;
  otherwise it is handled as a modal
  request;
- `answerFailed`: why the login's item could not answer a conditional request the login
  gave it (such as `login-item-no-credential`); the login then falls back to the
  password;
- `duringLogin` when a delegated request came in while a Pateat login of the tab and
  origin had not ended. The request then went to the browser or another passkey
  provider, such as the Bitwarden extension, which may show its own prompt during that
  login;
- for the `invalid-request` reason, `invalid`: the request member that broke Pateat's
  bounds (`challenge`, `rp-id`, `allow-credentials`, `allow-credentials.id`,
  `allow-credentials.type`, `allow-credentials.transports`, `user-verification`,
  `mediation`, `ui-mode`, `timeout`, `request` when the copied options are not an
  object, or `other` for a member outside these), and `invalidLength`: its size, in
  bytes for `challenge` and `allow-credentials.id`, in entries for a list and in
  characters for other text. `invalidLength` is left out when the member is missing, is
  not text or a list, or is `other`, and for an allow list none of whose entries is a
  `public-key` one (`allow-credentials.type`). The value itself is never logged.

For example, `siteDefault: 1` with `siteDefaultAccepted: 0` means the default item's
passkey is not one the request accepts. No entry at all means the request never reached
Pateat's background: the page's options were not ones the bridge copies, another
provider's wrapper did not call Pateat's, the request came from a subframe, or the relay
refused the document on its own (an insecure context, a permissions policy that refuses
`publickey-credentials-get`, a document without `document.featurePolicy`, or copied
options longer than 131,072 characters). Entries
never hold credential IDs, user handles or item IDs, and the page is never told the
reason. The origin and RP ID are named only for sites your settings or recipes name;
other sites appear as `origin:7d2b91aa` and `rp:7d2b91aa`.

A site's passkey registration (`navigator.credentials.create`) that excludes credentials
logs one `passkey.create` entry, under the same limit
([ADR 0007](adr/0007-existing-passkey-assertions.md#registration-after-a-sign-in)). A
registration goes to the browser without an entry when the wrapper does not ask the
background: an empty or malformed `excludeCredentials` or other required member, an
unknown mediation, a non-string `rp.id`, a signal that is not genuine or already
aborted, a call whose `this` is not `navigator.credentials`, a document the relay
refuses (a frame, an insecure context or the permissions policy) or a relay that does
not answer. A sender the background refuses (`invalid-sender`) is not logged either.
The sign-ins the check reads are kept per tab in `chrome.storage.session`
(`pateat.passkey-sign-ins.v1`). Each entry holds:

- `origin` and `outcome`: `declined` (Pateat refused it with `NotAllowedError`) or
  `delegate` (handed on to the browser and other providers), with the delegate `reason`:
  `browser-site` (the page's hostname is one whose passkey requests go to the browser),
  `not-signed-in` (no Pateat sign-in to that RP ID in the tab), `expired` (the latest
  one was more than five minutes ago), `not-listed` (no listed credential is a passkey
  Pateat could sign with there), `vault-incomplete` (none is, but a connection or item
  could not be searched, as when the vault is locked), `not-configured` (the site is
  excluded or the settings could not be read), `vault-unavailable` (the sign-in records
  or the lookup failed) or `timeout` (the lookup took too long), `invalid-request`,
  `invalid-origin`, `invalid-rp-id`, `rp-id-mismatch` or `busy`;
- `rpId` once it is valid for the origin, and `excludeCredentials`: how many
  credentials the site listed;
- `mediation`: `conditional` (Chrome's automatic passkey upgrade) or `other`, when the
  request names one;
- `sinceSignIn`: whole seconds since Pateat's latest sign-in to that RP ID in the tab,
  when there was one;
- `listed`, once the listed credentials were checked: whether one is such a passkey.

### Manual Bitwarden setup preview

The connection setup slice is implemented and tested with synthetic responses. Its
options panel selects Bitwarden Cloud US/EU or an ordinary self-hosted HTTPS root (or
plain HTTP on `localhost` or `127.0.0.1`, ADR 0059) and requests access only to that
provider's hosts. Setup is a deliberate user action;
automated tests use synthetic accounts and responses. Do not enter real account
credentials during a test unless that account test has been separately authorized.

The panel submits supported manual verification codes through the same private setup
channel. Choosing email asks the server to send one code, and "Resend code" sends
another (ADR 0059); interactive MFA methods are not implemented. The sync sign-in
persists across restarts as described in
[ADR 0008](adr/0008-durable-provider-sessions.md); Sync refreshes it when needed, and
Forget sync sign-in removes it locally without a server logout. Forget cancels a running
Sync but is refused while a password sign-in is in progress. Offline local-vault
restoration is independent of that provider session.

Each connection is a row with one main action: Unlock while the vault is locked, else
Sync, or Sign in again while syncing needs a sign-in first (setup is incomplete, the
connection is logged out or the sync sign-in is missing). Unlock opens the master
password form in the row and unlocks offline
([ADR 0075](adr/0075-vault-lock-and-timeout.md)). The other of the two, Lock, Log out,
Forget sync sign-in and Delete connection are in the row's menu. Log out removes the
unlock key and the sync sign-in and keeps the encrypted cache, as Turn off automatic
unlock did.

The **Vault timeout** section sets when every vault on this device locks or logs out:
after 1, 5, 15 or 30 minutes or 1 or 4 hours without use, a custom number of minutes,
On system idle, On system lock, On browser restart, or Never (the default). Use is a
field filled, a passkey signed, an unlock or a sign-in. Only Never keeps the unlock key
on disk; any other choice keeps it in memory, so a browser restart locks too.

Delete connection, confirmed in the row, removes one connection from this
device: its sync sign-in, its local vault record with the retained unlock key (after
locking any open vault session), and finally its saved configuration. Like forget, it
is local only: no provider revocation is called, so other sessions stay signed in. It
cancels a running Sync and is refused while a password sign-in for that connection is
in progress. A failed step leaves the connection listed so deletion can be retried.
Saved settings and recipes are not modified: the synced vault policy names the provider
account, not the connection, so it applies again when the account is connected later.
This is how a connection left over by a failed first sign-in is removed.

The add form's **Use this vault** choice is kept on this device until the first sign-in
tells which provider account the connection holds. If that sign-in does not finish,
**Sign in again** completes the setup and keeps the choice. Then it becomes the
account's synced policy, the same switch in the connection's row, unless the account
already has one, which wins ([ADR 0023](adr/0023-synced-vault-policy.md)). Later
sign-ins never change the policy; it is edited on the settings page, and it stays after
Delete connection.

An error, cancellation or unsupported-interaction reply, and stopping setup, re-read
the rows, so a connection whose first sign-in failed shows with Sign in again. Name
and Email clear once a read lists a new connection with the label and email this
page's add sent, and only while the form still holds them, so Connect does not add it
twice. After a final reply only that reply's read can match; after a stop, whose read
can come before the connection is saved, a later Refresh can. A connection another
settings page added leaves this page's draft as typed. When the add ended in an error
or an unsupported interaction and the listed connection never unlocked, the form
also switches from that unchanged draft to Sign in again for the connection, keeping
the error message and focusing the master password (owner decision, 2026-10-19).
**Cancel setup** always leaves sign-in-again mode; when nothing is running it changes
nothing else, so the saved settings draft is not reloaded. It stays available while
the page first reads its connections (owner decision, 2026-10-19): stopping that read
says "Loading stopped.", reads the connections again and leaves the saved settings
draft as it is, since nothing was written.

Connecting and every password sign-in unlock the vault and keep its unlock key where
the vault timeout says. Log out removes the key; only a sign-in brings it back. A
cancellation or timeout during the durable write can leave an accepted record even
when setup reports an uncertain result. Reload connection status; Lock or Log out if
that key should be removed.
Compensation removes only a positively identified first-enrollment candidate,
never an unknown or newer record. Connection status and policy metadata contain
no field values. A changed
catalog preserves unsaved policy edits and requires an explicit reload before
saving those stale edits. An item with custom-field exclusions or an earlier review
whose encrypted custom fields changed waits for review: the settings page lists it under
the connection, starting with every current custom field excluded, and saving the
review records the new evidence for every device. An item whose vault here is older than
the review waits for this vault to sync instead. Until a device's first settings sync
after pairing, the settings page warns that no vault item is used yet.
Automatic website login is not activated by this setup slice.

Each connection's row also holds its vault access policy, from the saved settings
draft, once its vault is unlocked and its account known; the policy belongs to the
provider account (provider, server and user ID) and is synced. It has the **Use this
vault** switch, **Items for Pateat** (all except exclusions, or
selected groups and items only) and two disclosures that start collapsed so a large
vault stays manageable. "Included groups and items", shown only for a selection, and
"Excluded items and fields" count what they hold (fields of an excluded item are not
counted); inside, a line such as `1 of 3 groups, 2 of 40 items selected` or `1 item and
2 fields excluded` sums them up, and each item opens on its own with a summary such as
`Item excluded` or `1 field excluded`. Open/closed state lasts only while the page is
open. These controls wait while saved settings load. A row whose account the saved
settings also name on another server says Pateat does not use it here. The demo vaults
are listed under the rows with the same controls; their settings stay on the device.
Without a Bitwarden setup (the demo preview) the vaults are listed in their own Demo
vaults panel. Custom-field
reviews are not folded; they stay expanded under the connection rows because they block
the item until saved.

## Compatibility before release

Pateat has not been released. Until the first public release, the owner decided on
2026-10-11 that no change keeps backward compatibility with anything an earlier build
wrote or served:

- extension storage: `chrome.storage` keys and record shapes, IndexedDB versions and
  cached vault, session, recipe and settings records;
- the service: older Worker versions, older `/v1/*` request and response shapes, and
  extensions built against them;
- D1 data and schema written by an earlier migration.

The rule covers only what Pateat itself writes and serves. Vault providers are external:
keep every branch for Bitwarden server, account, KDF, key and vault-format versions and
response shapes, such as V1/V2 keys, PascalCase or `null` fields and older ciphers.

Change a format in place and delete the old one; do not add a version branch, a
fallback read, a migration of stored records or an optional field whose only purpose
is older data. Code that exists only for such compatibility is removed. An extension
and a service built from different revisions need not work together, and stored data
from an older build may be discarded, so a reinstall, a new vault connection or a new
pairing is acceptable after an update. Committed D1 migration files are still never
edited after they could have been applied, because cf tracks them by name
([delivery](delivery.md#current-foundation-workflows)). The first public release ends
this rule; compatibility from then on needs its own decision.

One exception, chosen by the owner on 2026-10-12 at 18:07 UTC: D1 migration 0013
rewrites each stored recipe's `completion` into the list of signed-in markers of
[ADR 0029](adr/0029-local-sign-in-state.md), so the owner's recipes keep working without
being generated again.

A second exception, for every stored recipe (owner request, 2026-10-23 11:41 UTC; see
[ADR 0060](adr/0060-recipe-layouts.md#changing-the-recipe-schema-later)): a later recipe
schema change backfills them from the logs without opening login pages where possible.
A change that needs no new model output rewrites them in a migration; one that needs new
model output is rebuilt from the request log's observations by a separate tool; a recipe
that cannot be rebuilt is discarded and generated again on the next visit.

A second exception, chosen by the owner on 2026-10-23 at 21:13 UTC: settings stored
before the synced `passkeyBrowserSites` list existed read it as an empty list, in the
service and in the extension's local snapshot
([ADR 0007](adr/0007-existing-passkey-assertions.md)).

## Platform features

On 2026-10-13 (21:45 UTC) the owner set which browser, runtime and library features
Pateat uses:

- Use new standard APIs, and features of libraries Pateat already depends on, wherever
  they fit. Replace hand-written code that does the same job, and keep the safety checks
  around it (session, generation and origin checks, size limits). Being new is no reason
  to avoid a feature; a feature with no place in the code is not added.
- `minimum_chrome_version` may rise to a version whose stable release (`stable_date` on
  chromiumdash) is at least six months old. Six months is a hard limit: a feature that
  needs a newer version goes to the owner first. The owner also allowed Chrome 148
  (stable 2026-05-05) on 2026-10-13. Raise the minimum only in the PR that uses a
  feature needing it, and say in the manifest comment which feature needs which version.
  The service's owner web UI (`/manage`) relies on the same Chrome version.
- The Worker's `compatibilityDate` (`services/api/worker-runtime.ts`) may be raised
  freely. Scripts use the Node version pinned in `mise.toml`.
- A feature is experimental when Chrome stable has it off by default (behind a flag, in
  an origin trial, or only in Canary or Dev), when its specification is not settled even
  though Chrome stable enables it, or when a library marks it experimental
  (`experimental_` or `unstable_` names, canary or experimental release channels,
  prerelease versions). A specification is settled when a JavaScript feature has reached
  TC39 Stage 4, when a web platform or CSS feature ships enabled by default in at least
  two of Chromium, Gecko and WebKit, and when a `chrome.*` extension API is documented
  as stable in Chrome's extension reference.
- The extension and `/manage` use no experimental feature. In the parts Pateat does not
  ship to users (the Worker, build tools such as the bundler, and tests), an
  experimental feature is used only after the owner approves a proposal covering its
  upstream status (specification stage, intent to ship or origin trial end, recent
  breaking changes) and what removing it would take. A research request is not approval.
- mise is the exception: on 2026-10-19 at 13:37 UTC the owner chose to use mise's
  experimental features (`settings.experimental = true`) and its newest features
  actively, without a proposal per feature.
- Approved before these rules and kept: the AI SDK's `experimental_decide` with `ai`
  pinned exactly ([integration conditions][integration]) and the
  `@cloudflare/vite-plugin` beta described below.

[integration]: #integration-conditions-pending-candidates-remain-conditional

DOM listeners that share an installation or effect lifetime use one locally owned
`AbortController` and register with its `signal`: the code-submission watcher, passkey
relay and service-pairing return listeners. Stopping the watcher or relay, or unmounting
the effect, aborts that controller to remove only its listeners; capture flags and
request cancellation behavior stay unchanged. Mutation observers still disconnect
separately. Single-listener cleanup and Chrome extension events retain their existing
removal APIs.

## Dependency policy

Renovate inherits the pinned `risu729/renovate-config` preset, matching the other owner
repositories. Its GitHub App covers this repository and reads the configuration from
`.github/renovate.json` on the default branch. Cloudflare build and test dependencies
are grouped and allow prereleases. `@cloudflare/vite-plugin` versions are
`2.0.0-beta.sha-<commit>`, which semver compares by the hash text, not by release date,
and Renovate has no release-date ordering. It follows the `beta` dist-tag with
`rollbackPrs`: `followTag` alone never offers a tagged beta whose hash sorts below the
current one, while `rollbackPrs` offers it as a rollback update. Rollback updates are
titled as updates but are not automerged. TypeScript, its shared preset and type
packages are grouped so peer requirements can be reviewed together. `ai` and the
`@ai-sdk/*` packages are grouped into one PR because each pins an exact
`@ai-sdk/provider-utils`: updated apart, `ai` and `@ai-sdk/valibot` can resolve
different copies, and the `Schema` from one is not assignable to the other in
`packages/inference/src/structured.ts`. Updates still have to pass the repository's
required checks.

Renovate tracks the release-tagged hk-config imports through the shared preset. The
typed Cloudflare compatibility date remains reviewed manually: the shared preset's date
managers cover Wrangler TOML/JSON, not this typed configuration. Regenerate and commit
the mise lockfiles whenever tool pins change.

Optimize for reliable behavior and maintainability, not a low dependency count.
An early implementation is not a reason to rebuild established infrastructure.
Check maintenance, security response, license, compatibility, bundle/runtime cost
and the maintenance work displaced. Popularity is supporting evidence, not a
quality guarantee. Prereleases are allowed when their required APIs and upgrade
costs are understood and the compatibility checks pass.

The owner approved React, Tailwind + Base UI + selected shadcn/ui components, TanStack
Form + Valibot, TanStack Query, XState, `@webext-core/messaging`, WXT storage,
Hono, Drizzle, AI SDK with Valibot, Vitest Browser Mode with `vitest-browser-react`,
`@axe-core/playwright`, Knip and fast-check on 2026-10-10. The owner delegated OTP/PSL
selection by maintenance and freshness; that review selected OTPAuth and tldts.
React, Tailwind/Base UI, the selected shadcn/ui Button, TanStack Form/Query,
browser component testing and axe are implemented for the settings UI. The remaining
approved choices enter with their owning features and compatibility checks; approval
does not claim that they are installed. The owner subsequently approved the official
OSS Bitwarden SDK for local cryptography with GPL compliance in
[ADR 0005](adr/0005-bitwarden-local-crypto.md). Further major additions or
replacements still require the owner's decision. On 2026-10-12 (14:31 UTC) the owner
chose i18next with react-i18next for the extension's UI text, so that the language can
be chosen in Pateat's settings rather than only following Chrome's
([comparison](research/2026-10-12-extension-ui-translation.md)).
On 2026-10-13 the owner chose to use `@webext-core/messaging` only for the messages
addressed to the background service worker; the background's sends to one document of a
tab, Ports and `window.postMessage` keep the browser APIs
([route map](research/2026-10-13-extension-message-routes.md)).
On 2026-10-13 the owner first chose temporal-polyfill-lite for dates and times; tried as
a ponyfill, it added about 18 kB gzip to each extension context's bundle. At 16:12 UTC
the same day the owner asked to enable the native Temporal where it can be enabled and
otherwise to use `Date` on the server and the native Temporal in the extension. The
extension uses Chrome's global `Temporal`, which first ships in Chrome 144; the
extension now requires Chrome 145 for `Map.prototype.getOrInsertComputed`. The service
keeps `Date`: workerd 1.20261006.1 does not expose Temporal, and no compatibility flag
enables it (its V8 `harmony_temporal` flag cannot be set for a deployed Worker). Lint
forbids the global `Temporal` in `services/` and in the packages the service imports. On
2026-10-18 at 08:39 UTC the owner wrote, about the dashboard's charts,
「あ、ライブラリは Recharts?いい感じの探して使ってほしい。新しくてメンテされるやつ」
("Oh, is the library Recharts? Find a good one and use it, a new one that is
maintained"), leaving the choice to the agent. In its reply (about 08:45 UTC) the agent
chose Recharts 3 (3.10.1, MIT), used through the shadcn/ui Base UI Chart component
copied in as owned code (`services/api/web/chart.tsx`), over TanStack Charts 1.x, which
reached 1.0 only on 2026-10-03, for maturity; uPlot and Observable Plot were the
smaller, non-React options of the dashboard proposal. The English rendering of the
owner's words and the choice itself are the agent's, not confirmed by the owner.
Recharts needs `react-is` as a peer. It is loaded with `React.lazy`, so only the
dashboard downloads it (about 110 kB gzip). The current manifests and lockfile describe
what is installed. WXT + TypeScript + Valibot remain confirmed choices; existing Vitest,
Playwright and build tools remain in use. WXT drives Vite 8 (Rolldown) for the extension
build
([what each layer does](research/2026-10-12-wxt-build-pipeline.md)).

| Area | Choice and integration status | Owning slice |
| --- | --- | --- |
| Extension UI | **Implemented:** React through `@wxt-dev/module-react`, Tailwind CSS through its Vite plugin, Base UI with the selected shadcn/ui Button | M2 settings UI migration |
| Service web UI | **Implemented for the devices page:** React, Tailwind through its Vite plugin, Base UI with the selected shadcn/ui Button and TanStack Query, built by Vite into Worker static assets; **approved:** TanStack Form | M4 owner web UI |
| Charts | **Chosen under delegated authority (2026-10-18) and implemented for the `/manage` dashboard:** Recharts 3 through the shadcn/ui Base UI Chart component, which sets series colors as custom properties on the chart's container because the page's Content Security Policy allows no inline stylesheet; loaded lazily; every chart repeated as a table | Phase 1 speed dashboard |
| Form state | **Implemented:** TanStack Form with Valibot through Standard Schema; options-page drafts subscribe through `useSelector`, re-exported by `@tanstack/react-form` | M2 settings validation, dirty drafts and field errors |
| Async UI state | **Implemented for settings:** TanStack Query for metadata reads and mutations | M2 extension-message queries; M4 sync integration |
| Attempt lifecycle | **Implemented:** XState for each login attempt (`loginAttemptMachine`), applied with its pure `transition()`; the runtime around it stays application code | M2 declarative executor |
| Transport | **Implemented for messages to the background:** `@webext-core/messaging` around validated contracts ([architecture](architecture.md#components-and-trust-boundaries)); the background's tab sends addressed by `documentId`, Ports and `window.postMessage` stay raw, because the library's tab send takes only a tab and frame and it carries no Ports | M2 message transport |
| Storage | **Implemented:** every Pateat record in `storage.local` and `storage.session` is read and written through WXT storage (`wxt/utils/storage`) with `getItem`/`getItems`/`setItem`/`setItems`/`removeItem`; `storage.local` is restricted to trusted contexts before any read or write (`apps/extension/src/storage.ts`); `defineItem` is not used because its definition reads the value once without a catch; no versioned migrations before release. In the extension's own code only `getBytesInUse` for diagnostics and the access-level call stay on `chrome.storage`. The vault cache, connection sessions and diagnostics log are in IndexedDB | M2 persistence integration |
| Destination matching | **Selected under delegated authority:** WHATWG URL plus tldts for public/private suffix information | M3 URI matching; M5 RP ID validation |
| Crypto and OTP | **Approved:** official OSS Bitwarden SDK for local crypto with GPL compliance; **selected under delegated authority:** OTPAuth | M3 Bitwarden adapter; strict format and browser compatibility gates |
| Service and database | **Approved; implemented for sync:** Hono with Valibot validation through Hono's official `@hono/standard-validator` (`sValidator`, approved and implemented on 2026-10-13; `services/api/src/validation.ts` wraps it so that a failed check answers with a fixed error code and never echoes the rejected input or Valibot issues) and Drizzle for D1, with drizzle-kit (part of the Drizzle approval) generating migrations | M4 enrollment, sync and schema |
| Inference transport | **Implemented offline:** AI SDK with `@ai-sdk/valibot` for generation and the SDK's experimental decision contract for finite choice; **approved:** `@ai-sdk/anthropic` for Claude generation ([ADR 0014](adr/0014-claude-generation-provider.md)); per-owner Workload Identity Federation with `hono/utils/jwt` signing, a Valibot-checked `fetch` exchange and `authToken`, no added dependency ([ADR 0015](adr/0015-per-owner-claude-credentials.md)) | M4 service route |
| Unit/runtime tests | Existing Vitest and Cloudflare Vitest plugin; **approved:** fast-check for policy/state invariants; **approved (2026-10-12) and implemented:** `@vitest/coverage-v8` for the CI coverage summary, merged with `@vitest/istanbul-lib-coverage`, a dependency of that provider ([test coverage](#test-coverage)) | M2 onward |
| Component tests | **Implemented:** Vitest Browser Mode with `vitest-browser-react` | M2 React migration |
| Integration/accessibility | Existing Playwright; **implemented for settings:** `@axe-core/playwright` | M2 settings and executor fixtures |
| Static checks | Existing Oxlint/Oxfmt and TypeScript with applicable React/JSX accessibility rules; **approved:** Knip | M2 React migration |
| UI icons | **Approved (2026-10-12); implemented for the diagnostics page and `/manage`:** `lucide-react`, imported per icon, in each workspace that uses it | Phase 1 UI polish |
| UI translation | **Approved (2026-10-12):** i18next with react-i18next, the language chosen in Pateat's settings; the manifest's `description` through a hand-written `_locales` file | Phase 3 Japanese for the extension |
| Byte encoding | **Approved (2026-10-13) and implemented:** the standard `Uint8Array` `toBase64()`, `fromBase64()` and `toHex()` and `RegExp.escape()`, no library; they need Chrome 140, and the extension's `minimum_chrome_version` is now 145 for `Map.prototype.getOrInsertComputed` (Temporal needs 144). `@scure/base` was the alternative that keeps older Chrome | Phase 1 |
| Identifiers | **Approved (2026-10-12) and implemented:** `uuid` for UUIDv7, since Web Crypto has only `randomUUID()` (v4) ([identifiers](architecture.md#identifiers)) | Phase 1 |
| IndexedDB access | **Approved (2026-10-13) and implemented:** `idb` (Jake Archibald, ISC), a promise wrapper over the native API with the same transaction semantics, replacing the hand-written request and transaction wrappers in the vault, provider-session and diagnostics stores; a transaction still awaits only its own requests, because any other await lets it auto-commit; `idb` opens only the global `indexedDB`, so tests stub that global | Phase 1 |
| DER signatures | **Approved (2026-10-13) and implemented:** `@noble/curves`, importing only the `DER` helper from `@noble/curves/abstract/der.js` (not `p256`), for the P1363/DER conversion of passkey assertion signatures; signing stays WebCrypto ([ADR 0007](adr/0007-existing-passkey-assertions.md)). Low value (about 50 lines removed): revert if bundle size matters | Phase 1 passkeys |
| CBOR decoding | **Approved (2026-10-13) and implemented:** `cbor2` reads the version from a Bitwarden signed security state after the SDK has verified it; Pateat no longer pre-checks COSE structure and relies on Worker termination when the SDK's initialization cannot parse its input ([vault adapter](architecture.md#vault-adapter)); `@pateat/bitwarden` declares `"sideEffects": false`, so only the crypto Worker bundles it | M3 Bitwarden adapter |
| Dates and times | **Approved (2026-10-13) and implemented:** the native `Temporal` in the extension (first shipped in Chrome 144; current minimum 145) for formatting, parsing and calendar arithmetic; the service keeps `Date`, because workerd (1.20261006.1) does not expose Temporal and has no compatibility flag for it; `temporal-polyfill-lite` was tried and dropped (bundle +18 kB gzip per context); stored times stay epoch milliseconds and the clock stays `Date.now()` ([times](architecture.md#times)) | Phase 1 |
| Server configuration | Existing cf with cloudflare.config.ts and Vite | Retain verified build path |

The extension and `/manage` require Chrome 145 for `Map.prototype.getOrInsertComputed`.
Promises settled from outside use `Promise.withResolvers()`, input grouping uses
`Map.groupBy()`, and maps that lazily create an entry use `getOrInsertComputed()` when
these make the existing behavior clearer. `Promise.withResolvers()` and `Map.groupBy()`
also run in the Worker. Narrower TypeScript projects add `ES2024.Promise`,
`ES2024.Collection` and `ESNext.Collection` as needed for the production code they
import. Collection predicates and maps consumed by a spread use Iterator Helpers instead
of copying the collection into an array. Callbacks that can change the collection keep
a snapshot; array results stay arrays. The narrower projects importing this code add
`ESNext.Iterator`, the Iterator Helpers lib in the pinned TypeScript.
The passkey relay, conditional login decision, login-account report lookup and
diagnostics install-type lookup use `Promise.try()` to turn synchronous throws and
promise rejections into the same failure path. These callbacks start immediately.
The completed login-runtime audit on 2026-10-14 also adopted `Promise.try()` for
`quietly`: it still resolves to `undefined` on either success or failure. Session
loading reaches its first `await` before restoring collections or calling badges, so
the earlier read does not observe partially initialized state; admission, choices,
tab removal and replacement still wait for that load. Session saves snapshot before
their first `await`, after each caller's saved mutations, and dispatch the storage
write before later badge/report callbacks. Starting a login batches clearing its
choice, binding its pick to the attempt and updating logout/fill markers into one
snapshot, rather than relying on a later microtask to see those mutations. Reentrant
tab cleanup writes the newer state after that snapshot; the attempt journal keeps
its separate serialized queue and cancellation/restart guards. Projects importing
these wrappers add `ES2025.Promise`, the corresponding lib in the pinned TypeScript.

### Integration conditions (pending candidates remain conditional)

React belongs in manually opened extension pages and the service's owner web UI.
Keep content scripts and the MV3 worker independent of UI rendering, and do not
introduce automatic page UI.
Base UI provides accessible primitives; shadcn/ui source becomes code we own and
must review for updates. Compile Tailwind locally. Keyboard/focus tests remain
necessary. The owner selected TanStack Form for typed composition and native
Standard Schema support after considering React Hook Form with its Valibot resolver.
Do not install a second form-state layer alongside it.

Form drafts, Query caches and authoritative settings have different lifetimes.
Keep dirty drafts separate from query refreshes, preserve revision conflicts,
and update the metadata cache after successful writes. Query caches must not contain
vault values, unlock material or provider secrets. Explicitly configure retry,
staleness and refetch behavior; a focus/reconnect event must never replay login
or silently discard an edit. The extension worker remains the settings authority.

Use XState for lifecycle machinery, but own the login semantics, permission
guards, attempt limits and reconciliation. Persist only allowlisted resumable
metadata. Restoring an invoked actor can restart its work: never restore directly
into a submit invocation. Resume through observation and outcome reconciliation.
Do not put secrets in machine context, events, snapshots, inspectors or logs.

The owner decided on 2026-10-12 to keep this split after comparing replacements
([research](research/2026-10-12-state-handling-libraries.md)). Durable workflow engines
such as Temporal or Cloudflare Workflows are not used for logins: they run on a server,
while login steps run in the extension with values that stay on the device, and they do
not take over resubmission safety. Effect is not adopted for the runtime's cancellation
checks. New per-tab or per-site state that has transitions is added the way the attempt
is: an XState machine in `packages/contracts`, applied with `transition()` without a
long-lived actor, and stored only as Valibot-validated metadata.

WXT helpers and typed messaging do not replace Valibot validation, browser-sender
authorization or tab/frame/document checks. Initialize trusted-only storage access
before any read or write can access sensitive settings. Preserve
single-writer revision checks, corruption handling and fail-closed policy;
storage helpers do not provide compare-and-swap by themselves.

Parse untrusted destinations with `URL.parse()` and explicitly handle its `null` result
with the caller's existing failure value. Relative inputs still require the same
explicit base; admission code retains its scheme, credential, exact-origin and hostname
checks in the same order. Keep `try` blocks around operations that can fail for reasons
beyond URL parsing, including the login runtime's domain matching. Pass the normalized
hostname to tldts and explicitly include private suffix rules where appropriate. PSL
information is not permission to fill or sign, and does not replace HTTPS, origin,
ancestor or Permissions Policy checks. OTPAuth covers standard OTP mechanics; test
Bitwarden Steam compatibility separately and do not advertise HOTP merely because
parsing supports it. Base64, base64url and hex use the standard `Uint8Array` methods;
strict decoding (`lastChunkHandling: "strict"`) still needs the input checked for
whitespace and, when unpadded, padded first. Evaluate `@noble/hashes` for actual
protocol gaps; CBOR is read with the approved `cbor2`, only from data the Bitwarden SDK
has already verified. Do not write crypto/CBOR primitives ourselves, assume all
primitives in a package are audited, or substitute a different KDF for Bitwarden
Argon2id.

Use the approved Hono and Drizzle for the first substantive service routes and
schema. Verify generated SQL/migrations, explicit owner predicates, conditional
revision writes and D1 batch behavior; an ORM does not supply authorization or
cross-request atomicity. Use Valibot at application boundaries, including the
chosen Hono/Drizzle integrations; transitive Zod does not change that decision.

AI SDK is transport/structured-output infrastructure, not an autonomous agent
loop. Keep generation and finite-choice contracts distinct; use a direct typed
provider adapter when that API is not represented faithfully by the SDK. Set
retry/timeout limits explicitly and account for every attempt. Disable raw
input/output/header telemetry and sanitize errors. No automatic model/provider
fallback is introduced by a library.

`packages/inference` passes configured model instances only; a model ID string would
resolve through the SDK's global default provider and is rejected. The finite-choice
role uses `experimental_decide` from the approved AI SDK (no added dependency or
provider); its contract may change in patch releases, so the
`ai` version stays exact and its tests guard answer validation. A Clef or Jev adapter
implements that `doDecide` contract or replaces it with a direct typed adapter if the
contract loses provider semantics. `createClaudeGenerationModel` passes the key
explicitly and pins the API host, so `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` in
the environment are never read by the adapter. `@ai-sdk/anthropic` stays exact and
version-matched to `ai`.

Use the approved fast-check for invariants such as stronger exclusions never expanding
eligibility and stale events never authorizing a new document. Where every state is
small enough to list, walk them all instead of sampling: the
`packages/contracts/src/*.orders-*.test.ts` files apply every event of a fixed set to
every state a small login attempt reaches, and CI runs them in the `Event orders` job
([CI](delivery.md#current-foundation-workflows)). Component tests
cover drafts, conflicts, validation and keyboard behavior; Playwright covers real
extension boundaries and lifecycle. Automated accessibility checks supplement
manual keyboard/focus inspection. Browser component tests do not establish
extension API or MV3 lifecycle behavior. Knip must understand WXT-generated entrypoints
before treating reported unused files as removable.

We continue to implement domain behavior independently, without copying feature
code from Fenko, auto-filler, Superfill, Boltwarden or bronzewarden. Extra global
state stores, routing systems or agent frameworks need a distinct responsibility
instead of duplicating tools the owner selects. Exact pins are established in each
implementation PR, with peer, MV3 CSP and bundled-output checks. See
[ADR 0004](adr/0004-library-composition.md) for the approved composition and its
sources.

The settings form owns its draft separately from the metadata query cache. Each edit is
saved as soon as it is made; there is no separate save button (owner decision,
2026-10-11, after a site default shown in the options page had never been saved). Saves
run one at a time, and an edit made while one runs is saved on top of its result. Each
saved change applies at once, so it also cancels logins and passkey requests started
under the previous settings. Queries never refetch on focus/reconnect and neither reads
nor saves automatically retry, apart from the one conflict retry below: after an invalid
draft the next change saves again, and after a blocking failure later edits stay in the
unsaved draft. Only an explicit successful reload replaces edits after a failed save or
revision conflict. The one exception is a conflict that only background work caused,
such as an automatic vault sync: the page applies its unsaved edits to the newest
revision and saves once more. Otherwise the conflict's status line names what wrote the
newer revisions
([ADR 0025](adr/0025-automatic-vault-sync.md#settings-saves-after-a-sync)). A failed or
ambiguous save retains the draft, and an unknown outcome blocks saving until reload. The
background worker remains the settings authority and validates both messages and
senders; the UI migration does not change storage permissions. Component tests use a
synthetic client; extension tests separately cover real runtime messaging and trusted
storage. Accessibility checks combine axe with keyboard/focus scenarios, not a full
compliance claim.

The Worker uses the pinned beta Cloudflare Vite plugin required by cf's typed
configuration and Build Output workflow. Its manifest declares that plugin
explicitly so cf can discover the build framework inside the workspace. Tests
use the Cloudflare Vitest plugin with test-local Miniflare options derived from
the production compatibility settings; no production Wrangler TOML/JSON exists.
The workspace uses TypeScript 7; the shared TypeScript preset accepts it from 3.0.1
(peer `^6.0.0 || ^7.0.0`).

Reference versions and compatibility findings live in
[dated research](research/2026-10-10-feasibility.md); exact implementation pins
belong in lockfiles/configuration. Dependency upgrades run the same behavioral
tests, especially injection timing and Workers test-runtime compatibility.
