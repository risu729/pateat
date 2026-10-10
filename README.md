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

**Status: local settings preview.** The extension saves local exclusion policies
and next-login account defaults against synthetic demo vault metadata. It requests
local storage access, with no site access or production content scripts. A
health-only Worker, shared contracts, isolated browser probes, CI and opt-in manual
server delivery are implemented. Real vault connections, automatic login,
inference and passkeys are not implemented yet.
No hosted service has been deployed.

See [development](docs/development.md) for installation and checks. The production
extension is built into `apps/extension/.output/chrome-mv3/`; the separate probe
build is for synthetic tests only. Compatibility and unattended passkey support
remain subject to the [acceptance gates](docs/plan.md).

Start with the [documentation index](docs/README.md), then the
[architecture](docs/architecture.md) and [implementation plan](docs/plan.md).
See [AGENTS.md](AGENTS.md) for repository working instructions.
