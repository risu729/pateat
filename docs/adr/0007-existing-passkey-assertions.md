# ADR 0007: Assert existing passkeys through a fail-open bridge

Status: accepted for M5. On 2026-10-10 the owner chose to set UP and UV on every
claimed assertion without a user gesture, knowingly departing from the WebAuthn
ceremony; this amends the truthful UV/UP condition in
[ADR 0001](0001-local-login-boundary.md). A per-site setting is planned later.
Also on 2026-10-10 the owner chose the official Bitwarden client's item rule:
search every live login item by RP ID, and use the site default only to choose
among several matches (see [Item selection](#item-selection)). After the official
Bitwarden extension was found wrapping `get` outside Pateat, the owner chose on the same
day to keep Pateat's wrapper outermost whatever the extension order (see
[Bridge topology](#bridge-topology)).

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

Pateat stays outside other passkey providers' wrappers. Chromium decides the order in
which different extensions' MAIN-world document-start scripts run, and Pateat cannot
choose it. The official Bitwarden extension (browser-v2026.6.1 `fido2-page-script.ts`)
saves the current `get` and then assigns its own. When it runs after Pateat, its wrapper
sits outside and answers first: for public-key requests it rejects with `Error`, or
holds the request while its vault is locked, instead of delegating, so Pateat never sees
them. Pateat therefore installs `get` as an accessor property on `navigator.credentials`
whose getter always returns Pateat's wrapper. Assigning another function, such as that
provider's wrapper or its later restore of the function it saved, only replaces the
function Pateat delegates to; assigning a non-function or Pateat's own wrapper is
ignored. A provider that redefines or deletes the property, or patches
`CredentialsContainer.prototype.get`, is not covered.

A provider that falls back calls the function it saved, which is Pateat's wrapper. A
call with the same `mediation` as a request Pateat is still delegating, and either the
same options object or the same `publicKey` object, is treated as such a fallback and
goes straight to the function present when Pateat installed itself, normally the
browser's original. The `publicKey` match covers shallow copies such as
`{ ...options, signal }`, which Bitwarden passes for conditional requests. A provider
that copies deeper is cut off once four delegations with the same `mediation` and
challenge are in flight. Other calls are handled normally, including a new modal request
while a provider holds a conditional or unclaimed one. If a provider injected before
Pateat, the install-time function is that provider's wrapper, even after it restores the
browser's own.

The page and MAIN world are untrusted. The isolated script independently checks
`window.top === window`, `isSecureContext` and the `publickey-credentials-get`
permissions policy before relaying, and reports whether the document has transient user
activation. The background derives origin, tab, frame and document from the
browser-supplied sender, never from page data, and accepts only frame 0 of an `https:`
origin or `http://localhost`. Each request has a short-lived operation ID bound to that
document, and one document may hold only a few at once. Abort, timeout, policy
change, lock and connection replacement cancel it; a late result is discarded.
Navigation does not cancel it: Chrome drops a response addressed to a replaced
document. The wrapper delegates if the relay does not acknowledge a request
promptly, so an invalidated extension does not hold callers.

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
- The challenge is 16 to 1,024 bytes and at most 64 allowed credentials are
  given. Under the initial policy `userVerification` may take any value.
- The site is not excluded and [item selection](#item-selection) yields exactly
  one eligible credential.

Unknown extensions are ignored as the client algorithm permits; client extension
results are empty. PRF, large blob, AppID and hints are not interpreted, and the
bridge snapshot drops `timeout`, `hints` and `extensions` before relaying.

### Item selection

Follow the pinned official Bitwarden client
([`findCredentialsByRp` and `findCredentialsById`](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/platform/services/fido2/fido2-authenticator.service.ts)):
search every live login item, not only the site default, and do not use the item's
saved URIs. Skip disabled connections and excluded items. An item is a match when
its single stored credential is eligible as below. Then:

1. Exactly one match: use it. No site setting is needed.
2. Several matches: use the item in `siteDefaults` for the page's exact origin if it
   is one of them.
3. Several matches and no such default: delegate. Pateat never picks one.

Matches are counted after the request's allow list, or its discoverable-credential
requirement, narrows them. A passkey-only item with no fields is eligible; an item whose
fields the owner excluded is not. If an enabled connection could not
be searched, or an eligible item's passkey could not be read, a single match is not
used, since the unread item might also match; the site default is still used when it is
among the matches. This mirrors how the login flow refuses an automatic account choice
while any connection or item is unevaluated.

For example, two items each store a credential with `rpId` `github.com`, and
`https://github.com/login` requests `rpId` `github.com` without an allow list. With
`siteDefaults: [{ origin: "https://github.com", provider: "bitwarden", userId, itemId }]`
naming one of them, Pateat signs with that item; without it, the browser handles the
request. An allow list usually narrows the matches to one before this step. As for
logins, a default resolves to the one local connection of that provider account, and a
legacy default saved with a `connectionId` still names that connection. An account that
is connected twice, or not connected here, gives no default.

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

The owner decided that Pateat sets UP and UV on every assertion it claims,
including page-load and executor-triggered requests without a user gesture and
requests whose `userVerification` is `required`. Pateat performs no presence test
or user verification; automatic vault unlock and the standing per-site account
choice are the only authorization. This does not satisfy the WebAuthn ceremony
and tells the relying party that verification occurred when it did not. Pateat
documents it as an owner-chosen deviation, not as verification.

The flags come from a `PasskeyPolicy` with two settings: presence `always` or
`activation`, and verification `always` or `never`. The initial policy is
`always` for both. Under `activation`, requests without transient user
activation delegate; under `never`, UV stays clear and requests requiring UV
delegate. Admission records the UV decision so signing cannot diverge from it. A
later per-site setting supplies the policy without changing admission or
assertion code; until then every claimed request uses the initial policy.

## Alternatives

- UP only with user activation and UV always clear: follows the ceremony, but
  page-load, executor-triggered and UV-required requests fall back to the
  browser and cannot complete unattended. Kept as a policy for the later
  per-site setting.
- Drive or depend on the official Bitwarden extension: inherits its prompts and
  focus requirements and is not an independent adapter.
- Use an SDK authenticator: the pinned WASM exposes none.
- Add an ECDSA or CBOR library: WebCrypto already provides ECDSA P-256 and SHA-256.
  Assertions need no CBOR, and the DER signature wrapper is a fixed structure
  tested against the WebAuthn vectors. No dependency is added.
- Show a Pateat chooser or prompt: conflicts with the no-page-UI rule until an
  explicit later UI design exists.
- Rely on extension injection order: the order follows extension IDs, which Pateat
  does not control for the owner's unpacked or store builds.
- Let the outer provider answer and claim the request only after it rejects:
  Bitwarden first shows its own "No passkeys found" window, and its generic `Error`
  cannot be told apart from a refusal the page should see.

## Consequences and verification

Pateat never blocks a WebAuthn request it does not claim, so failures surface as the
browser's ordinary passkey UI, or as another installed provider's UI or rejection.
Because Pateat answers first, a claimed request never reaches another provider such as
the official Bitwarden extension. A page's own assignment to `get`, such as a polyfill
or telemetry wrapper, likewise sees only requests Pateat does not claim, and reading
`get` back does not return it. Page script and other extensions can detect the accessor.
A page call that reuses the options or `publicKey` object of a request still being
delegated with the same `mediation` goes to the browser's original `get`, skipping later
providers. Claimed requests
complete unattended, and relying parties receive UV that no authenticator performed; any
script running in a top-level page of a site with a stored passkey, including injected
script, can obtain a verified assertion for that site without any Pateat site setting.
Registration, nonzero-counter writeback, conditional mediation, cross-origin frames,
related origins and extensions remain later work.

Verify with the WebAuthn Level 3 ES256 vectors, HTML registrable-suffix cases,
credential mapping vectors, signature verification by an independent verifier,
and probe-build browser tests covering unattended claims, delegation, abort, timeout
and a synthetic relying party. Real-site interoperability and
coexistence with the official Bitwarden extension are separate gates.
