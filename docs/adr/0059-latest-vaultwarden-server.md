# ADR 0059: The latest Vaultwarden release is a supported server

Status: accepted by the owner on 2026-10-19 at 22:14 UTC. Shown the reviewed proposal
with three questions (make Vaultwarden a tested server now, alongside the synthetic
official-shape fixtures; ignore item keys Pateat does not know, like Bitwarden; allow
`http://` server roots only for `localhost`, `127.0.0.1` and `[::1]`), the owner picked
the recommended option of each and wrote "yes, do it now. no need to care about the
phase for vaultwarden. support the latest vaultwarden server. (make this clear, the only
supported one is the latest one)." Replaces "Vaultwarden support is later work" (owner,
2026-10-11). Decision 5 was accepted at 22:34 UTC: asked whether Pateat should send
email two-step codes like the official extension, by a button, or not at all, the owner
wrote 「テストじゃなくてもそれないと困らないか？そうなら実装して」 (wouldn't it be a
problem without it, even outside tests? if so, implement it), read as "like the official
extension". Decision 6 was accepted at 22:40 UTC by a card tap: offered Mailpit and the
in-process `smtp-server` library, with `smtp-server` recommended, the owner picked
Mailpit. All six decisions are implemented, and CI tests Pateat against the pinned
Vaultwarden image (`tests/vaultwarden/`, `tests/extension/vaultwarden.spec.ts`).
Unknown-key handling outside nested cipher objects (legacy flat `data`) and the exact
message list in decision 4 are the agent's reading of the answers, not confirmed by the
owner.

Date: 2026-10-19

## Context

Pateat was tested only against the official Bitwarden server's response shapes. On
2026-10-19 Pateat's Bitwarden package ran against Vaultwarden 1.37.4 in a cloud
container ([research](../research/2026-10-19-vaultwarden.md)). Sign-in, authenticator
two-step, refresh, sync, unlock (PBKDF2 and Argon2id), every URI match mode, TOTP,
custom fields, passkeys and organization items worked. Two things did not:

- Vaultwarden returns the JSON a client stored inside `login`, `fields` and the other
  type objects unchanged
  ([ciphers.rs](https://github.com/dani-garcia/vaultwarden/blob/7c188967e7a467b19b2757bc3326f9cf3ccae327/src/api/core/ciphers.rs#L289-L294)).
  The official CLI 2026.10.0's `bw import` stores `"response": null` in a passkey, and
  Pateat's strict nested schemas refused the item, which failed the whole connection
  with `invalid-response`. The official server rebuilds these objects from typed models,
  and the official clients read only the properties they know
  ([base.response.ts](https://github.com/bitwarden/clients/blob/86f41566aebe5a024796df8abfb3d4d89ec509c1/libs/common/src/models/response/base.response.ts#L10-L40)).
- A wrong password or two-step code comes back as Vaultwarden's own error JSON
  (`"error": ""`, `"object": "error"`), which Pateat reported as `unsupported-challenge`
  instead of a rejection.

## Decision

1. Vaultwarden is a supported, tested server. Only its latest release is supported
   (1.37.4 on 2026-10-19); older releases are not, even where they work. Tests pin the
   latest image and Renovate keeps it current. It is
   supported now, outside the roadmap's phases. The synthetic official-shape fixtures
   stay, because passing on Vaultwarden is no evidence for the official server; V2
   (signing-key) accounts and new-device OTP, which Vaultwarden does not have, stay
   covered only by them.
2. Keys Pateat does not read are ignored inside a received item, like the official
   clients: nested objects (`login`, its `uris` and `fido2Credentials`, `fields`,
   `card`, `identity`, the other type objects, `attachments`, `passwordHistory`,
   `permissions`) and the legacy flat `data`. Values Pateat reads are validated as
   before, and every nested object must still be a plain object. The SDK and the vault
   cache receive the copy without the unknown keys (`admitLocalCryptoCipher` in
   `packages/bitwarden/src/local-crypto.ts`); a cached copy must still match its
   admission exactly. Some unknown keys still refuse the item, and with it the
   connection: `__proto__`, `prototype` and `constructor`, two keys that differ only in
   case with different values, and any spelling of a sealed blob's keys in the flat
   `data` (agent's choice, not confirmed by the owner).
3. A self-hosted server root may use `http://` only when its host is exactly
   `localhost` or `127.0.0.1`, so the master-password hash and tokens never leave the
   machine in clear text; every other root stays `https://`. The owner was asked about
   `[::1]` too, but Chrome's extension CSP refuses an IPv6 literal as a `connect-src`
   source (checked in Chromium 141 on 2026-10-19), so it is left out; `http://localhost`
   reaches a server listening on `::1`. That narrowing is the agent's, not confirmed by
   the owner. No permission is added. The official clients accept any `http://` URL; the
   implementation records the difference in
   [Differences from Bitwarden](../bitwarden-differences.md).
4. A 400 password-grant answer in Vaultwarden's error shape (keys only `message`,
   `validationErrors`, `errorModel`, `error`, `error_description`, `exceptionMessage`,
   `exceptionStackTrace`, `innerExceptionMessage`, `object`, with `error` empty and the
   `object` and `errorModel.object` `"error"`, and the same message in `message` and
   `errorModel.message`) is classified by its message:
   `Username or password is incorrect. Try again` is `rejected / credentials`; a message
   starting `Invalid TOTP code! ` or `Token is invalid! ` (with the space), `Token has
   expired` and
   `Two-step token is invalid. Try again.` are `rejected / mfa`
   (`parsePasswordTokenOutcome` in `packages/bitwarden/src/auth-models.ts`). Anything
   else stays `unsupported-challenge`.
5. Pateat asks the server to email a two-step code as the official extension does, for
   every server: when email becomes the selected method on the settings page's sign-in,
   it sends one code (`POST {api}/two-factor/send-email-login`, with the master-password
   hash the password grant already sent, to that server only), and shows "Resend code".
   The hash stays in memory for that one sign-in only; it is never stored or sent
   anywhere else. This changes sign-in for the official server too, not only
   Vaultwarden. Automatic sync uses the refresh token and never asks for a code.
6. The Vaultwarden test server's email goes to
   [Mailpit](https://github.com/axllent/mailpit), a second digest-pinned container
   beside Vaultwarden (`ghcr.io/axllent/mailpit`), whose HTTP API the tests read the
   code from.

## Consequences

- An item with keys some client added no longer stops every item of its connection.
- A Vaultwarden user who types a wrong password or code sees that, not an unsupported
  step.
- A Vaultwarden release that changes a response shape Pateat reads can break Pateat
  until the tests are updated; Renovate's image update runs the tests against it first.
- Neither server sends an email two-step code on the token request; decision 5 asks for
  one separately, so an account with only email two-step can sign in from the settings
  page.

## Alternatives

- Use Vaultwarden only as a test server and keep it unverified for users: rejected,
  because the fixes are needed either way and tested behaviour need not stay unclaimed.
- Keep refusing unknown keys: one imported passkey item would keep a whole connection
  unusable.
- For test mail, the `smtp-server` npm library inside the test process: one container
  fewer, but Vaultwarden in its container must reach the host, which each OS sets up
  differently. MailCrab: smaller, but published on Docker Hub only, with no API to find
  the latest message or search by recipient.
- Keep self-hosted roots HTTPS-only: testing in the owner's Chrome would need a local CA
  in the Windows trust store, whose private key could impersonate any HTTPS site there.
