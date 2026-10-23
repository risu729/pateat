# Pateat

English | [日本語](README.ja.md)

Auto Login for Chrome.

A Chrome extension that completes configured login flows using the user's own
Bitwarden vault. **Pateat supports only Bitwarden for the time being**; other vaults
are not planned for now. It covers passwords, custom fields, TOTP and existing software
passkeys, with several Bitwarden connections and site, item and field controls.

The extension executes locally, including in background tabs. AI identifies form
fields for reusable login recipes and judges unclear sign-in pages; recipe repair is
planned. Vault values and signing keys remain local. WXT, TypeScript and Valibot are the
chosen foundation. A minimal Cloudflare service holds settings and recipes, edited on
its web UI (item and field choices stay on the extension's settings page), and calls
Claude. The extension keeps a cached copy, so login continues while the service is
offline. Its UI is in English and Japanese
([ADR 0043](docs/adr/0043-extension-language-preference.md)), and the toolbar icon shows
how many accounts match the site and how the tab's last login ended
([ADR 0038](docs/adr/0038-login-status-badge.md)).

Initial vault use is read-only. Later scope includes independently permitted
vault writes, provider passkey login, external OTP/magic links and separately
authorized post-login actions. These are planned extension points, not initial
implementation commitments; the [plan](docs/plan.md) defines delivery boundaries.

The name comes from Latin _pateat_: "let it be open."

**Status: in development, not released.** A Bitwarden connection syncs the vault, on
request and every five minutes, decrypts it locally with the official OSS SDK and keeps
an encrypted cache with optional automatic unlock across browser restarts. It has
connected one real Bitwarden Cloud US account (V1 keys, PBKDF2, a new-device code);
other KDFs, V2 keys and two-step methods are unverified on a real account. CI signs in
to the latest Vaultwarden release, the only one supported, with authenticator and email
codes ([ADR 0059](docs/adr/0059-latest-vaultwarden-server.md)). On HTTPS sites, and on
`http:` pages for items saved with an `http://` URI
([ADR 0050](docs/adr/0050-http-pages-for-http-items.md)), the extension runs login
recipes from the service and asks the service to generate one with Claude for a login
page that has a vault match but no recipe. It signs with passkeys stored in the vault.
The service runs at `pateat.takuk.me` for the owner, paired with the owner's Chrome.
Password, custom-field, TOTP and passkey logins, also with generated recipes, have
signed in on real sites; the [plan](docs/plan.md#phase-1-usable) lists them and the
open gates.

See [development](docs/development.md) for installation and checks. The production
extension is built into `apps/extension/.output/chrome-mv3/`; the separate probe
build is for synthetic tests only. Compatibility and unattended passkey support
remain subject to the [acceptance gates](docs/plan.md).

One protection is not honoured yet. Pateat answers a site's passkey request with the
user presence (UP) and user verification (UV) flags set, although it performs no
presence test or verification of its own
([ADR 0007](docs/adr/0007-existing-passkey-assertions.md#presence-and-verification)). It
is planned to become a setting before Pateat is public
([plan](docs/plan.md#phase-3-public-release)). Bitwarden's master password re-prompt is
honoured only on the sites you list: elsewhere Pateat fills, and signs with the passkeys
of, items marked with it without asking for the master password
([vault adapter](docs/architecture.md#vault-adapter)).

The user-facing pages (installation, setup, permissions and a draft privacy policy) are
the docs website in [apps/docs/src](apps/docs/src/index.md), which is not deployed yet.
Start with the [documentation index](docs/README.md), then the
[architecture](docs/architecture.md) and [implementation plan](docs/plan.md).
See [AGENTS.md](AGENTS.md) for repository working instructions, and
[CONTRIBUTING.md](CONTRIBUTING.md) before reporting a bug.
