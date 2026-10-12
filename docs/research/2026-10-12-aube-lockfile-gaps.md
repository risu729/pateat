# aube lockfile gaps with Bun and pnpm

Researched: 2026-10-12, from aube's source and documentation, its GitHub pull requests
and discussions, and trial runs in a cloud container (Ubuntu 24.04.5, Linux x64). It
follows the two lockfile bugs found while moving to aube
([ADR 0032](../adr/0032-aube-package-manager.md),
[package manager research](2026-10-12-package-manager-aube.md)). The owner asked for bug
reports with minimal reproductions. Nothing had been filed upstream when this note was
written; whether to file is the owner's call. Nothing in Pateat's setup changes with it.
Bun 1.4.3 was npm's `latest`; gaps 1 and 3 gave the same results with the Bun canary
`1.4.3-canary.20261011.1` (it prints `1.4.4`).

Versions: aube 2.7.0 (release binary through mise `aqua:aubepkg/aube`), aube `main` at
[1443128](https://github.com/aubepkg/aube/commit/1443128) built with
`cargo build --release --locked -p aube` (it still prints `2.7.0`), Bun 1.4.3, pnpm
12.11.2.

## Summary

| Gap | aube 2.7.0 | aube main 1443128 | Upstream |
| --- | --- | --- | --- |
| 1. A `bun.lock` rewrite drops the workspace member entries, then aube's own frozen install fails | reproduces | fixed | [#1721](https://github.com/aubepkg/aube/pull/1721), [#1723](https://github.com/aubepkg/aube/pull/1723), [#1724](https://github.com/aubepkg/aube/pull/1724), merged after 2.7.0, unreleased |
| 2. `pnpm-lock.yaml` records `workspace:*` dependencies as a version, and pnpm refuses the file | reproduces | fixed; pnpm 12.11.2 accepts the file | reported in [discussion #1718](https://github.com/aubepkg/aube/discussions/1718), fixed by [#1719](https://github.com/aubepkg/aube/pull/1719), unreleased |
| 3. A `bun.lock` rewrite adds resolved peers to `dependencies`, and Bun later installs a second copy of the peer | reproduces | reproduces | no issue, discussion or PR found |
| 4. `aube update` and `aube install --lockfile-only` write `lockfileVersion: 2` back as `1` | reproduces | reproduces | no issue, discussion or PR found |

aube documents that it reads and writes `bun.lock` (text v1 to v3) and `pnpm-lock.yaml`
v9 in place ([lockfiles](https://aube.sh/package-manager/lockfiles)). It also says "the
original package manager can keep using the same file during rollout"
([troubleshooting](https://aube.sh/troubleshooting)). The
[aube for Bun users](https://aube.sh/bun-users) page says aube keeps `lockfileVersion`
`1` or `2`. All four gaps break one of those statements. Bug reports go to GitHub Issues
(aube README). The repository has no issue template, and the troubleshooting page asks
for the command, the first error, the error code, the versions, the OS and a minimal
reproduction.

## Reproductions

Each one runs in a new `mktemp -d` directory. Every result below was run, not inferred,
unless marked otherwise.

### 1 and 2: workspace dependency

```sh
members() {
  mkdir -p packages/a packages/b
  echo '{ "name": "@repro/a", "version": "0.1.0" }' > packages/a/package.json
  echo '{ "name": "@repro/b", "version": "0.1.0", "dependencies": { "@repro/a": "workspace:*" } }' > packages/b/package.json
}
# Gap 1 (bun.lock)
cd "$(mktemp -d)" && members
echo '{ "name": "repro", "private": true, "workspaces": ["packages/*"] }' > package.json
bun install
(cd packages/b && aube add ms@2.1.3)
aube install --frozen-lockfile
# Gap 2 (pnpm-lock.yaml)
cd "$(mktemp -d)" && members
echo '{ "name": "repro", "private": true }' > package.json
printf 'packages:\n  - "packages/*"\n' > pnpm-workspace.yaml
pnpm install
(cd packages/b && aube add ms@2.1.3)
pnpm install --frozen-lockfile
```

On aube 2.7.0, gap 1 removes `"@repro/a": ["@repro/a@workspace:packages/a"]` and the
`@repro/b` line from `packages`. The frozen install then exits 1 with
`lockfile is out of date with package.json: packages/b: manifest adds @repro/a@workspace:*`.
`bun install --frozen-lockfile` still exits 0. Gap 2 changes `version: link:../a` to
`version: 0.1.0`. pnpm then exits 1 with `ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`
(`Broken lockfile: no entry for '@repro/a@0.1.0' in pnpm-lock.yaml`), with or without
`--frozen-lockfile`. On main 1443128 both lockfiles keep their workspace entries, and
every frozen install exits 0.

The #1719 description says that fix was checked with a frozen aube install but "I did
not run pnpm against the output". The pnpm 12.11.2 run above is that check.

### 3 and 4: peers and `lockfileVersion`

```sh
echo '{ "name": "repro", "private": true, "dependencies": { "react": "19.2.0", "react-dom": "19.2.0" } }' > package.json
bun install
aube update scheduler   # any aube write; scheduler is transitive and stays 0.27.0
bun add react@19.2.1    # later, someone bumps React with Bun
```

After `aube update scheduler` (on 2.7.0 and on main), the `bun.lock` entry for react-dom
gains its resolved peer:

```diff
-"react-dom": ["react-dom@19.2.0", "", { "dependencies": { "scheduler": "^0.27.0" }, "peerDependencies": { "react": "^19.2.0" } }, "sha512-…"],
+"react-dom": ["react-dom@19.2.0", "", { "dependencies": { "react": "19.2.0", "scheduler": "^0.27.0" }, "peerDependencies": { "react": "^19.2.0" } }, "sha512-…"],
```

Bun 1.4.3 accepts that file unchanged with `--frozen-lockfile` and treats the peer as an
exact dependency. After `bun add react@19.2.1`, the file has
`"react-dom/react": ["react@19.2.0", …]`, and
`node_modules/react-dom/node_modules/react` is React 19.2.0 next to the root's 19.2.1.
With Bun alone, the same steps leave one React 19.2.1. In aube's writer, the resolved
peer sits in `pkg.dependencies` with no declared range, so
`crates/aube-lockfile/src/bun/write.rs` (lines 285 to 297 at 1443128) writes the exact
version. `aube add` and `aube install --no-frozen-lockfile` add peers the same way.
`aube install` and `aube install --frozen-lockfile` do not write the file.

The same `aube update` also changes `"lockfileVersion": 2` (Bun 1.4's default) to `1`,
as does `aube install --lockfile-only --no-frozen-lockfile`. `aube add` and
`aube install --no-frozen-lockfile` keep `2`. Bun 1.4.3 reads the v1 file and does not
change it back, so gap 4 only causes lockfile churn.

## Effect on Pateat's bun.lock

On a copy of main at `c1ed121` (5 workspace members, 469 `packages` entries;
aube reported 460 resolved packages),
`aube install --lockfile-only --no-frozen-lockfile` gave:

- aube 2.7.0: all 5 `@workspace:` entries removed (gap 1)
- aube main 1443128: the 5 entries kept, and Bun 1.4.3 and aube both accept the result
  with `--frozen-lockfile`. The rewrite still added resolved peers to the `dependencies`
  of 36 entries (gap 3), for example `"zod": "4.6.5"` under `@ai-sdk/anthropic` and
  `react`, `react-dom` and `@types/react` under `@base-ui/react`. It also changed
  `lockfileVersion` to `1` (gap 4).
- Same rewrite, other changes with no install effect seen: `os` and `cpu` written as
  arrays where Bun writes a string (all 174 entries that have them, including 10
  `"os": "none"` values rewritten to `["netbsd"]` or `["openharmony"]`), `libc` added
  (34), `deprecated` added (2), one `bin` written as an object, and the 6 bundled
  entries under `@tailwindcss/oxide-wasm32-wasi/` dropped (469 to 463 entries). In total
  the diff added 314 lines and removed 326.

The setup in ADR 0032 (Bun writes `bun.lock`; aube only installs, with
`aube install --frozen-lockfile` or `aube ci`) is not affected by any of the four gaps
as long as aube does not write the file, which ADR 0032 rules out. ADR 0032 plans to
move dependency changes to `aube add` once aube writes a `bun.lock` its own frozen
install accepts, and to `pnpm-lock.yaml` once pnpm reads aube's file. On this evidence
(gaps 1 and 2), a release that includes 1443128 would meet both conditions. For
`bun.lock`, gap 3 would then add peers to the file on every `aube add`. Gap 3 concerns
`bun.lock` only and was not tested with `pnpm-lock.yaml`.
