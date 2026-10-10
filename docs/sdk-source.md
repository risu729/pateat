# Extension licensing and Corresponding Source

The extension and linked Pateat packages use GPL-3.0-only under
[the scoped license grant](../LICENSING.md). The official OSS SDK is used under
its GPLv3 option; the commercial package is not selected.

## Pinned upstream source

The published package is `@bitwarden/sdk-internal@0.2.0-main.1034`.
Both its npm `gitHead` and packaged `VERSION` identify
`7de8f13a14b56068167160f88d55231f916cf16a`.
The package contains generated JavaScript, WASM and declarations; it is not the
preferred Rust source for modifying the SDK.

- [Matching SDK source tree](https://github.com/bitwarden/sdk-internal/tree/7de8f13a14b56068167160f88d55231f916cf16a)
- [Matching source archive](https://github.com/bitwarden/sdk-internal/archive/7de8f13a14b56068167160f88d55231f916cf16a.tar.gz)
- [License selection](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/LICENSE)
  and
  [GPL text](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/LICENSE_GPL.txt)

Pateat integrates the unmodified OSS package through its own local cryptographic
boundary as of 2026-10-10. No Bitwarden endorsement or trademark grant is implied.

## Build and installation

For the Pateat revision accompanying an artifact, install the tools pinned in
`mise.toml` and `mise.lock`, then run `mise run install` and
`mise run build:extension`. The independent synthetic test variant is built by
`mise run build:probe`. See [development](development.md) for checks and the
installed-Chrome probe setup. Chrome's developer-mode Load unpacked action can
load the emitted extension directory; no private signing key is required to run
a modified unpacked copy.

To rebuild the SDK itself, start from the exact source commit above and follow its
[WASM README](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/crates/bitwarden-wasm-internal/README.md)
and
[build script](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/crates/bitwarden-wasm-internal/build.sh).
The pinned
[workflow](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/.github/workflows/build-wasm-internal.yml)
uses Node 20, Rust 1.98.0 with `rust-src` and the `wasm32-unknown-unknown` target, and
Binaryen's `wasm-opt` and `wasm2js`. Run `npm ci` in
`crates/bitwarden-wasm-internal/npm`, then the crate's `build.sh -r` without the
commercial `-b` option. Preserve `Cargo.lock`, interfaces, build scripts and required
dependency source. The OSS path enforces `bitwarden_ensure_non_commercial`.

These are the upstream build instructions. Pateat has not verified a
byte-identical rebuild of the published SDK WASM; the inspected workflow does
not pin Binaryen. Do not describe package version/source mapping as a
reproducible-build result.

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
