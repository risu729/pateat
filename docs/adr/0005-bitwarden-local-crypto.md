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

## Local authorization-hash composition

The pinned SDK exposes primary KDF derivation but its public PBKDF2 helper
rejects fewer than 5,000 iterations. The protocol's server-authorization hash
requires a separate one-iteration PBKDF2 step. The high-level SDK login helper
also performs HTTP and therefore crosses this decision's local-only boundary.

Use the SDK for the primary KDF, then the existing browser-native WebCrypto
PBKDF2-SHA256 operation for that single protocol step. This adds no cryptographic
primitive implementation, dependency or Rust binding. Match the pinned protocol
using independent upstream PBKDF2/Argon2id known answers, and keep authentication
KDF/salt separate from vault-unlock data. The resulting hash is an authentication
credential and remains within the trusted local authentication path.

## Background cryptographic host

Use a packaged offscreen document with Chrome's `WORKERS` reason to own the
Dedicated Workers that load the approved native SDK. The existing synthetic
browser probe demonstrated native WASM execution and termination of a computing
Worker. The Worker constructor is not exposed to service workers, so the MV3
background cannot construct that host directly. This uses existing browser
facilities and does not add a framework or native helper.

The offscreen document initiates a private runtime Port. Only the background
registers the reserved channel listener and it validates the browser-reported
sender against the actual offscreen document context. Do not broadcast secret
requests through runtime messages. Expose fixed cryptographic operations, never
generic SDK dispatch. A new background incarnation replaces any previous
offscreen host; disconnect, cancellation and deadlines fence results and
terminate affected Workers. Reconnection must not replay secret operations.

This host is a prerequisite for persistent unlock, not its implementation.
Durable cache acceptance, verified key retention and fresh operation grants
after restoration remain separate integration gates. The browser tests must
verify actual sender identity and restart behavior before the host is accepted.

## Sources

- [Chrome offscreen documents and WORKERS reason](https://developer.chrome.com/docs/extensions/reference/api/offscreen).
- [Worker constructor exposure](https://html.spec.whatwg.org/multipage/workers.html#the-worker-interface).
- [Pinned SDK license selection](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/LICENSE)
  and
  [GPLv3](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/LICENSE_GPL.txt).
- [Published package metadata](https://registry.npmjs.org/@bitwarden/sdk-internal/0.2.0-main.1034)
  and
  [internal-package support notice](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/crates/bitwarden-wasm-internal/npm/README.md).
- [Server-authorization hash and independent test vectors](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/crates/bitwarden-crypto/src/keys/master_key.rs)
  and
  [public KDF resource validation](https://github.com/bitwarden/sdk-internal/blob/7de8f13a14b56068167160f88d55231f916cf16a/crates/bitwarden-crypto/src/keys/kdf.rs).

Implementation status and the full acceptance scope remain in [the plan](../plan.md).
