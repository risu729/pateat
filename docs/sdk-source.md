# Extension licensing and Corresponding Source

The extension and linked Pateat packages use GPL-3.0-only under
[the scoped license grant](../LICENSING.md). The official OSS SDK is used under
its GPLv3 option; the commercial package is not selected.

## Pinned upstream source

The exact npm version is pinned in `packages/bitwarden/package.json` and
`bun.lock`. The installed package's `VERSION` identifies the matching upstream
source commit. The package contains generated JavaScript, WASM and declarations;
it is not the preferred Rust source for modifying the SDK.

Both production and probe builds render `THIRD-PARTY-NOTICES.md` and `legal.html`
from the installed SDK's version and `VERSION`, including links to the exact source
archive, license selection and upstream build instructions. Their tracked files in
`apps/extension/public/` are templates; use the rendered files in the built extension
for those links. A stale install or a manifest/lock mismatch fails the build.

`mise run check:sdk-source`, part of `mise run check`, checks the same metadata and
renders the same notices without writing files. It prints the resolved npm version
and source commit. Normal Renovate SDK updates therefore update the notices through
the build; no separate documentation version or Renovate post-upgrade command needs
maintenance. This removes duplicated version records, not the requirement to provide
matching source with a distributed binary.

Pateat integrates the unmodified OSS package through its own local cryptographic
boundary as of 2026-10-10. No Bitwarden endorsement or trademark grant is implied.

## Build and installation

For the Pateat revision accompanying an artifact, install the tools pinned in
`mise.toml` and `mise.lock`, then run `mise run install` and
`mise run //apps/extension:build`. The independent synthetic test variant is built by
`mise run //apps/extension:build:probe`. See [development](development.md) for checks
and the installed-Chrome probe setup. Chrome's developer-mode Load unpacked action can
load the emitted extension directory; no private signing key is required to run a
modified unpacked copy.

To rebuild the SDK itself, use the exact upstream source commit printed by
`mise run check:sdk-source` (also recorded in the built notices). At that commit,
follow `crates/bitwarden-wasm-internal/README.md`, its `build.sh`,
`rust-toolchain.toml` and `.github/workflows/build-wasm-internal.yml` in the
[SDK repository](https://github.com/bitwarden/sdk-internal). Those files own the
tool requirements and WASM build recipe; do not substitute the tool versions or
build instructions from upstream's current branch.
Select the OSS build without the commercial `-b` option. Preserve `Cargo.lock`,
interfaces, build scripts and required dependency source.

Pateat loads the packaged native WASM in its extension Worker, without the
JavaScript fallback. Pateat has not verified a byte-identical rebuild of the
published SDK WASM. Do not describe package version/source mapping or generated
notices as a reproducible-build result.

## Binary distribution gate

Before conveying an extension ZIP, place its exact Pateat source revision and
matching SDK/dependency source with equivalent access directly beside the
binary. Include build/install scripts, configuration, lockfiles, interfaces,
copyright notices and license texts. A source archive may exclude unrelated
service code and unmodified general-purpose build tools, but must retain all
non-system source needed to build, install, run and modify the extension.

Verify the download links and contents for that artifact. Keep source available
for as long as the chosen GPL distribution method requires. A mutable homepage,
a compiled npm tarball, or a notice promising future source does not satisfy
this gate. Public extension publishing remains outside the initial delivery
scope; local build checks do not establish public distribution compliance.

### Release archives

The [extension release workflow](delivery.md#extension-releases) packs each release's
source beside its ZIP on the same draft GitHub Release:

- Exact Pateat revision: `pateat-<version>-source.tar.gz` is `git archive` of the
  revision the ZIP was built from, in the same job from a clean checkout. It holds the
  build and install tasks (`mise.toml`, `tasks.toml`, each project's `mise.toml`), the
  tool and dependency lockfiles (`mise.lock`, `bun.lock`), configuration, interfaces,
  `LICENSING.md`, `LICENSE-GPL-3.0.txt` and the notice templates. It also holds the
  service code, which the gate allows but does not require.
- SDK source: `third-party-source/bitwarden-sdk-internal-<commit>.tar.gz`, upstream's
  archive at the commit the installed package's `VERSION` names, copied into the release
  rather than linked, so its availability does not depend on upstream.
- Dependency source: `third-party-source/npm/` holds the registry tarball of every
  third-party package the production build recorded as bundled (from its module graph
  and the license banners its stylesheets keep), each matching its `bun.lock`
  integrity, including the compiled `@bitwarden/sdk-internal` package and WXT's own
  run-time modules.
- Digests: `release.json` and `SHA256SUMS` record every file with its SHA-256, and
  `release.json` the workflow run that packed it.

Whether this meets the gate is not settled, so the release text calls the archive the
extension's source rather than its Corresponding Source. Still for a person to check or
decide before publishing (Claude's reading, pending the
owner's confirmation):

- The download links and contents of each draft, as the gate requires; the workflow
  checks digests and integrity hashes, not that the files open and build.
- Whether a registry tarball counts as source for a package that publishes only built
  JavaScript (for example `react-dom`); its repository at the matching tag would be the
  preferred form for modification. The gate above already rules out a compiled npm
  tarball as the SDK's source, which is why the SDK's upstream archive is included.
- The SDK's own Rust dependencies: the SDK archive has their `Cargo.lock`, but the
  crates are not vendored. Vendoring them would need a Rust toolchain, which `mise.toml`
  does not pin.
- Code the bundler adds itself (the Rolldown runtime, Vite's preload helper and
  WXT's virtual entry modules) is not recorded as a package; Claude treats it like the
  unmodified build tools that the gate lets the archive leave out.
- How long the published release must stay, under the chosen GPL distribution method.
