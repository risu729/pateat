# ADR 0005: Use the official OSS SDK for local Bitwarden cryptography

Status: approved by the owner; implementation and compatibility verification in
progress.

Date: 2026-10-10

## Decision

Use the GPL edition of `@bitwarden/sdk-internal` for local cryptographic
operations behind Pateat-owned interfaces. The owner explicitly accepted GPL
compliance. This resolves the Bitwarden crypto choice left open in
[ADR 0004](0004-library-composition.md). It does not select the commercial SDK,
grant vault-write capabilities or authorize real-account operations.

Pin the published OSS package associated with the inspected official browser
release. The initial baseline is `0.2.0-main.1034`, with upstream source commit
`7de8f13a14b56068167160f88d55231f916cf16a`. Upstream labels this package internal
and unsupported; Pateat owns compatibility testing and updates.

Pateat continues to own provider HTTP, connection identity, input admission,
permissions, cache reconciliation and secret release. Expose only the local
operations needed for key derivation, account-key handling, verification and
strict decryption. Do not expose a generic SDK client to pages or invoke SDK
login, migration, backfill or server-write methods merely because they exist.
Keep SDK state isolated per connection and reject stale results after lock,
revocation or connection replacement.

Validate supported wire formats before invoking the SDK. A tolerant decryption
result, an empty field substituted after failure, or fallback from an invalid
blob to legacy fields must not become a usable credential. Verified account
state and known version semantics are separate from successful decryption.
Integration must cover both legacy and current account/item formats; a working
primitive or legacy vector does not complete M3.

Package the required WASM locally and test the emitted MV3 artifact. Measure
resource bounds and cancellation rather than assuming that an asynchronous API
makes synchronous WASM interruptible. Choose an extension worker host based on
those measurements; an offscreen page is not required merely by this decision.

Convey the combined extension under GPLv3 with appropriate notices, the license
text, and access to its complete Corresponding Source and build/install
instructions. Preserve upstream and other dependency notices. Distribution
checks must describe the actual packaged artifact and its source revisions.
The separate optional service does not become subject to the SDK license merely
because it resides in the same repository.

## Alternatives and consequences

Maintained cryptographic primitives remain a viable alternative, but Pateat
would also need to maintain Bitwarden's key, COSE, signature, blob and migration
protocol assembly. Native WebCrypto alone does not cover the inspected SDK's
algorithms. The official OSS SDK reduces that duplicate implementation while
adding GPL obligations, WASM size and coupling to an unstable internal API.

A narrowly scoped Rust/WASM binding is a possible response to a demonstrated
public-export gap. It is not an automatically adopted second build framework.
First establish the gap with the pinned package and the required acceptance
case. The public Secrets Manager API and CLI-backed vault API do not substitute
for this browser-local personal-vault integration.

## Sources

- [Pinned SDK license selection](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/LICENSE)
  and
  [GPLv3](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/LICENSE_GPL.txt).
- [Published package metadata](https://registry.npmjs.org/@bitwarden/sdk-internal/0.2.0-main.1034)
  and
  [internal-package support notice](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/crates/bitwarden-wasm-internal/npm/README.md).

Implementation status and the full acceptance scope remain in [the plan](../plan.md).
