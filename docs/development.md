# Development workflow

The foundation has a Bun workspace, pinned tools, local policy settings, shared
contracts, and a settings/recipe sync Worker skeleton. A separate localhost probe
exercises the declarative login executor with synthetic values. Manual Bitwarden setup
and local vault caching are implemented, and the settings page can pair with a sync
service; production login activation, settings/recipe sync in the extension and
provider inference remain unimplemented; AI roles are evaluated offline only. M1
is not complete until its required checks and acceptance gates pass.

## Workspace and tasks

The workspace uses one Bun lockfile:

```text
apps/extension/       WXT entrypoints and extension shell
services/api/         Cloudflare Worker sync API and D1 schema
packages/contracts/  Shared Valibot schemas and inferred types
packages/bitwarden/  Provider-specific endpoint and transport boundary
packages/inference/  Offline AI role adapters, synthetic corpus and evaluation harness
tests/extension/      Isolated synthetic browser fixtures and tests
tests/options/        React component tests in isolated Chromium
```

Keep feature code inside its owner until an actual shared boundary warrants
another package. The Drizzle schema in `services/api/src/db/schema.ts` owns the D1
schema; `mise run generate:server-migrations` writes SQL to `services/api/migrations/`
without contacting a database, and the check graph fails if committed migrations drift.

`mise.toml` owns exact tool versions, installation, and task definitions. Use native
workspace mise tasks, not package.json scripts or wrapper scripts that duplicate
the task graph. Bun manages dependencies; pinned supported Node executes tools
that require it, notably cf. Commit mise and Bun lockfiles after resolving them,
never hand-author a purported installed dependency graph.

A development tool used only as a command is a mise tool, not a devDependency: the
TypeScript compiler is `npm:typescript` in `mise.toml`, so `tsc` comes from mise. A
package that code or configuration imports stays in `package.json` even when it also has
a command, as cf (`cloudflare.config.ts`), drizzle-kit (`drizzle.config.ts`), WXT,
Vitest and Playwright do. Each version is pinned in one place only; Bun's version is the
`bun` tool in `mise.toml`, with no `packageManager` field. Bun still installs TypeScript
into its store as a peer of `@risu729/tsconfigs` and an optional peer of WXT and
Valibot; no task uses that copy, and it can lag the mise pin until the Bun lock is
refreshed.

`hk.pkl` imports [risu729/hk-config](https://github.com/risu729/hk-config) at a pinned
release tag. hk provides the single complete check entrypoint,
delegating work to mise. Avoid recursion between hk check and mise checks.

Install the pinned tools and frozen dependencies, then use the complete check
entrypoint:

```sh
mise install
mise run install
mise exec -- hk check --all --no-fail-fast
```

The shared checks include Oxlint, Oxfmt, separate TypeScript checking,
Markdown/TOML/YAML validation, GitHub Actions hygiene, `mise fmt` and
`mise task validate` for `mise.toml`, `hk validate` and Pkl formatting for `hk.pkl`,
and Betterleaks secret scanning. Betterleaks reports only medium- and high-confidence
matches: fixtures, tests and the synthetic corpus are full of low-confidence generic
matches such as `password: "password"`, while vendor token formats (GitHub `ghp_`,
Anthropic `sk-ant-`, Cloudflare API tokens) are medium confidence or higher. A secret
without a vendor prefix, such as a Bitwarden API `client_secret`, only matches the
generic rules and is not reported. CI uses the same task
graph. `mise run fix` applies explicit formatting/lint fixes; the check task must
not mutate source files. Renovate tracks the pinned dependencies and tooling.

Focused tasks are available for diagnosis:

| Task | Purpose |
| --- | --- |
| `mise run prepare:extension` | Generate WXT types |
| `mise run build:extension` | Package the Chrome extension shell |
| `mise run build:probe` | Build the isolated synthetic browser-test variant |
| `mise run render:icons` | Render `apps/extension/icons/*.svg` (listed in `scripts/render-icons.mjs`) into the committed PNG icons (needs `browser:install`) |
| `mise run probe:login` | Serve the synthetic login site on loopback port 3847 |
| `mise run probe:passkeys` | Serve the synthetic passkey relying party on loopback port 3848 |
| `mise run typecheck:extension` | Check extension source after WXT preparation |
| `mise run test:contracts` | Test shared schemas, eligibility and revisioned settings storage |
| `mise run test:bitwarden` | Test provider endpoints and bounded transport with synthetic responses |
| `mise run typecheck:bitwarden` | Check provider source and test types |
| `mise run test:login` | Test login executor sources with synthetic vault results |
| `mise run test:service` | Test sync service pairing and transport with synthetic responses |
| `mise run test:inference` | Score AI role adapters on the synthetic corpus with fake providers |
| `mise run typecheck:inference` | Check AI adapter, corpus and harness types |
| `mise run bench:inference --paid` | Run the paid Claude benchmark on the synthetic corpus; needs `ANTHROPIC_API_KEY` (in cloud sessions, `PATEAT_ANTHROPIC_API_KEY`) and owner approval for each run |
| `mise run test:tools` | Test artifact/provenance helpers |
| `mise run generate:server-migrations` | Generate D1 migration SQL from the Drizzle schema |
| `mise run generate:oidc-key [kid]` | Print a new ES256 key set for the `OIDC_SIGNING_KEYS` Worker secret ([ADR 0015](adr/0015-per-owner-claude-credentials.md)) |
| `mise run check:server-migrations` | Fail when committed migrations differ from the schema |
| `mise run test:server` | Run Worker tests against local Miniflare D1 with committed migrations |
| `mise run build:server` | Generate production Build Output and Worker types |
| `mise run typecheck:server` | Check Worker/config/test types after a server build |
| `mise run check:server-output` | Validate existing production output with cf's prebuilt dry run |
| `mise run check:server-artifact` | Execute that emitted bundle in a fresh local runtime |
| `mise run browser:install` | Install the pinned isolated Chromium browser |
| `mise run test:browser` | Exercise the extension against synthetic local pages |
| `mise run test:options` | Exercise settings components with a synthetic client in Chromium |
| `mise run test:dom` | Extract observations and resolve element locators on synthetic pages in Chromium |
| `mise run typecheck:options` | Check component-test and browser-provider types |
| `mise run check:docs` | Check local documentation links |

On Linux, `mise run browser:install --with-deps` also installs the browser's
system dependencies. Run server build before server type checking and artifact
checks; the latter consume generated files. Set `PATEAT_REVISION` before the build
and artifact check to verify a particular source revision. Without it, local
builds use `development`. The default extension build excludes the test probe;
neither variant grants vault or real-site login capability.

Local success is scoped to the tested component. Worker tests and artifact
checks have passed locally; they do not establish production deployment or
installed Chrome use compatibility. Current evidence and unresolved browser
acceptance results are recorded in [dated research](research/2026-10-10-feasibility.md).

Pass one task to each `mise run` invocation; listing several task names turns the
later names into arguments of the first. To run every static check without the
runtime graph, use `mise exec -- hk check --all --no-fail-fast --skip-step runtime`.

### Windows notes

Quote `git rev-parse 'HEAD^{tree}'` in PowerShell. CI runs `mise run test:browser`
on a GitHub-hosted Windows runner as well as on Linux, so the packaged-extension
tests are expected to pass on Windows with the Playwright-downloaded Chromium. One
local host on 2026-10-10 hit a missing SideBySide assembly ("side-by-side
configuration is incorrect") before launch; it did not reproduce on the CI runner
(see the [foundation progress](plan.md#foundation-progress)), so rely on CI for
those runs. The
Windows job points `TEMP` and `TMP` at the runner's work drive: browser profiles in
the default temp directory on the system drive hit 5-25 s I/O stalls that timed out
random tests. If browser tests time out on a slow local Windows disk, do the same.

### Installed Chrome synthetic login probe

This procedure prepares a manual acceptance run; its availability is not evidence
that installed Chrome or Chrome use has passed. Use only the synthetic probe build.
The probe grants host access only to `http://127.0.0.1/*` so the coordinator can
recheck browser-provided tab URLs. Production grants no host access.

1. Run `mise run build:probe` and `mise run probe:login`. The latter serves only
   `http://127.0.0.1:3847` and stops with Ctrl+C. It does not contact a vault or AI.
2. With the owner's installation approval, load
   `apps/extension/.output/chrome-mv3-probe/` as an unpacked extension in Chrome.
   Record the exact source commit, build, Chrome version and other extensions.
3. Manually open Pateat settings. Add `http://127.0.0.1:3847` as a site default
   for **Demo personal vault / Demo primary account**, then save. Keep the demo
   connection and its branch, username and password fields eligible.
4. Open `http://127.0.0.1:3847/identity` through Chrome use in an inactive tab.
   The extension must fill and advance through the password page itself. Verify
   the fixture's authenticated result, matched-field flags and one click per step.
   Do not fill the fields through the test controller to manufacture success.
5. Close the owner tab before each new attempt. The conservative origin lock
   intentionally prevents another tab from starting even after a terminal result.
   Test `/single`, `/rejection`, `/unknown` and `/ambiguous`; the latter cases
   must stop or abstain without trying another account or repeating submission.
6. Verify site/field exclusion, policy changes, navigation and concurrent Chrome
   use separately. Keep actual observations and unresolved limits in the run's
   evidence. An isolated Playwright pass does not establish these Chrome results.

The fixture exposes synthetic match flags and click counts, not a real account
session. Automated fixtures additionally count POSTs on the local server and can
hold a response to distinguish a delivered request from an observed result.
Probe-only interruption controls pause after durable intent but before delivery,
or after execution but before acknowledgement. Only validated messages from the
extension settings page can configure these controls; web pages cannot. Worker
restart tests reconcile the retained intent without repeating a fill or click.
The probe has no real-provider adapter. Its fixed localhost recipes and
setup messages are excluded from the production build. Chrome use may not be
able to operate another extension's settings page; manual setup is a supported
test prerequisite, not a reason to expose settings mutations to a web page.

### Installed Chrome synthetic passkey probe

This prepares a manual acceptance run of the passkey bridge; it is not evidence
that installed Chrome has passed. The probe build adds passkey scripts for
`http://localhost/*`, where its synthetic source signs only for RP ID `localhost` with
the public WebAuthn Level 3 test-vector key. HTTPS pages get the production bridge and
vault source; automated tests reach them on `https://synthetic.example.test`, which
never resolves, with the probe build's synthetic Bitwarden account. No real vault,
passkey or provider is involved.

1. Run `mise run build:probe` and `mise run probe:passkeys`. The latter listens
   only on loopback `127.0.0.1:3848`, is opened as `http://localhost:3848`, and
   stops with Ctrl+C.
2. With the owner's installation approval, load
   `apps/extension/.output/chrome-mv3-probe/` as an unpacked extension. Record the
   source commit, Chrome version and other extensions, especially any passkey
   provider such as the official Bitwarden extension.
3. Open `http://localhost:3848/`. **Wrapped at document start** must read
   `true`. Another passkey provider's wrapper also reads `true`; only the next
   steps show that Pateat answered.
4. Click **Sign in with a passkey** and **Sign in requiring UV**. Each must report
   `Pateat, flags 0x1d, signature verified` without any browser or provider
   prompt.
5. Open **Request on page load**. Without a gesture it must also report a
   verified Pateat assertion.
6. Open **Permissions Policy denies passkeys** and click the first button. The
   page must report the browser's `NotAllowedError`, not a Pateat assertion.
7. Record whether another installed passkey provider's UI appeared at any step. With
   another provider installed, steps 4 and 5 must still report Pateat assertions without
   that provider's UI. **Another provider wraps later**, **Another provider falls back**
   and **Another provider is locked** add a synthetic provider wrapper to the page for
   runs without one.

### Why a passkey request was delegated

The production build writes one `Pateat passkey request` line per bridged request to its
own service worker console. The console shows only lines written while it is open, so
open it first: turn on **Developer mode** in `chrome://extensions`, click **service
worker** under Pateat, then make the passkey request on the site. Each line holds:

- `origin`, `outcome` (`assertion`, `delegate` or `cancelled`) and the delegate
  `reason`;
- once the request is admitted, `rpId` and `allowCredentials` (how many credential IDs
  the site listed);
- once the vault was searched, `stored` (eligible stored passkeys with that RP ID in
  searched connections; excluded and quarantined items are not counted), `accepted`
  (those the request accepts), `siteDefault` and `siteDefaultAccepted` (the same counts
  for the origin's site default item), `siteDefaultItem` (`unset`, `unresolved` when
  the saved account matches no connection, `not-searched` when the item is ineligible
  or its connection was not searched, or `searched`) and `complete`.

For example, `siteDefault: 1` with `siteDefaultAccepted: 0` means the default item's
passkey is not one the request accepts. No line at all means the request never reached
Pateat's background: the page's options were not ones the bridge copies, another
provider's wrapper did not call Pateat's, or the request came from a subframe. Lines
never hold credential IDs, user handles or item IDs, and the page is never told the
reason. They do name every HTTPS origin that asked, including excluded sites, but only
in this local console.

### Manual Bitwarden setup preview

The connection setup slice is implemented and tested with synthetic responses. Its
options panel selects Bitwarden Cloud US/EU or an ordinary self-hosted HTTPS root and
requests access only to that provider's hosts. Setup is a deliberate user action;
automated tests use synthetic accounts and responses. Do not enter real account
credentials during a test unless that account test has been separately authorized.

The panel submits supported manual verification codes through the same private
setup channel. Email-code delivery initiation and interactive MFA methods are
not implemented by the existing transport. The sync sign-in persists across restarts
as described in [ADR 0008](adr/0008-durable-provider-sessions.md); Sync refreshes it
when needed, and Forget sync sign-in removes it locally without a server logout.
Forget cancels a running Sync but is refused while a password sign-in is in progress.
Offline local-vault restoration is independent of that provider session.

Delete connection, confirmed by a second click, removes one connection from this
device: its sync sign-in, its local vault record with the retained unlock key (after
locking any open vault session), and finally its saved configuration. Like forget, it
is local only: no provider revocation is called, so other sessions stay signed in. It
cancels a running Sync and is refused while a password sign-in for that connection is
in progress. A failed step leaves the connection listed so deletion can be retried.
Saved settings, recipes and their field-policy entries are not modified; anything that
referred to the deleted connection resolves as an unavailable connection. This is how
a connection left over by a failed first sign-in is removed.

Connecting retains the local unlock key and encrypted cache. Disabling automatic
unlock removes the retained key; signing in again does not implicitly re-enable
it. A cancellation or timeout during the durable write can leave an accepted
record even when setup reports an uncertain result. Reload connection status;
explicitly disable automatic unlock if that retained key should be removed.
Compensation removes only a positively identified first-enrollment candidate,
never an unknown or newer record. Connection status and policy metadata contain
no field values. A changed
catalog preserves unsaved policy edits and requires an explicit reload before
saving those stale edits. Custom-field review must confirm the current field
selection before releasing an item whose earlier exclusions cannot be rebound.
Automatic website login is not activated by this setup slice.

## Compatibility before release

Pateat has not been released. Until the first public release, the owner decided on
2026-10-11 that no change keeps backward compatibility with anything an earlier build
wrote or served:

- extension storage: `chrome.storage` keys and record shapes, IndexedDB versions and
  cached vault, session, recipe and settings records;
- the service: older Worker versions, older `/v1/*` request and response shapes, and
  extensions built against them;
- D1 data and schema written by an earlier migration.

The rule covers only what Pateat itself writes and serves. Vault providers are external:
keep every branch for Bitwarden server, account, KDF, key and vault-format versions and
response shapes, such as V1/V2 keys, PascalCase or `null` fields and older ciphers.

Change a format in place and delete the old one; do not add a version branch, a
fallback read, a migration of stored records or an optional field whose only purpose
is older data. Code that exists only for such compatibility is removed. An extension
and a service built from different revisions need not work together, and stored data
from an older build may be discarded, so a reinstall, a new vault connection or a new
pairing is acceptable after an update. Committed D1 migration files are still never
edited after they could have been applied, because cf tracks them by name
([delivery](delivery.md#current-foundation-workflows)). The first public release ends
this rule; compatibility from then on needs its own decision.

## Dependency policy

Renovate inherits the pinned `risu729/renovate-config` preset, matching the other owner
repositories. Its GitHub App covers this repository; scanning the package files starts
after `renovate.json` reaches the default branch. Cloudflare build and test dependencies
are grouped and allow prereleases. `@cloudflare/vite-plugin` versions are
`2.0.0-beta.sha-<commit>`, which semver compares by the hash text, not by release date,
and Renovate has no release-date ordering. It follows the `beta` dist-tag with
`rollbackPrs`: `followTag` alone never offers a tagged beta whose hash sorts below the
current one, while `rollbackPrs` offers it as a rollback update. Rollback updates are
titled as updates but are not automerged. TypeScript, its shared preset and type
packages are grouped so peer requirements can be reviewed together. Updates
still have to pass the repository's required checks.

Renovate tracks the release-tagged hk-config imports through the shared preset. The
typed Cloudflare compatibility date remains reviewed manually: the shared preset's date
managers cover Wrangler TOML/JSON, not this typed configuration. Regenerate and commit
the mise lockfiles whenever tool pins change.

Optimize for reliable behavior and maintainability, not a low dependency count.
An early implementation is not a reason to rebuild established infrastructure.
Check maintenance, security response, license, compatibility, bundle/runtime cost
and the maintenance work displaced. Popularity is supporting evidence, not a
quality guarantee. Prereleases are allowed when their required APIs and upgrade
costs are understood and the compatibility checks pass.

The owner approved React, Tailwind + Base UI + selected shadcn/ui components, TanStack
Form + Valibot, TanStack Query, XState, `@webext-core/messaging`, WXT storage,
Hono, Drizzle, AI SDK with Valibot, Vitest Browser Mode with `vitest-browser-react`,
`@axe-core/playwright`, Knip and fast-check on 2026-10-10. The owner delegated OTP/PSL
selection by maintenance and freshness; that review selected OTPAuth and tldts.
React, Tailwind/Base UI, the selected shadcn/ui Button, TanStack Form/Query,
browser component testing and axe are implemented for the settings UI. The remaining
approved choices enter with their owning features and compatibility checks; approval
does not claim that they are installed. The owner subsequently approved the official
OSS Bitwarden SDK for local cryptography with GPL compliance in
[ADR 0005](adr/0005-bitwarden-local-crypto.md). Further major additions or
replacements still require the owner's decision.
The current manifests and lockfile describe what is installed. WXT + TypeScript +
Valibot remain confirmed choices; existing Vitest, Playwright and build tools remain in
use.

| Area | Choice and integration status | Owning slice |
| --- | --- | --- |
| Extension UI | **Implemented:** React through `@wxt-dev/module-react`, Tailwind CSS through its Vite plugin, Base UI with the selected shadcn/ui Button | M2 settings UI migration |
| Service web UI | **Implemented for the devices page:** React, Tailwind through its Vite plugin, Base UI with the selected shadcn/ui Button and TanStack Query, built by Vite into Worker static assets; **approved:** TanStack Form | M4 owner web UI |
| Form state | **Implemented:** TanStack Form with Valibot through Standard Schema | M2 settings validation, dirty drafts and field errors |
| Async UI state | **Implemented for settings:** TanStack Query for metadata reads and mutations | M2 extension-message queries; M4 sync integration |
| Attempt lifecycle | **Implemented in the local probe:** XState with application-owned login transitions, guards and recovery | M2 declarative executor |
| Transport | **Approved:** `@webext-core/messaging` around validated contracts | M2 message transport |
| Storage | **Approved:** WXT storage helpers | M2 persistence integration |
| Destination matching | **Selected under delegated authority:** WHATWG URL plus tldts for public/private suffix information | M3 URI matching; M5 RP ID validation |
| Crypto and OTP | **Approved:** official OSS Bitwarden SDK for local crypto with GPL compliance; **selected under delegated authority:** OTPAuth | M3 Bitwarden adapter; strict format and browser compatibility gates |
| Service and database | **Approved; implemented for sync:** Hono with Valibot validation and Drizzle for D1, with drizzle-kit (part of the Drizzle approval) generating migrations | M4 enrollment, sync and schema |
| Inference transport | **Implemented offline:** AI SDK with `@ai-sdk/valibot` for generation and the SDK's experimental decision contract for finite choice; **approved:** `@ai-sdk/anthropic` for Claude generation ([ADR 0014](adr/0014-claude-generation-provider.md)); per-owner Workload Identity Federation with `hono/utils/jwt` signing, a Valibot-checked `fetch` exchange and `authToken`, no added dependency ([ADR 0015](adr/0015-per-owner-claude-credentials.md)) | M4 service route |
| Unit/runtime tests | Existing Vitest and Cloudflare Vitest plugin; **approved:** fast-check for policy/state invariants | M2 onward |
| Component tests | **Implemented:** Vitest Browser Mode with `vitest-browser-react` | M2 React migration |
| Integration/accessibility | Existing Playwright; **implemented for settings:** `@axe-core/playwright` | M2 settings and executor fixtures |
| Static checks | Existing Oxlint/Oxfmt and TypeScript with applicable React/JSX accessibility rules; **approved:** Knip | M2 React migration |
| Server configuration | Existing cf with cloudflare.config.ts and Vite | Retain verified build path |

### Integration conditions (pending candidates remain conditional)

React belongs in manually opened extension pages and the service's owner web UI.
Keep content scripts and the MV3 worker independent of UI rendering, and do not
introduce automatic page UI.
Base UI provides accessible primitives; shadcn/ui source becomes code we own and
must review for updates. Compile Tailwind locally. Keyboard/focus tests remain
necessary. The owner selected TanStack Form for typed composition and native
Standard Schema support after considering React Hook Form with its Valibot resolver.
Do not install a second form-state layer alongside it.

Form drafts, Query caches and authoritative settings have different lifetimes.
Keep dirty drafts separate from query refreshes, preserve revision conflicts,
and update the metadata cache after successful writes. Query caches must not contain
vault values, unlock material or provider secrets. Explicitly configure retry,
staleness and refetch behavior; a focus/reconnect event must never replay login
or silently discard an edit. The extension worker remains the settings authority.

Use XState for lifecycle machinery, but own the login semantics, permission
guards, attempt limits and reconciliation. Persist only allowlisted resumable
metadata. Restoring an invoked actor can restart its work: never restore directly
into a submit invocation. Resume through observation and outcome reconciliation.
Do not put secrets in machine context, events, snapshots, inspectors or logs.

WXT helpers and typed messaging do not replace Valibot validation, browser-sender
authorization or tab/frame/document checks. Initialize trusted-only storage access
before item definitions/migrations can access sensitive settings. Preserve
single-writer revision checks, corruption handling and fail-closed policy;
storage helpers do not provide compare-and-swap by themselves.

Parse destinations with `new URL()` and pass the normalized hostname to tldts;
explicitly include private suffix rules where appropriate. PSL information is
not permission to fill or sign, and does not replace HTTPS, origin, ancestor or
Permissions Policy checks. OTPAuth covers standard OTP mechanics; test Bitwarden
Steam compatibility separately and do not advertise HOTP merely because parsing
supports it. Evaluate `@scure/base`, `@noble/hashes` and `cbor-x` for actual protocol
gaps. Do not write crypto/CBOR primitives ourselves, assume all primitives in a
package are audited, or substitute a different KDF for Bitwarden Argon2id.

Use the approved Hono and Drizzle for the first substantive service routes and
schema. Verify generated SQL/migrations, explicit owner predicates, conditional
revision writes and D1 batch behavior; an ORM does not supply authorization or
cross-request atomicity. Use Valibot at application boundaries, including the
chosen Hono/Drizzle integrations; transitive Zod does not change that decision.

AI SDK is transport/structured-output infrastructure, not an autonomous agent
loop. Keep generation and finite-choice contracts distinct; use a direct typed
provider adapter when that API is not represented faithfully by the SDK. Set
retry/timeout limits explicitly and account for every attempt. Disable raw
input/output/header telemetry and sanitize errors. No automatic model/provider
fallback is introduced by a library.

`packages/inference` passes configured model instances only; a model ID string would
resolve through the SDK's global default provider and is rejected. The finite-choice
role uses `experimental_decide` from the approved AI SDK (no added dependency or
provider); its contract may change in patch releases, so the
`ai` version stays exact and its tests guard answer validation. A Clef or Jev adapter
implements that `doDecide` contract or replaces it with a direct typed adapter if the
contract loses provider semantics. `createClaudeGenerationModel` passes the key
explicitly and pins the API host, so `ANTHROPIC_API_KEY` and `ANTHROPIC_BASE_URL` in
the environment are never read by the adapter. `@ai-sdk/anthropic` stays exact and
version-matched to `ai`.

Use the approved fast-check for invariants such as stronger exclusions never expanding
eligibility and stale events never authorizing a new document. Component tests
cover drafts, conflicts, validation and keyboard behavior; Playwright covers real
extension boundaries and lifecycle. Automated accessibility checks supplement
manual keyboard/focus inspection. Browser component tests do not establish
extension API or MV3 lifecycle behavior. Knip must understand WXT-generated entrypoints
before treating reported unused files as removable.

We continue to implement domain behavior independently, without copying feature
code from Fenko, auto-filler, Superfill, Boltwarden or bronzewarden. Extra global
state stores, routing systems or agent frameworks need a distinct responsibility
instead of duplicating tools the owner selects. Exact pins are established in each
implementation PR, with peer, MV3 CSP and bundled-output checks. See
[ADR 0004](adr/0004-library-composition.md) for the approved composition and its
sources.

The settings form owns its draft separately from the metadata query cache.
Queries never refetch on focus/reconnect and neither reads nor saves automatically
retry. Only an explicit successful reload replaces edits after a failed save or
revision conflict. A failed or ambiguous save retains the draft, and an unknown
outcome blocks saving until reload. The background worker remains the settings
authority and validates both messages and senders; the UI migration does not
change storage permissions. Component tests use a synthetic client; extension
tests separately cover real runtime messaging and trusted storage. Accessibility
checks combine axe with keyboard/focus scenarios, not a full compliance claim.

The Worker uses the pinned beta Cloudflare Vite plugin required by cf's typed
configuration and Build Output workflow. Its manifest declares that plugin
explicitly so cf can discover the build framework inside the workspace. Tests
use the Cloudflare Vitest plugin with test-local Miniflare options derived from
the production compatibility settings; no production Wrangler TOML/JSON exists.
The shared TypeScript preset currently declares TypeScript 6 compatibility, so
the workspace pins TypeScript 6 rather than upgrading it independently to 7.

Reference versions and compatibility findings live in
[dated research](research/2026-10-10-feasibility.md); exact implementation pins
belong in lockfiles/configuration. Dependency upgrades run the same behavioral
tests, especially injection timing and Workers test-runtime compatibility.
