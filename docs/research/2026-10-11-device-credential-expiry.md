# Device credential expiry and the Chrome Web Store extension ID

Researched: 2026-10-11, from official documentation and vendor source code unless
marked "community". Quotes are short excerpts as fetched on that date. Section 1 is the
survey behind the owner's device credential lifetime decision (section 3). Section 2 is
for a later Chrome Web Store release
([Phase 3](../plan.md#phase-3-public-release)), where the owner accepted a
store-assigned extension ID and pairing again; it records the one undocumented way to
keep the current ID. Nothing was uploaded.

## 1. Provider survey

| Provider / credential | Idle expiry | Absolute lifetime | Rotation | After expiry |
| --- | --- | --- | --- | --- |
| Google OAuth refresh token | 6 months unused | none (production apps); 7 days for apps in "Testing" status | no | user re-consents (interactive OAuth) |
| Microsoft Entra refresh token | 90 days (each use returns a new token with a fresh lifetime, so effectively a 90-day rolling window) | none by default; 24 h for SPA redirect URIs | yes, new RT on every use; old one not revoked | interactive sign-in |
| GitHub OAuth app token / classic PAT | revoked after 1 year unused | OAuth: none by default; PAT: owner-chosen, default 30 days, "none" allowed unless org policy | no (unless expiring tokens opted in) | re-authorize / create new token |
| GitHub App user token (and OAuth apps opting in) | refresh token expires after 6 months (without use) | access token 8 h | yes, one-time-use refresh token | redo web or device flow |
| GitHub CLI (`gh auth login`) | not documented separately; it is an OAuth app token, so the 1-year-unused rule applies | not documented | not documented | `gh auth login` again |
| Bitwarden refresh token (server source) | sliding: browser extension 30 days, desktop/CLI 30, mobile 60, web vault 7 | none by default (configurable) | no (`TokenUsage.ReUse`) | log in again (master password, 2FA) |
| 1Password device authorization | none documented | none documented | n/a | manual "Deauthorize Device"; then Secret Key + password on that device |
| Slack (opt-in token rotation) | not documented | access token 12 h | yes, one-time refresh token with short grace period; cannot be turned off once on | reinstall/re-authorize |
| Tailscale node key | no (not activity-based) | 180 days default, admin-set 1-180 days, renewed on re-auth; can be disabled per device; disabled by default for tagged devices | key renewed at re-auth | connections stop; `tailscale up --force-reauth` (browser login) |
| Syncthing device | none: identity is a self-signed certificate hash | not documented as enforced | no | n/a (remove device manually) |

Firefox Sync was not researched.

### Google OAuth 2.0

<https://developers.google.com/identity/protocols/oauth2#expiration>

- Refresh token stops working when "The refresh token has not been used for six months."
- A project with publishing status "Testing" "is issued a refresh token expiring in 7
  days", unless scopes are only name, email and profile.
- Also: password change (Gmail scopes), expired time-based access, limit of 100 refresh
  tokens per account per client ID (oldest silently invalidated).

### Microsoft Entra

<https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens>

- Default lifetime "24 hours for single-page applications" and "90 days for all other
  scenarios".
- "Refresh tokens replace themselves with a fresh token upon every use. The Microsoft
  identity platform doesn't revoke old refresh tokens when used to fetch new access
  tokens."
- On expiry or revocation, apps should redirect "the user to an interactive sign-in
  prompt".

<https://learn.microsoft.com/en-us/entra/identity/conditional-access/concept-session-lifetime>

- "The Microsoft Entra ID default configuration for user sign-in frequency is a rolling
  window of 90 days." Microsoft argues frequent prompts "can backfire" (users learn to
  type credentials into malicious prompts), and the default is "don't ask users to
  provide their credentials if the security posture of their sessions hasn't changed";
  revocation on security events instead.

### GitHub

<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/token-expiration-and-revocation>

- "GitHub will automatically revoke an OAuth token or personal access token when the
  token hasn't been used in one year."
- Expired PATs are revoked and cannot be restored; create a new one.
- "User access tokens created by a GitHub App will expire after eight hours by default";
  owners may opt out (discouraged).

<https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens>

- "The user access token expires after eight hours, and the refresh token expires after
  six months."
- "Once you use a refresh token, that refresh token and the old user access token will
  no longer work."

<https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps>

- OAuth apps can opt in to expiring tokens for a sign-in: access token 8 h, "the refresh
  token expires after six months without use." Device flow returns an ordinary access
  token. Limit of ten tokens per user/application/scope.

<https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens>

- Fine-grained PAT: "Infinite lifetimes are allowed but may be blocked by a maximum
  lifetime policy"; default 30 days; `expires_in` URL parameter 1-366 or `none`.

<https://cli.github.com/manual/gh_auth_login>

- Browser or device-code login; token stored in the OS credential store, falling back to
  a plain-text file. No expiry documented.

### Bitwarden (server source, commit 5e68c1e)

<https://github.com/bitwarden/server/blob/5e68c1e65dd5ea476c3a00283b2a2ba575574c1d/src/Identity/IdentityServer/ApiClient.cs>

- `RefreshTokenExpiration = ... TokenExpiration.Sliding` (absolute only if the
  self-hoster sets `ApplyAbsoluteExpirationOnRefreshToken`),
  `RefreshTokenUsage = TokenUsage.ReUse`,
  `AbsoluteRefreshTokenLifetime = config.AbsoluteRefreshTokenLifetimeSeconds ?? 0`.

<https://github.com/bitwarden/server/blob/5e68c1e65dd5ea476c3a00283b2a2ba575574c1d/src/Identity/IdentityServer/StaticClientStore.cs>

- Sliding days per client: Mobile 60, Web 7, Browser 30, Desktop 30, CLI 30; access
  token 3600 s.

<https://docs.duendesoftware.com/identityserver/reference/models/client/>

- Absolute lifetime 0 with Sliding: "refresh tokens only expire after the
  `SlidingRefreshTokenLifetime` has passed." ReUse: "the refresh token handle will stay
  the same when refreshing tokens."
- So a Bitwarden browser extension stays logged in indefinitely as long as it refreshes
  at least once every 30 days; no rotation.

<https://bitwarden.com/help/security-faqs.md>

- Recommends "deauthorize sessions" in web vault account settings to force logout on all
  devices. Community reports (not official) say clients notice within up to one hour,
  consistent with the 1-hour access token:
  <https://community.bitwarden.com/t/log-out-of-all-sessions-doesnt-log-me-out-from-my-mobile-device/7836>

### 1Password

<https://support.1password.com/lost-device/>

- Lost device: regenerate Secret Key, then "Deauthorize Device" from Manage Account;
  other devices are asked for the new Secret Key and account password. No automatic idle
  expiry of device authorization was found in official docs.

### Slack

<https://docs.slack.dev/authentication/using-token-rotation>

- With rotation, the access token "expires every 12 hours"; "Refresh tokens are designed
  to be used once"; the used refresh token "is revoked after a short grace period";
  "Token rotation may not be turned off once it's turned on."

### Tailscale (closest analogue: device enrolled once through a browser login)

<https://tailscale.com/kb/1028/key-expiry>

- "By default, new domains are set with an expiry period of 180 days"; admins may choose
  1-180 days.
- When keys expire, "connections to/from the given endpoint will stop working"; recover
  by re-authenticating (for example `tailscale up --force-reauth`).
- Per-device "Disable Key Expiry"; suggested for "trusted servers", subnet routers and
  hard-to-reach IoT devices.
- Expiry is a fixed period from authentication, not activity-based.

<https://tailscale.com/kb/1068/tags>

- For tagged (non-human, server) devices, "key expiry is disabled by default."

### Syncthing

<https://docs.syncthing.net/dev/device-ids.html>

- Device ID is the SHA-256 of the device's self-signed certificate; no expiry or
  rotation policy is documented. Trust lasts until the device is removed.

### Standards guidance

RFC 9700 (OAuth 2.0 Security BCP), <https://www.rfc-editor.org/rfc/rfc9700.html>

- Section 2.2.2: "Refresh tokens for public clients MUST be sender-constrained or use
  refresh token rotation as described in Section 4.14."
- Section 4.14.2: "Refresh tokens SHOULD expire if the client has been inactive for some
  time"; the period is a server policy. Servers "MAY revoke refresh tokens automatically
  in case of a security event" (password change, logout). With rotation, reuse of an old
  token revokes the active one.
- Note: these rules target OAuth refresh tokens that mint short-lived access tokens.
  Pateat's device credential is a directly presented bearer secret, so the "MUST rotate
  or sender-constrain" rule is guidance by analogy, not a binding requirement.

OWASP OAuth 2.0 Cheat Sheet,
<https://cheatsheetseries.owasp.org/cheatsheets/OAuth2_Cheat_Sheet.html>

- "Refresh tokens should be protected using sender-constraining mechanisms (DPoP or
  mTLS) or refresh token rotation." No lifetime numbers.

OWASP Session Management Cheat Sheet,
<https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html>

- Every session should have an idle timeout and an absolute timeout (example values:
  minutes for idle, 4-8 h absolute). These are for interactive browser sessions, not for
  device or sync credentials; none of the device-credential providers above apply them.

### Pattern summary

- Idle (sliding) expiry is near-universal: Google 6 months, GitHub 1 year (6 months for
  refresh tokens), Microsoft 90 days, Bitwarden 30 days for its browser extension, RFC
  9700 SHOULD.
- No absolute lifetime for long-lived device credentials is the norm (Google, Microsoft
  default, Bitwarden default, GitHub OAuth, 1Password, Syncthing). Tailscale is the
  exception (180 days), and even it disables expiry for servers and tagged devices.
- Rotation shows up where a short-lived access token is minted from a refresh token
  (Microsoft, GitHub Apps, Slack). Bitwarden, whose browser extension is the closest
  product analogue to Pateat, does not rotate.
- Recovery is always an interactive re-login or re-enrollment. Manual revocation exists
  everywhere and takes effect immediately or within one access-token lifetime.

## 2. Chrome Web Store: key.pem in the first upload

Current official docs:

- <https://developer.chrome.com/docs/extensions/reference/manifest/key>: to keep one ID
  during development, "upload it to the Chrome Developer Dashboard without publishing
  it", then Package tab, "View public key", copy it onto one line and put it in manifest
  `"key"`; compare the local ID with the dashboard Item ID. The page does not mention
  key.pem.
- <https://developer.chrome.com/docs/webstore/publish> and
  <https://developer.chrome.com/docs/webstore/update> do not mention key.pem in a zip.
  "Verified CRX Uploads" (update page) is a different feature: it makes future updates
  require a CRX signed with a key you register. The docs do not say it sets or changes
  the item ID.

Legacy official docs:

- Old Chromium-hosted docs, "Uploading a previously packaged extension to the Chrome Web
  Store" (Chromium source at tag 80.0.3987.0, about 2019–2020):
  <https://github.com/chromium/chromium/blob/80.0.3987.0/chrome/common/extensions/docs/templates/articles/packaging.html>.
  Steps: rename the private key to `key.pem`, "Put `key.pem` in the top directory of
  your extension", zip it, and upload. Otherwise "the extension's ID in the Chrome Web
  Store will be different from its ID in the package you created." This section is gone
  from the current developer.chrome.com docs.

Community (not official):

- 2021: <https://groups.google.com/a/chromium.org/g/chromium-extensions/c/x_NBS6_-NKs>
  says to include key.pem on the first deployment only, and that the ID is locked after
  that.
- 2023: <https://groups.google.com/a/chromium.org/g/chromium-extensions/c/Xwcs6XH_1_U>
  says the store ignores manifest `key`, but key.pem in the zip "should preserve the
  id", "unless something's changed recently". No Google staff confirmation.

Conclusion: the store-assigned ID plus the dashboard public key in manifest `key` is the
only currently documented method. Uploading key.pem on the first upload was documented
in the past, was reported working in 2021–2023, and is no longer documented. Whether it
still works in 2026 is unverified. To test it safely, upload a draft that contains
key.pem, check that the dashboard Item ID matches before publishing, and delete the
draft if it does not. Leave key.pem out of all later uploads, and never commit the
private key.

## 3. What was decided

The research recommended idle expiry of 90 days renewed on each authenticated use, no
absolute lifetime and no rotation, with revocation on the management page.
The owner adopted that on 2026-10-11; the current behaviour is recorded in the
architecture's [device enrollment](../architecture.md#device-enrollment) section and
[ADR 0020](../adr/0020-direct-device-pairing.md).

The reasons, from section 1:

- Idle expiry is the one control every surveyed provider and RFC 9700 agree on. It
  removes forgotten devices that were never revoked, and a device that syncs regularly
  never reaches it.
- 90 days matches Microsoft's rolling default and sits between the Bitwarden browser
  extension's 30 days and Google's 6 months. 30 days would expire a laptop left unused
  over a long holiday; 6 to 12 months keeps a stolen but unused credential valid longer
  for no benefit to a single owner.
- No absolute lifetime: an active device would have to pair again periodically, which
  Microsoft argues trains users to accept prompts. Absolute limits mostly compensate for
  credentials that cannot be revoked, and Pateat's are revocable on the server.
- No rotation: it detects replay of a leaked refresh token, but for a single-owner,
  revocable credential the gain is small. It also adds a failure mode: if the MV3
  service worker stops between the server committing a new secret and the extension
  storing it, the device is locked out unless a grace window like Slack's exists. The
  Bitwarden browser extension does not rotate. Revisit with several users, or with a
  non-extractable WebCrypto key for sender-constraining.
