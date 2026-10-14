# Pateat

Auto Login for Chrome.

A Chrome extension that completes configured login flows using the user's own
Bitwarden vault. **Pateat supports only Bitwarden for the time being**; other vaults
are not planned for now. It covers passwords, custom fields, TOTP and existing software
passkeys. Several Bitwarden connections and site/item/field controls are part of the
initial design.

The extension executes locally, including in background tabs. AI helps identify
form fields and repair reusable login recipes; vault values and signing keys
remain local. WXT, TypeScript and Valibot are the chosen foundation. A minimal
Cloudflare service holds settings and recipes, which are edited on its web UI, and
provides inference. The extension keeps a cached copy, so login continues while the
service is offline.

Initial vault use is read-only. Later scope includes independently permitted
vault writes, provider passkey login, external OTP/magic links and separately
authorized post-login actions. These are planned extension points, not initial
implementation commitments; the [plan](docs/plan.md) defines delivery boundaries.

The name comes from Latin _pateat_: "let it be open."

**Status: in development, not released.** A manual Bitwarden connection syncs the vault,
decrypts it locally with the official OSS SDK and keeps an encrypted cache with optional
automatic unlock across browser restarts; it has connected one real Bitwarden Cloud US
account (V1 keys, PBKDF2; other KDFs, V2 keys and MFA methods are unverified). On HTTPS
sites the extension runs login recipes from the service and asks the service to generate
one with Claude for a login page that has a vault match but no recipe. It signs with
passkeys stored in the vault, which has worked on real sites. The service runs at
`pateat.takuk.me` for the owner. Recipe sync and generation are verified against a local
Worker only, and a password login on a real site has not been verified yet; the
[plan](docs/plan.md) lists the open gates.

See [development](docs/development.md) for installation and checks. The production
extension is built into `apps/extension/.output/chrome-mv3/`; the separate probe
build is for synthetic tests only. Compatibility and unattended passkey support
remain subject to the [acceptance gates](docs/plan.md).

Two protections are not honoured yet. Pateat answers a site's passkey request with
the user presence (UP) and user verification (UV) flags set, although it performs no
presence test or verification of its own
([ADR 0007](docs/adr/0007-existing-passkey-assertions.md#presence-and-verification)). It
also fills, and signs with the passkeys of, Bitwarden items marked with master password
re-prompt without asking for the master password
([vault adapter](docs/architecture.md#vault-adapter)). Both are planned to become
settings before Pateat is public ([plan](docs/plan.md#phase-3-public-release)).

Start with the [documentation index](docs/README.md), then the
[architecture](docs/architecture.md) and [implementation plan](docs/plan.md).
See [AGENTS.md](AGENTS.md) for repository working instructions.
