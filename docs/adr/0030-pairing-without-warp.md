# ADR 0030: Pairing from browsers without WARP

Status: accepted by the owner on 2026-10-12 (05:17 to 05:28 UTC). Implemented in the
Worker and the extension. The "pateat pair" Access application and the `ACCESS_PAIR_AUD`
Worker secret are set up by the owner (see
[delivery](../delivery.md#production-settings)). Amends
[ADR 0020](0020-direct-device-pairing.md) (the sign-in tab and the audiences
`POST /pair` accepts).

Date: 2026-10-12

## Context

The host-wide Access application on `pateat.takuk.me` uses the owner's reusable policy:
the owner's email domain and a device connected through Cloudflare Gateway (WARP). On
2026-10-12 the owner loaded Pateat on a Grok Bot computer, whose browser has no WARP
([browser agents and logins](../research/2026-10-11-browser-agent-logins.md#observed-on-a-grok-bot-computer)).
Pairing there is refused by Access before it reaches the Worker. The owner decided that
a way through without WARP should stay once it works, not only for a test (05:17 UTC).

## Decision

- **A third Access application covers pairing only.** "pateat pair" has the destination
  `pateat.takuk.me` with path `pair`, which also covers the paths below it. Access picks
  the most specific path, as it already does for "pateat bypass". `/manage` stays on the
  host-wide application and keeps requiring WARP, so a browser without WARP can pair
  but cannot open the owner pages: no device list, revocation, settings, recipes or
  bindings.
- **Two Allow policies.**
  - The owner's existing reusable policy (email domain and WARP). The owner's Chrome
    passes this one. Its session on the host-wide application does not carry over:
    on 2026-10-12, its first visit to `/pair/signed-in` after "pateat pair" was
    created asked for a One-time PIN code.
  - Include the owner's email address only, and require the One-time PIN login method.
    No WARP. A browser without WARP can only pass this one. The login-method
    requirement keeps it from admitting another identity provider added later, so no
    identity provider session, such as Google's, would be left on a vendor's machine.
  - Login methods: One-time PIN only. On 2026-10-12, before "pateat pair" was created,
    One-time PIN was the team's only identity provider, and the host-wide application
    signs in with it too.
- **Other application settings.** Session Duration 15 minutes. Cookie Path Attribute on,
  so the application's `CF_Authorization` cookie is sent only below `/pair` and does not
  replace the host-wide application's cookie in the owner's Chrome. Binding Cookie on,
  so a stolen `CF_Authorization` cookie alone cannot pair (the threat model of
  ADR 0020).
- **The Worker accepts the second audience on pairing routes only.** The
  `ACCESS_PAIR_AUD` Worker secret holds "pateat pair"'s Application Audience (AUD) Tag.
  `POST /pair` and `GET /pair/signed-in` accept `ACCESS_AUD` or `ACCESS_PAIR_AUD`;
  `/manage` and `/manage/api` accept `ACCESS_AUD` only. An empty `ACCESS_PAIR_AUD`, or
  one no token carries, turns the second audience off; once "pateat pair" exists, Access
  issues only its audience on `/pair`, so that would stop all pairing. The owner is
  still found by issuer and subject. Access gives one `sub` per email address in the
  account, so a sign-in to either application reaches the same owner.
- **The sign-in tab opens `/pair/signed-in`.** When pairing needs a sign-in, the
  settings page opens `<service>/pair/signed-in` instead of `<service>/manage`. Access
  signs the browser in on the way, and the page says "Close this tab and go back to
  Pateat's settings page." It has no `/manage` link, which a browser without WARP could
  not open. The settings page retries pairing once when it is shown or focused again, as
  before. The owner's Chrome uses the same page.

## Consequences

- **WARP is no longer a second condition for pairing.** Anyone who can read the owner's
  mail, including a forwarding address or whoever controls the domain's MX, can sign in
  with a One-time PIN and create a device. That device can do everything `/v1` allows:
  read and replace the synced settings, which apply on all of the owner's devices
  (`excludedSites`, `siteDefaults`, `bindings` and the account and item policies); read,
  overwrite and delete recipes; call recipe generation and the login-completion judge
  with the owner's Claude credentials, within the $5 a day and $100 a month stops; and
  read or revoke itself. Vault values are not on the service. The device cannot open
  `/manage`, so it cannot revoke other devices.
- **The global session.** A One-time PIN sign-in also creates the Access global session
  on the team domain. Until it ends (the Global session duration, 24 hours by default)
  that browser can get new "pateat pair" tokens without a code and pair more devices,
  within `PAIR_LIMITER` (10 a minute). Any other Access application of the team that
  does not require WARP and admits the owner's address is also reachable. After pairing
  on a vendor's machine, open `<service>/cdn-cgi/access/logout`; it signs out of every
  Access application, the owner's Chrome included.
- **One owner.** A device paired this way belongs to the owner, so settings changed on
  it apply to all of the owner's devices.
- **Monitoring and removal.** The owner can watch Access authentication logs for
  One-time PIN sign-ins, revoke unknown devices on `/manage`, and use **Revoke existing
  tokens** on "pateat pair". Deleting the application and emptying `ACCESS_PAIR_AUD`
  returns pairing to WARP only.
- The vault cache and retained unlock key on a vendor's machine
  ([ADR 0006](0006-atomic-local-vault-cache.md)) are unchanged by this decision. The
  owner decided on 2026-10-12 (05:33 UTC) to connect their existing Bitwarden account
  there rather than a test account. The vendor's machine then holds an encrypted copy
  of the whole vault and the key that opens it, and an agent with a shell there could
  read them, or read a password Pateat fills, if a prompt injection steered it.
  **Deauthorize sessions** in Bitwarden stops new syncs but not the copy already there;
  changing the affected passwords is the remedy if a leak is suspected.

## Alternatives

- **Add a non-WARP rule to the host-wide application.** One setting, but `/manage`
  would also open from a vendor's browser.
- **A code issued on `/manage` and typed into the agent's Pateat.** No Access change and
  no Access session on the vendor's machine, but it brings back a typed-code flow, which
  ADR 0020 removed and the owner rejected.
- **Mark devices paired without WARP.** Once "pateat pair" exists, the owner's Chrome
  also pairs through it, so the audience cannot tell them apart. Device names do.

## Unverified

- With Cookie Path Attribute on, the owner's Chrome may send two `CF_Authorization`
  cookies to `/pair`, the host-wide application's and "pateat pair"'s. Cloudflare's
  documentation does not say which one Access checks. Checked on 2026-10-12 in the
  owner's Chrome after "pateat pair" was created: after the One-time PIN sign-in,
  `GET /pair/signed-in` answered 200 with the "Signed in" page, `/manage` still opened
  without another sign-in, and the already paired extension kept syncing (full syncs at
  06:35 and 06:40 UTC, no warnings or errors after 06:33 UTC).
- Whether `POST /pair` from the extension's service worker passes with Binding Cookie
  on. Not checked yet: the owner's Chrome is already paired, so the first `POST /pair`
  through "pateat pair" is the next new pairing, on an agent's computer or in the
  owner's Chrome. A failure there may come from Binding Cookie.

ADR 0020 asks for a cookie probe whenever cookie settings change.
