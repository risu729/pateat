# Package manager: aube, pnpm or Bun

Researched: 2026-10-12, from aube's, Bun's, pnpm's and Renovate's documentation, the npm
registry, and trial installs of the repository at `e3acb8c` (main) in a cloud container.
The owner asked whether to migrate from Bun to aube because Bun does not support a
monorepo the way pnpm does. Nothing in the repository was changed; the recommendation
below was a proposal. The owner chose aube on 2026-10-12 at 08:25 UTC; see
[ADR 0032](../adr/0032-aube-package-manager.md).

## What Pateat uses from its package manager

- One root `package.json` with `workspaces: ["apps/*", "packages/*", "services/*"]` and
  five workspace packages (`@pateat/extension`, `@pateat/api`, `@pateat/bitwarden`,
  `@pateat/contracts`, `@pateat/inference`) linked with `workspace:*`.
- Shared build and test tools (Vitest, WXT, Vite, Playwright, cf, miniflare) as root
  `devDependencies`; each package lists its own runtime dependencies.
- One `bun.lock` (`lockfileVersion: 2`, `configVersion: 1`) installed with
  `bun install --frozen-lockfile` in `mise run install`, `ci.yml` and
  `deploy-server.yml`. Bun 1.4.3 already lays out `node_modules` isolated
  (`node_modules/.bun/<package>@<version>+<hash>`), like pnpm.
- `bunfig.toml` sets `exact = true`; versions are exact pins.
- No package scripts: tasks are mise tasks, and `mise run --affected` selects
  packages from the workspace graph. So `--filter`, recursive runs and catalogs are
  not used today.
- Bun as a runtime in two tasks of `packages/inference/mise.toml`
  (`bun ../../scripts/inference-benchmark.ts`,
  `bun ../../scripts/formasaurus/import.ts`, which calls `Bun.build`), and
  `scripts/check-sdk-source.mjs` reads `bun.lock`.
- Renovate (`.github/renovate.json`) updates `bun.lock` through its Bun manager.

## Monorepo features compared

| Feature | Bun 1.4.3 | pnpm 12.11.2 | aube 2.7.0 |
| --- | --- | --- | --- |
| Workspaces | `workspaces` in `package.json` | `pnpm-workspace.yaml` | reads `pnpm-workspace.yaml`, or `aube-workspace.yaml`; installs Pateat's `package.json` workspaces as they are |
| `workspace:` protocol | yes, rewritten on publish | yes | yes |
| Catalogs (`catalog:`) | yes, in root `package.json` | yes | yes ("workspace packages, filters, and catalogs") |
| Filter by name, path, negation | yes | yes | yes |
| Graph filters (`foo...`, `...foo`, `^`) | yes | yes | yes |
| Changed-since filter (`[origin/main]`) | not documented | yes | yes |
| Scripts in dependency order | yes (`bun --filter '*' build`) | yes (`pnpm -r`) | yes (`aube -r`) |
| Isolated `node_modules` | yes, already used here | yes (default) | yes (default), plus a shared store across projects |
| `deploy` of one package | no | yes | yes (`aube deploy`) |
| Dependency build approval | `trustedDependencies` plus a default trust list | `allowBuilds` (install fails on unapproved builds) | `allowBuilds`, reads Bun's `trustedDependencies`, built-in trust list, optional jail |
| Lockfile | `bun.lock` | `pnpm-lock.yaml` | reads and writes `bun.lock` (text v1-v3), `pnpm-lock.yaml` v9, npm and Yarn lockfiles; new projects get `aube-lock.yaml` |

Sources: [Bun workspaces](https://bun.com/docs/pm/workspaces),
[Bun `--filter`](https://bun.com/docs/pm/filter),
[aube README](https://github.com/aubepkg/aube),
[aube for pnpm users](https://aube.sh/pnpm-users),
[aube for Bun users](https://aube.sh/bun-users),
[aube lockfiles](https://aube.sh/package-manager/lockfiles),
[aube CLI](https://aube.sh/cli/).

For what Pateat does today, Bun 1.4.3 already covers the monorepo features in the table
except `deploy` and a changed-since filter, and mise's `--affected` already provides
changed-package selection for tasks.

## aube's maturity

- A Node.js package manager written in Rust by jdx, who also maintains mise and hk;
  MIT; repository [aubepkg/aube](https://github.com/aubepkg/aube) (about 2.0k stars,
  68 forks, 1,455 commits on `main` on 2026-10-12).
- First npm release `1.0.0-beta.2` on 2026-04-18, `1.0.0` on 2026-04-23, `2.0.1` on
  2026-08-23, `2.7.0` on 2026-10-07: 73 versions in under six months. `@endevco/aube`
  had 6,390 npm downloads in the week of 2026-10-04 to 2026-10-10 (it is also
  installed through Homebrew, mise and cargo), against 220,637,250 for `pnpm`.
- pnpm 12.0.0 was released on 2026-08-26 and 12.11.2 on 2026-10-09; Bun 1.4.3 on
  2026-10-10.
- Its own benchmark: warm install 0.34 s against pnpm 0.69 s and Bun 0.79 s
  ([aube.sh](https://aube.sh/)). In the trial below, the frozen install into an empty
  `node_modules` took 9 s for aube and 33 s for Bun, both on cold caches; that is one
  run each, not a benchmark.
- It turns on its global virtual store locally and off in CI, and checks release age
  (24 hours) and known malicious packages when it picks versions.

## Tooling support

| Tool | Bun | pnpm | aube |
| --- | --- | --- | --- |
| mise 2026.10.8: install the tool | `bun` (current) | `pnpm` (aqua, npm) | `aube` (packslip, aqua, GitHub, cargo) |
| mise 2026.10.8: installer for mise's `npm:` tools (`npm.package_manager`) | `"bun"` (current) | `"pnpm"` | `"aube"` or `"aube_cli"` |
| Renovate | Bun manager updates `bun.lock` | npm manager updates `pnpm-lock.yaml` | no manager for `aube-lock.yaml`; keeping `bun.lock` or `pnpm-lock.yaml` leaves the update to Bun or pnpm |
| Running TypeScript scripts | yes (two inference tasks) | no; Bun stays a mise tool for the two scripts, or they are ported to Node 26 (replacing `Bun.build` in the Formasaurus import) | same as pnpm |

The Renovate row is from
[the npm manager page](https://docs.renovatebot.com/modules/manager/npm/), which lists
only `package-lock.json`, `pnpm-lock.yaml` and `yarn.lock`, and from the absence of aube
in Renovate's documentation on 2026-10-12.

## Trial installs

These are observations from single runs in one container; only the task output was kept
as logs. Each tool installed a copy of `e3acb8c` in the cloud container, then the same
mise tasks ran: every `typecheck`, `//apps/extension:test`, the `test` task of each
package, the three `//services/api:check:*` tasks and `test:tools` (`check:sdk-source`
too for Bun and aube; it reads `bun.lock`). The browser suites (Vitest Browser Mode and
Playwright; about 353 tests in
[the test inventory](2026-10-12-test-pruning-skills.md#pateats-test-suite-today)) could
not run in any of the three: Playwright 1.64 wants Chromium build 1248 and the container
has 1194, so `//apps/extension:test:dom` failed the same way everywhere and the others
were not run. Hooks in `hk check` were not run.

| | Bun 1.4.3 | aube 2.7.0 | pnpm 12.11.2 |
| --- | --- | --- | --- |
| Install | `bun install --frozen-lockfile` | `aube install --frozen-lockfile` on the same `bun.lock`, file unchanged | `pnpm install` from scratch (no `bun.lock` import), new `pnpm-workspace.yaml`; failed until `allowBuilds` approved `esbuild` and `workerd`; the file also gained `minimumReleaseAgeExclude: ['@risu729/tsconfigs@3.0.1']`, a version published 2026-10-11 09:21 UTC, under pnpm's one-day default release age |
| Vitest Node unit and service tests (3,134) plus `test:tools` (6) | pass | pass | pass |
| Typecheck | pass | `tests/manage` (82 errors) and `tests/options` (198 errors) fail with `TS2339: Property 'element' does not exist on type 'ExpectStatic'` | pass |
| Server build and checks | pass | pass | pass |

The aube typecheck failure comes from peer resolution, not from the store. aube linked
the root `vitest` without the optional peer `@vitest/ui`, while `@vitest/browser`'s
`vitest` has it. TypeScript 7 keys a package's identity by name, version and the
versions of its installed peers, so it loaded two copies of `vitest`'s types and
`@vitest/browser`'s `declare module 'vitest'` (which adds `expect.element`) augmented
the other copy. Bun and pnpm gave every `vitest` the same peers. Disabling aube's global
virtual store did not change it; adding `@vitest/ui` 5.0.3 to the root `devDependencies`
did (0 errors).

That `aube add` rewrote `bun.lock` with 295 lines added and 350 removed: aube writes
resolved peers into each package's `dependencies` and adds nested entries such as
`@aklinker1/rollup-plugin-visualizer/picomatch`. Bun 1.4.3 accepted the rewritten file
with `--frozen-lockfile` and `bun install` left it unchanged, so the two can share one
`bun.lock`, but the first aube write produces a large one-off diff. Found later the
same day: aube's own `--frozen-lockfile` refused that rewritten file, because it drops
the `@pateat/*` workspace entries (see
[ADR 0032](../adr/0032-aube-package-manager.md)).

## Recommendation

Stay on Bun for now (proposal, not decided):

- Bun 1.4.3 already supports the monorepo features Pateat uses or would plausibly use
  (workspaces, `workspace:`, catalogs, graph filters, ordered runs, isolated layout).
  The gaps against pnpm are `deploy`, which Pateat does not use, and a changed-since
  filter, which mise's `--affected` partly covers for tasks (it compares with `HEAD~1`
  and never selects `tests/*`).
- aube works on this repository with one fix, can keep `bun.lock`, and mise can install
  it. But it is six months old, it has one listed npm maintainer (jdx), Renovate has no
  manager for its own lockfile, and the gain for Pateat today is install speed.
- If a pnpm-only feature is needed, pnpm 12 is the established option: it passed the
  same checks as Bun, and Renovate and mise support it. Moving to it means a new
  `pnpm-lock.yaml`, `pnpm-workspace.yaml` with `allowBuilds` and release-age
  exclusions that match Renovate's update timing, the three install commands,
  `check-sdk-source.mjs`, and either keeping Bun as a mise tool for the two inference
  scripts or porting them to Node. Whether `mise run --affected` reads
  `pnpm-workspace.yaml` was not checked.
- aube is worth revisiting when Renovate supports it or when a feature it has (such as
  the build jail or release-age check) is wanted.
