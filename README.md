# Pateat

Auto Login for Chrome.

A planned Chrome extension that completes configured login flows using the
user's existing vault. Bitwarden is the first integration; the design is
vault-neutral and covers passwords, custom fields, TOTP, and existing software
passkeys. Human-operated settings, multiple vault connections and site/item/field
controls are part of the initial design.

The extension executes locally, including in background tabs. AI helps identify
form fields and repair reusable login recipes; vault values and signing keys
remain local. WXT, TypeScript and Valibot are the chosen foundation. A minimal
Cloudflare service is planned for private settings/recipe synchronization and
inference. The local core and cached recipes work independently of that service.

Initial vault use is read-only. Later scope includes independently permitted
vault writes, provider passkey login, external OTP/magic links and separately
authorized post-login actions. These are planned extension points, not initial
implementation commitments; the [plan](docs/plan.md) defines delivery boundaries.

The name comes from Latin _pateat_: "let it be open."

**Status: documentation only.** There is no installable extension, configured CI,
backend or deployment. Compatibility and unattended passkey support remain
subject to the [acceptance gates](docs/plan.md).

Start with the [documentation index](docs/README.md), then the
[architecture](docs/architecture.md) and [implementation plan](docs/plan.md).
See [AGENTS.md](AGENTS.md) for repository working instructions.
