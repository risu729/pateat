# ADR 0020: Direct device pairing from the extension

Status: the decisions under "Owner decisions" were approved by the owner on 2026-10-11.
The implementation choices further down are Claude's; they are not owner decisions and
may change in their PRs. The manifest `key`, `POST /pair` and the extension switch are
implemented, and the typed-code flow is removed. Pairing installed Chrome with the
deployed service is not yet recorded; the [plan](../plan.md) tracks it.
[ADR 0030](0030-pairing-without-warp.md) amends the sign-in tab, which now opens
`/pair/signed-in`, and lets `POST /pair` accept a second Access audience.
This replaces the typed-code pairing in the architecture's
[device enrollment](../architecture.md#device-enrollment) section and settles the
"enrollment transport" that [ADR 0003](0003-service-and-ai.md) left open.

Date: 2026-10-11

## Context

A device needs a revocable, owner-scoped credential for the `/v1` sync routes. Today
the settings page starts a pairing in the background, which keeps a 256-bit verifier,
and shows an 8-character code. The owner opens `/enroll?challenge=…&label=…` in a tab,
signs in through Cloudflare Access, types the code and confirms. The extension polls
the anonymous `POST /redeem` with the verifier until it receives the credential.

The code exists because the approval link is not a secret. Without the code, someone
could start a pairing in their own extension and send the owner the `/enroll` link.
The owner's Access session would approve it in one click. The attacker would then
redeem the credential through `/redeem`, which bypasses Access, and use `/v1` from
anywhere. The flow is safe, but it costs a tab, a typed code, polling, a 10-minute
approval window, the `enrollments` table, an anonymous route with its own rate limiter
(`REDEEM_LIMITER`) and a Bypass entry for `/redeem` in Access.

On 2026-10-11 the owner ran this in the DevTools console of the installed Pateat
extension in their own Chrome:

```js
fetch("https://pateat.takuk.me/manage/api/devices", { credentials: "include", redirect: "manual" })
```

It returned 200 with the owner's device list. The owner then ran the same request in
the console opened from Pateat's **service worker** inspect link, on the production
build of main `59a2d12`, with the console context showing `background.js`. It returned
`200`, type `basic`, body `{"version":1,"devices":[...]}`. Chrome therefore sends the
Access session cookie on a request from the extension's background service worker to a
host the extension can access (`host_permissions: ["https://*/*"]`,
[ADR 0009](0009-install-time-https-site-access.md)).

## Owner decisions (2026-10-11)

1. **The extension pairs with one request.** When the user clicks **Pair this device**,
   the extension sends one request to a new pairing route with `credentials:
   "include"`. That way the browser's login session to the service travels with it.
   The service creates the device only when both checks below pass, and returns the
   credential in the response. There is no tab and no code.
   - **A valid owner login.** Today this is the Access JWT, verified as for `/manage`.
     The owner is the token's issuer plus its subject.
   - **An allowed extension.** `Origin` must be `chrome-extension://<allowed id>`.

   A sign-in tab opens only when the user is not signed in. The `/v1` sync routes stay
   device-credential only and send no cookies.
2. **Only Pateat's extension ID can pair.** The manifest pins the ID with a `key` (a
   public key), so unpacked builds get a stable ID. The service accepts only configured
   extension IDs.
3. **The requirement is the browser's login session, not Access.** Access is how the
   login session works today. Access may be removed later, for example for a public
   release. A service-owned login would then replace it, which is the Access-free OIDC
   or passkey adapter that ADR 0003 allows. That login maps to the same `(issuer,
   subject)` owner key. The Origin check, the response and the extension side would not
   change. Its design is not part of this decision. Several users may share one Access
   application: each signs in as their own identity, and owners are keyed by issuer
   plus subject, never by email or application.

Under the owner's pre-release rule
([compatibility before release](../development.md#compatibility-before-release)), the
typed-code flow is removed, not kept beside the new one. That covers `/enroll`,
`POST /redeem`, the verifier, challenge and code contracts, the `enrollments` table
(dropped by a new D1 migration), `REDEEM_LIMITER`, and `redeem` in the paths of the
Access Bypass application ("pateat bypass").

### Rejected alternatives

- **Keep the typed code.** It works and needs no extension-ID setup, but it keeps the
  tab, the typing, the polling, the anonymous route and the stored approvals.
- **`chrome.identity.launchWebAuthFlow`.** It adds the `identity` permission.
- **Open `/enroll` with the code filled in, for a one-click Confirm.** The link would
  carry the code. A forwarded link would then be approved in one click, which is the
  same as having no code.
- **Protect `/v1` with Access as well.** Background sync cannot depend on an
  interactive login.

## Implementation choices (Claude, not owner-approved decisions)

- **Route.** `POST /pair` sits outside `/v1` and `/manage/api`, and the host-wide
  Access application covers it; it is not in the Bypass application. The body is JSON
  `{ "version": 1, "label": "Work laptop" }`. The label uses the existing
  `deviceLabelSchema`. The answer returns the device ID and credential once, and only
  the credential's SHA-256 is stored, as today. The first pairing of an identity
  creates its owner, as approval did. Errors are stable JSON codes, documented in
  `services/api/README.md`, including `extension_not_allowed` for an `Origin` that is
  not on the list. Rate limiting is per verified identity. No `Access-Control-*`
  headers are sent, so no web page can read a response. Requests from extension
  contexts to hosts the extension can access skip CORS and preflight.
- **Allowed list.** `PAIRING_EXTENSION_IDS` is a JSON array of IDs, declared in
  `cloudflare.config.ts` beside the domain and the D1 ID. The repository commits
  Pateat's own ID there. It is not a secret, so self-hosters who build their own
  extension list their own ID. An empty or malformed list refuses every pairing.
- **Production build only.** The `key` goes into the production manifest only. Every
  unpacked production build gets the same ID; the synthetic probe build keeps its
  path-derived ID. The probe build is also loaded into the owner's Chrome
  ([development](../development.md)). Sharing the production ID would give it the
  production extension's storage (vault cache, retained unlock key, device credential)
  and put its probe-only scripts and host access on that identity, against ADR 0009.
- **The key.** The key is a 2048-bit RSA key. Its base64 DER SubjectPublicKeyInfo is the
  manifest `key`. The ID is the first 128 bits of the key's SHA-256, written as 32
  letters `a` to `p`. Only the public key is committed. Loading an unpacked extension
  checks no signature, so no private key is needed for it. The private key only signs
  `.crx` packages, and Pateat publishes none. The ID alone proves nothing, because
  anyone can copy the public key. It matters only together with the owner's login
  session, and Chrome cannot load a second extension with the same ID.
- **Chrome Web Store.** If Pateat is ever published there, the store item's public key
  replaces the manifest `key`, and its ID is added to the list. This is checked when
  publishing is planned.
- **Who sends the request.** The background service worker sends it. It already holds
  the service record, runs service requests one at a time, and writes the credential
  straight into trusted extension storage. The rule that the credential never crosses
  to the settings page is therefore kept. The owner's service-worker probe of
  2026-10-11 (see [Context](#context)) shows that the worker's requests carry the
  Access session. Once `POST /pair` is deployed, a request from the current install,
  whose ID is not on the list, answering `403 extension_not_allowed` confirms the whole
  path end to end, `Origin` included, without creating a device.
- **Sign-in.** Three responses mean "sign in first": an `opaqueredirect` (Access
  redirects a request without a session to its login), a response that is not JSON (an
  Access login or denial page), and the Worker's own `401`. The request also sends
  `X-Requested-With: XMLHttpRequest`. Cloudflare documents that this header turns an
  expired session into a `401` instead of a redirect; whether it does the same when
  there is no session at all is unverified, so the redirect handling stays. The settings
  page then opens `https://<service>/manage` in a new tab, at most once per click.
  Signing in there is the same for Access and for a later service login, and the new
  device appears on that page afterwards. (Superseded by
  [ADR 0030](0030-pairing-without-warp.md): the tab opens `/pair/signed-in`, which a
  browser without WARP can also reach, and the device appears on `/manage` as before.)
  The settings page retries once when it is shown or focused again, and offers
  **Try again**. Its message also covers "the service refused this account".

## Threat model

- **The link attack is gone.** With no link and no code, there is nothing to send the
  owner. A credential goes only to the response of a request that carries the owner's
  session, which exists only in the owner's browser, from an allowed extension origin.
- **Web pages cannot pair.** Browsers set `Origin`, and pages cannot set it to
  `chrome-extension://…`. That includes script injected into the owner web UI, because
  the service's own origin is refused. Whether a cross-site request carries the Access
  cookie depends on the application's SameSite setting, which Cloudflare leaves at None
  by default, so SameSite is not relied on. The Origin check stops such requests. A
  JSON body also needs a preflight, and the Worker sends no CORS headers.
- **Withheld site access creates no device.** Without host access, Chrome treats the
  extension's request as an ordinary CORS request, and its JSON preflight fails before
  the request is sent. The extension also checks site access first and reports
  `site-access-needed`.
- **A stolen session.** Non-browser clients can send any `Origin`. Someone holding a
  stolen `CF_Authorization` cookie can therefore pair, and the credential they get stays
  valid until revoked or unused for 90 days, beyond the session that minted it. The old
  flow had the same property. The owner sees and revokes such a device on `/manage`.
  Access's optional binding cookie makes a stolen cookie unusable.
- **Other extensions in the same browser.** This risk remains. Any extension with host
  access to the service host can already read `/manage/api/*` with the owner's cookie,
  as the probe showed (`requireSameOrigin` guards only state-changing methods), and
  can operate `/manage` through content scripts. No server check prevents that, and it
  is not new.
  - **What the ID list adds.** It stops such an extension, using ordinary requests,
    from turning the owner's browser-bound, session-limited access into a portable,
    long-lived device credential. That credential would work from anywhere, including
    on `/v1/recipes/generate`, which spends the owner's Claude credentials.
  - **Where it stops.** A malicious extension that can rewrite request headers, for
    example through `declarativeNetRequest`, may be able to forge `Origin`. The list
    is not a boundary against an extension that already controls the owner's session.
- **Expiry and loss.** An expired session yields a redirect, an HTML page or a `401`,
  never a device. A response lost after the device was created leaves an unused device
  that the owner can revoke.
- **Labels** are validated by the same schema on both sides, rendered with escaping in
  the web UI, and no longer appear in any URL.

## Consequences

- **A one-time reset of the owner's install.** The owner's current unpacked install
  has a path-derived ID. Chrome hashes the absolute path of the loaded folder, so that
  ID is stable only for that folder on that machine. No key can reproduce it, because
  matching an ID would need a SHA-256 preimage. The first production build loaded after
  the key lands is therefore a different extension with empty storage. Lost with the
  old ID:
  - the vault connections, the local vault cache and the retained unlock key, so
    automatic unlock is set up again;
  - the Bitwarden sync sign-in, so signing in again may trigger Bitwarden's new-device
    verification;
  - the service pairing and recipe cache;
  - the device-local settings that are not synced (item selection and field
    exclusions, [ADR 0013](0013-service-held-recipes-and-settings.md));
  - Chrome's site-access choices and the toolbar pin for the extension.

  Settings, bindings and recipes held by the service come back after pairing again.
  The owner does this once:
  1. Disconnect the service in the old build, which revokes its device, or revoke that
     device on `/manage` later.
  2. Remove the old Pateat entry in `chrome://extensions`. Do not press Reload on it.
  3. Load the new build and check that its ID is the committed one.
  4. Set up the vault connection and automatic unlock again.
  5. Pair again.
  6. Redo item selection and field exclusions.
  7. Optionally, remove the old Pateat device from the Bitwarden account's device list.

  Before the first release this needs no migration.
- **Pairing takes one click** when signed in, and one sign-in tab otherwise. The
  service loses its only anonymous write route, the route's Access bypass and its
  per-address rate limit.
- **The device belongs to whoever is signed in.** With several users on one Access
  application, the device pairs to whichever identity the browser's session holds. No
  page shows that identity before the device is created.
- **Self-hosted builds** must list their own extension ID. A service that does not
  list the installed build answers `extension_not_allowed`, and the settings page says
  so.
- **Cookie settings are part of the evidence.** Pairing depends on Chrome sending the
  service's session cookie on extension requests. The Access application's cookie
  settings at the time of the probe (SameSite, binding cookie) are part of that
  evidence; changing them needs the check repeated.

## Open items

These need the owner's answer:

- **Showing the paired identity, possibly later.** For example, the success response
  could carry the token's email for the settings page to show. This would be a new
  decision and is not planned. A separate admin view of every user's devices is a
  different feature; the owner suggested it would be its own page behind its own Access
  rule.

Credential idle expiry, which this ADR left open, was decided separately on
2026-10-11: a credential expires after 90 days unused and each use renews it (see the
architecture's [device enrollment](../architecture.md#device-enrollment)).
