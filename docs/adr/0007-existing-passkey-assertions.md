# ADR 0007: Assert existing passkeys through a fail-open bridge

Status: proposed for M5. The bridge topology, admission rules and assertion format
are within the accepted [ADR 0001](0001-local-login-boundary.md) scope and may be
implemented. Unattended presence without a user gesture is an open owner decision.

Date: 2026-10-10

## Context

[ADR 0001](0001-local-login-boundary.md) puts existing zero-counter software
passkeys in initial scope, subject to truthful UV/UP and interoperability gates.
The [architecture](../architecture.md#existing-passkeys) requires a document-start
MAIN-world bridge and native admission checks. The
[dated research](../research/2026-10-10-passkeys.md) records the WebAuthn
requirements, pinned Bitwarden behavior and the SDK surface this design relies on.

## Decision

### Bridge topology

Register a MAIN-world wrapper for `navigator.credentials.get` at document start in
top-level frames only. It snapshots the request, forwards a bounded copy to the
isolated content script, and either returns a Pateat assertion or calls the
browser's original `get` with the original arguments. Delegation is the default
for every case Pateat does not claim, so excluded or unsupported requests keep
ordinary browser behavior, including other installed passkey providers.
`navigator.credentials.create` is not wrapped.

The page and MAIN world are untrusted. The isolated script independently checks
`window.top === window`, `isSecureContext`, the
`publickey-credentials-get` permissions policy and transient user activation
before relaying. The background derives origin, tab, frame and document from the
browser-supplied sender, never from page data, and accepts only frame 0 of an
`https:` origin or `http://localhost`. Each request has a short-lived operation
ID bound to that document. Abort, timeout, navigation, policy change, lock and
connection replacement cancel it; a late result is discarded.

The background selects the credential and builds client data. Signing runs in the
crypto host Worker that owns the decrypted vault session, so the private key is
imported as a non-extractable WebCrypto key there and never crosses a message
boundary. Only the assertion fields return to the page.

### Admission

Pateat claims a request only when all of these hold; otherwise it delegates:

- `publicKey` is the only credential type requested and mediation is absent or
  `optional`. Conditional, silent and immediate mediation delegate.
- The caller is a top-level document, so `crossOrigin` is false and `topOrigin`
  is absent. Cross-origin frames, opaque
  origins and related origin requests delegate.
- The effective domain is a valid domain, not an IP address. An explicit RP ID is
  already in canonical lowercase ASCII form and is equal to, or a registrable
  domain suffix of, the effective domain according to tldts with private
  suffixes. A trailing dot is significant.
- The challenge is 16 to 1,024 bytes; at most 64 allowed credentials are given;
  `userVerification` is not `required`.
- The site is not excluded, an exact-origin account default selects one item,
  and that item yields exactly one eligible credential.

Unknown extensions are ignored as the client algorithm permits; client extension
results are empty. PRF, large blob, AppID and hints are not interpreted.

### Credential eligibility and assertion

Map Bitwarden `fido2Credentials` in the Bitwarden package into a strict local
form: `public-key`, `ECDSA`, `P-256`, a non-empty PKCS #8 key, a GUID or
`b64.`-prefixed credential ID, a base64url user handle, `discoverable` of `true`
or `false`, and a decimal counter. The credential's RP ID must equal the request
RP ID exactly. With an allow list, its ID must be listed; without one, it must be
discoverable and have a user handle. A nonzero counter is reported as
`unsupported-counter` and never signed, because an assertion would require a
counter write to the vault. Zero counters stay zero.

Serialize `clientDataJSON` exactly as WebAuthn specifies, from the sender origin
and the request challenge. Authenticator data is the SHA-256 RP ID hash, flags,
and a zero counter, without attested data or extensions. Set BE and BS, matching
the synced credential registered by Bitwarden. Sign authenticator data followed
by the client data hash with ECDSA P-256 SHA-256 and return the DER signature.
Return the credential ID bytes, `authenticatorAttachment` `platform`, and the
stored user handle when present. Response objects mimic the native prototypes and
`toJSON` output.

### Presence and verification

UV stays clear. Pateat performs no user verification during the ceremony, and
automatic vault unlock is not verification. Requests requiring UV delegate.
Sites whose servers require UV for `preferred` requests will reject the
assertion; that is reported as a site rejection, not retried with another method.

Initial UP policy is activation-backed. Pateat sets UP only when the isolated
script observes transient user activation for the requesting document, the
owner has preconfigured that origin's account, and selection is unambiguous.
The trusted gesture that started the sign-in, combined with the standing
credential choice, is the authorization gesture; synthetic executor clicks create
no activation. Requests without activation, such as calls on page load, delegate
to the browser. This is a Pateat interpretation: the gesture is not a prompt
naming the credential.

Proposed for owner decision, not implemented: an opt-in unattended mode that sets
UP from the per-site standing authorization alone. It would complete page-load and
executor-triggered requests, but it does not satisfy the specification's
per-ceremony gesture. If approved, it must be a separate per-site setting that
existing sites do not inherit and must report its status in settings.

## Alternatives

- Always set UP and UV: unattended, but spoofs verification and violates ADR 0001.
- Drive or depend on the official Bitwarden extension: inherits its prompts and
  focus requirements and is not an independent adapter.
- Use an SDK authenticator: the pinned WASM exposes none.
- Add an ECDSA or CBOR library: WebCrypto already provides ECDSA P-256 and SHA-256.
  Assertions need no CBOR, and the DER signature wrapper is a fixed structure
  tested against the WebAuthn vectors. No dependency is added.
- Show a Pateat chooser or prompt: conflicts with the no-page-UI rule until an
  explicit later UI design exists.

## Consequences and verification

Pateat never blocks a WebAuthn request it does not claim, so failures surface as
the browser's ordinary passkey UI. Unattended page-load passkey login is
unavailable until the open decision is made. Registration, nonzero-counter
writeback, conditional mediation, cross-origin frames, related origins and
extensions remain later work.

Verify with the WebAuthn Level 3 ES256 vectors, HTML registrable-suffix cases,
credential mapping vectors, signature verification by an independent verifier,
and probe-build browser tests covering activation, delegation, abort, timeout,
navigation and a synthetic relying party. Real-site interoperability and
coexistence with the official Bitwarden extension are separate gates.
