# ADR 0084: Passkeys of related origins

Status: accepted on 2026-11-04 under the owner's standing rule that Pateat matches the
official Bitwarden extension ([Bitwarden differences](../bitwarden-differences.md)),
after the owner reported at 10:11 UTC that a ChatGPT item with a passkey did not log in
(「why???」). Details marked "chosen by an agent" were not asked. Implemented in
`apps/extension/src/passkeys/related-origins.ts`, `admitGetRequest` and
`itemPasskeyFacts`. Amends [ADR 0007](0007-existing-passkey-assertions.md) (related
origin requests delegated), [ADR 0027](0027-per-account-login-routes.md) and
[ADR 0036](0036-passkey-after-the-identifier.md) (the item's `passkey` fact).

Date: 2026-11-04

## Context

On `https://chatgpt.com` the popup of the owner's Chrome said "Pateat did not log in:
the vault item has neither a password nor a passkey" for the site's default account, the
Bitwarden item "OpenAI" (username, a passkey created 2026-05-12, TOTP, no password). The
login was refused `no-route` `password-empty:no-passkey`
([ADR 0036](0036-passkey-after-the-identifier.md) rule 7).

The item's passkey belongs to the RP ID `openai.com`. Pateat looked for passkeys only
under the RP IDs `rpIdsFor` gives a page, its host and each registrable parent:
`chatgpt.com` alone. OpenAI lets ChatGPT use `openai.com` passkeys through WebAuthn
[related origin requests](https://w3c.github.io/webauthn/#sctn-related-origins):
`https://openai.com/.well-known/webauthn` answered, on 2026-11-04,

```json
{ "origins": ["https://chatgpt.com"] }
```

Chrome supports such requests, and the official Bitwarden extension checks the RP's list
when an RP ID is not the page's own (`isValidRpId` and `isAllowedByRor` in
[domain-utils.ts](https://github.com/bitwarden/clients/blob/601701362c2c858b6860a3506a99bb77cc2d7a58/libs/common/src/platform/services/fido2/domain-utils.ts#L107-L248),
called for `get` and `create` in
[fido2-client.service.ts](https://github.com/bitwarden/clients/blob/601701362c2c858b6860a3506a99bb77cc2d7a58/libs/common/src/platform/services/fido2/fido2-client.service.ts#L292)).
ADR 0007 had left related origins as later work: such a request was handed to the
browser.

## Decision

1. **The RP's list.** A page of an HTTPS origin may use an RP ID of another site when
   `https://<RP ID>/.well-known/webauthn` lists that origin, by the WebAuthn related
   origins validation procedure: a `200` answer with the content type
   `application/json`, a JSON object whose `origins` is an array of strings, an entry of
   the same origin as the page, and at most five registrable origin labels counted, as
   Chrome and Bitwarden count. The list is fetched without credentials or a referrer,
   from the background service worker, and the fetch is bounded at 5 seconds, as
   Bitwarden's. Only an RP ID that is a canonical registrable domain, or a name under
   one, and that the page may not use anyway is checked; a public suffix is never
   fetched. Anything else counts as not listed.
2. **Kept in memory** (chosen by an agent). A list is reused for ten minutes and a
   failed read for one minute, so a login and the passkey requests of its page share one
   fetch; at most 64 RP IDs are kept, and nothing is stored. A caller that stops waiting
   leaves the read to the others.
3. **Passkey requests.** A `get` request whose RP ID the page may not use is checked
   against the RP's list before admission, alongside the device's passkey policy, so a
   page's cancel meanwhile is kept. When the RP lists the page, the request is admitted
   as one of that RP ID, and every other rule of ADR 0007 applies unchanged: the vault
   is searched by that RP ID, the assertion's client data names the page's origin, and
   the signature covers that RP ID's hash. Otherwise the request is handed to the
   browser as before (`rp-id-mismatch`).
4. **A login's item.** The item's `passkey` and `discoverablePasskey` facts (ADR 0027,
   ADR 0036 rule 1, "a usable passkey for an RP ID the origin may use") count an RP ID
   the RP lists the page for. The page's own RP IDs are searched first; only when they
   give no discoverable passkey, the RP IDs of the item's own stored passkeys are read
   from the crypto Worker (`passkey-rp-ids`, secret-free like `passkey-find`), and each
   one of another site is checked against its list and then searched for that item, as
   before. On `https://chatgpt.com`, the OpenAI item's `openai.com` passkey therefore
   counts, and the login goes on after the email as ADR 0036 says.
5. **Not changed** (chosen by an agent). Registration (`create`), which Pateat answers
   only by refusing a registration that lists the vault's passkey (ADR 0007), still
   checks only the page's own RP IDs. So do the items a page holds passkeys for
   (`originPasskeyItems`: the popup's choice of ADR 0034 and the passkey-only pages of
   ADR 0053), the site count and the popup's account list: they would need every item's
   RP IDs read on every page. An item matches those by its URIs as before.

## Consequences

- A passkey of `openai.com` signs in on `chatgpt.com`, by a login of the item or by the
  page's own request, as in Chrome and the official extension.
- Pateat fetches `https://<RP ID>/.well-known/webauthn` from the RP named by a page's
  request, or by a passkey of the login's item, at most once in ten minutes per RP ID.
  The RP learns that some Pateat installation is asked about it, with no cookie and no
  referrer, as the browser itself does for its own passkeys.
- A login of an item without a discoverable passkey for the page's own RP IDs reads the
  item's passkey RP IDs once from the Worker.
- Verify with `related-origins.test.ts`, `request.test.ts`, `runtime.test.ts`,
  `vault.test.ts`, `crypto/passkey.test.ts` and `host.test.ts`; on the owner's Chrome,
  the OpenAI item on `https://chatgpt.com/auth/login`.
