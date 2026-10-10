# Third-party notices

## Official Bitwarden OSS SDK

The synthetic crypto probe bundles the unmodified GPL edition of
`@bitwarden/sdk-internal@0.2.0-main.1034`, source revision
`7de8f13a14b56068167160f88d55231f916cf16a`, by the Bitwarden SDK contributors.
Public synthetic vectors copied from that revision retain their source
attribution in `packages/bitwarden/src/__fixtures__/crypto.ts`.

Pateat's local wrapper and integration were added on 2026-10-10. Upstream does
not provide support for this internal package or endorse this integration.
No Bitwarden trademark rights are granted.

- [GPLv3 license text](LICENSE-GPL-3.0.txt)
- [Upstream license selection](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/LICENSE)
- [Matching source archive](https://github.com/bitwarden/sdk-internal/archive/7de8f13a14b56068167160f88d55231f916cf16a.tar.gz)
- [Upstream build instructions](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/crates/bitwarden-wasm-internal/README.md)

The compiled npm tarball does not replace the corresponding Rust source,
interfaces and build scripts. Distribution must provide equivalent access to
the matching complete source beside the extension binary.

## shadcn/ui Button

`apps/extension/src/options/button.tsx` adapts the selected Base UI Button from the
[shadcn/ui base-nova registry](https://ui.shadcn.com/r/styles/base-nova/button.json).
Only the variants used by Pateat are retained.

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
