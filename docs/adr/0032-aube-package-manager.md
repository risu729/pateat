# ADR 0032: aube installs the workspace dependencies

Status: accepted by the owner on 2026-10-12 (08:25 to 08:27 UTC). Supersedes the Bun
package-manager part of [ADR 0002](0002-toolchain.md); Bun stays a mise tool for the two
scripts that run on it.

Date: 2026-10-12

## Context

The owner asked whether to move from Bun to aube for pnpm-like monorepo support
([research note](../research/2026-10-12-package-manager-aube.md)). The note found that
Bun 1.4.3 covers the workspace features Pateat uses and proposed staying on Bun. The
owner chose aube anyway (08:25 UTC): its maintainer, jdx, also maintains mise and hk,
and it is stricter about security (08:26 UTC). The owner asked to unset mise's
`npm.package_manager` so that mise uses aube, to add `@vitest/ui`, to use aube features
where they fit, and, because Renovate has no aube manager, to keep a lockfile Renovate
can update, preferring `pnpm-lock.yaml` over Bun's or npm's.

## Decision

- **aube 2.7.0 installs the dependencies.** It is a mise tool, `aqua:aubepkg/aube`.
  mise's default `packslip` backend for aube also installs aube's agent skill through
  the GitHub API, and that install fails where the API is restricted (cloud sessions on
  2026-10-12), so the aqua backend, which checks the GitHub release attestation, is
  used. `mise run install` runs `aube install --frozen-lockfile`; CI and the deployment
  run `aube ci` (a clean frozen install).
- **mise installs its `npm:` tools with aube.** `[settings.npm] package_manager` is
  gone from `mise.toml`, so mise picks aube, and `mise lock` writes an aube lockfile per
  tool under `.mise/locks/` (oxlint, TypeScript, oxfmt), referenced from `mise.lock`.
- **The lockfile stays `bun.lock`, and Bun writes it.** aube installs from it, and
  Renovate's Bun manager keeps updating it. Add, remove or update a dependency with
  `bun add --exact`, `bun remove` or `bun update`, then `mise run install`; do not let
  aube write the lockfile. On 2026-10-12, aube 2.7.0 had a workspace bug in both
  formats it could share with Renovate:
  - In `bun.lock` it dropped the `@pateat/*` entries of `packages` (such as
    `"@pateat/bitwarden": ["@pateat/bitwarden@workspace:packages/bitwarden"]`), and its
    own `aube install --frozen-lockfile` then refused the file ("lockfile is out of date
    with package.json: apps/extension: manifest adds @pateat/bitwarden@workspace:*"),
    although Bun 1.4.3 accepted it.
  - In `pnpm-lock.yaml` it wrote workspace dependencies as `version: 0.1.0` where pnpm
    writes `link:../contracts`, and pnpm 12.11.2 refused that file ("Broken lockfile: no
    entry for '@pateat/contracts@0.1.0'") with and without `--frozen-lockfile`, so
    Renovate's pnpm could not update it.

  `aube-lock.yaml` waits for Renovate's aube manager
  ([renovatebot/renovate#44428](https://github.com/renovatebot/renovate/pull/44428),
  open on 2026-10-12).
- **aube settings live in `aube-workspace.yaml`.** Once that file exists aube reads the
  workspace packages from it, so it repeats the `workspaces` globs of `package.json`,
  which Bun and Renovate read; a frozen install fails when the two differ. It sets:
  - `paranoid: true`: no trust-evidence downgrades, dependency build scripts in aube's
    jail (Landlock and seccomp on Linux, Seatbelt on macOS; on Windows only a scrubbed
    environment and temporary `HOME`), a hard 24-hour minimum release age, required
    store integrity, a failure on unreviewed build scripts, and a fail-closed OSV
    malicious-package check on new resolutions.
  - `allowBuilds`: only `esbuild` and `workerd` may run install scripts.
  - `advisoryBloomCheck: "on"`: plain lockfile installs are also checked against the
    OSV malicious-package list.
  - `savePrefix: ""`: `aube add` writes exact versions, as `bunfig.toml`'s
    `exact = true` does for `bun add`, for when aube writes the lockfile.
- **`@vitest/ui` 5.0.3 is a root devDependency.** Without it aube links the root
  `vitest` without that optional peer while `@vitest/browser`'s `vitest` has it, and
  TypeScript 7 then loads two copies of the Vitest types, so `expect.element` is missing
  in `tests/manage` and `tests/options`.

## Consequences

- Bun stays a mise tool: it writes `bun.lock` and runs the two inference scripts.
- aube's 24-hour release age and OSV checks apply when aube resolves versions, which
  it does not do while Bun writes the lockfile; `advisoryBloomCheck` still checks every
  install. Renovate waits three days for npm updates (`security:minimumReleaseAgeNpm` in
  `config:best-practices`).
- Move dependency changes to `aube add` once aube writes a `bun.lock` its own frozen
  install accepts, and to `pnpm-lock.yaml` or `aube-lock.yaml` once pnpm reads aube's
  file or Renovate supports `aube-lock.yaml`.
