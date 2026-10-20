# Pateat's Bitwarden code against Vaultwarden 1.37.4

Researched: 2026-10-19, 21:09–21:30 UTC, in a cloud container, with Pateat at
[`988486d`](https://github.com/risu729/pateat/commit/988486d). Supports
[ADR 0059](../adr/0059-latest-vaultwarden-server.md). Synthetic accounts and items
only; no real account, no extension UI and no real Chrome.

## Setup

- `vaultwarden/server:1.37.4`
  (`sha256:efb3cde962015fcc036b2ea625242248611943b27212ebf4392841fb30fad055`, tag commit
  [`7c18896`](https://github.com/dani-garcia/vaultwarden/tree/7c188967e7a467b19b2757bc3326f9cf3ccae327)),
  HTTPS through `ROCKET_TLS` with a throwaway local CA at `https://localhost:8443`, with
  `SIGNUPS_ALLOWED=true`, `SIGNUPS_VERIFY=false`, `LOGIN_RATELIMIT_MAX_BURST=1000`,
  `LOGIN_RATELIMIT_SECONDS=1` and `DISABLE_ICON_DOWNLOAD=true`. Ready about 4 s after
  `docker run`. Docker Hub answered an anonymous pull with `429 Too Many Requests`;
  `ghcr.io/dani-garcia/vaultwarden` serves the same image.
- A scratch script registered accounts and seeded items with `PureCrypto` from
  `@bitwarden/sdk-internal`, then called the functions exported by
  `packages/bitwarden/src/index.ts` in setup's order: `createBitwardenTransport`,
  `prelogin`, `derivePasswordAuthentication`, `passwordToken`, `sync`,
  `createBitwardenAccountMapper().map`, `createLocalCryptoSession`, `decrypt*`.
- A second run had the official Bitwarden CLI 2026.10.0 (`bw create item`,
  `bw import bitwardenjson`) write items to the same account.

## Results

| Step                                                      | Result                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/config`                                         | `{version: "2026.6.0", kind: "vaultwarden"}`                              |
| `POST /identity/accounts/prelogin/password`               | ok; flat fields and `kdfSettings` agree, `salt: null`                     |
| `POST /identity/connect/token`, password grant            | `authenticated`                                                           |
| same, authenticator two-step on, no code                  | `{kind: "mfa-required", providers: [0], supportedProviders: [0]}`         |
| same, valid code; refresh grant                           | `authenticated`                                                           |
| `GET /api/sync`, `GET /api/accounts/revision-date`        | ok                                                                        |
| account mapping and unlock                                | `accountVersion: "v1"`; PBKDF2 600000 and Argon2id (3, 64 MiB, 4) unlock  |
| login item: URI match `null`, 1, 3, 4; TOTP; fields       | decrypt to the stored values                                              |
| passkey (ECDSA P-256), organization item and collection   | decrypt                                                                   |
| `bw create item` items (match 2, `otpauth://`, linked)    | map and decrypt                                                           |
| `bw import` item with a passkey                           | whole account `invalid-response` (its passkey has `"response": null`)     |
| wrong master password; wrong authenticator code           | `interaction-required / unsupported-challenge`                            |

The wrong-password body (HTTP 400):

```json
{"message":"Username or password is incorrect. Try again","validationErrors":{"":["Username or password is incorrect. Try again"]},"errorModel":{"message":"Username or password is incorrect. Try again","object":"error"},"error":"","error_description":"","exceptionMessage":null,"exceptionStackTrace":null,"innerExceptionMessage":null,"object":"error"}
```

A wrong authenticator code has the same shape with `Invalid TOTP code! Server time: …
IP: …`; the source gives `Token is invalid! IP: …` and `Token has expired` for email
codes and `Two-step token is invalid. Try again.` for recovery codes.

## What Vaultwarden cannot show

- V2 accounts: it always sends `signatureKeyPair`, `securityState` and
  `signedPublicKey` as `null`
  ([user.rs](https://github.com/dani-garcia/vaultwarden/blob/7c188967e7a467b19b2757bc3326f9cf3ccae327/src/db/models/user.rs#L264-L280)).
- New-device OTP: not implemented.
- Email two-step codes are sent only by `POST /api/two-factor/send-email-login`
  ([email.rs](https://github.com/dani-garcia/vaultwarden/blob/7c188967e7a467b19b2757bc3326f9cf3ccae327/src/api/core/two_factor/email.rs#L39-L40)),
  never by a token request; Pateat did not call it on that date (it does since ADR 0059
  decision 5).
