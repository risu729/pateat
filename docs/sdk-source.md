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
