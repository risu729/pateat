# Feasibility and dependency evidence

Observed: 2026-10-10. This is dated research, not a current support matrix.
Sources were inspected; no new extension, paid inference, deployment, or real
account login was executed for the documentation PR.

## Browser and vault findings

- Locally inspected Chrome use extension code creates inactive tabs and uses
  chrome.debugger/CDP. Locally inspected Bitwarden autofill selected active tabs
  and inserted extension-origin inline-menu frames. These are implementation
  observations, not a controlled end-to-end coexistence test.
- Chrome 154.0.8037.98 source checks child frames when authorizing an extension
  debugger and rejects another extension's URL. Hiding an iframe or placing it
  inside closed Shadow DOM does not remove that origin. The Chrome use runtime
  inspected still handled this error. Therefore avoid this UI pattern; do not
  claim the old failure is fixed. [Chromium source](https://github.com/chromium/chromium/blob/154.0.8037.98/chrome/browser/extensions/api/debugger/debugger_api.cc)
- Native content-script targeting supports explicit tab/frame/document identity.
  Focus-independent addressing is feasible; live/background execution still
  needs lifecycle and user-activation tests. [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting),
  [message targeting](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage)
- Bitwarden's Never timeout documents persistent unencrypted local encryption
  key storage. That demonstrates persistent unlock is technically possible, not
  that a browser store is an OS keystore or server login never expires.
  [Bitwarden timeout](https://bitwarden.com/help/vault-timeout/)
- Software-key assertions and UV/UP are distinct questions. Authenticator-data
  flags have normative ceremony semantics; a valid signature alone does not
  establish that verification occurred. [WebAuthn authenticator data](https://www.w3.org/TR/webauthn-3/#sctn-authenticator-data)

### Settings and future inline UI

The installed Enhancer for YouTube 3.0.19 manifest identified its options page.
Opening that `chrome-extension://` URL through the current Chrome use connection
was rejected before page access: only HTTP and HTTPS protocols were allowed.
This verifies that route's URL policy, not a debugger failure inside the options
page. Human use of an extension settings page remains distinct from AI browser
access. Initial Pateat settings are human-operated; inline account choice is
deferred, and neither alternative has passed a Pateat coexistence test.

Read-only inspection of mature upstream projects found useful patterns, not
feature code to copy:

- [KeePassXC-Browser autocomplete](https://github.com/keepassxreboot/keepassxc-browser/blob/8b0b2c4347126f4983f59ea7dd6ca2a2a667cf48/keepassxc-browser/content/autocomplete.js)
  uses ordinary elements in closed Shadow DOM and a manual popover where
  available, without an extension-origin iframe on this menu path. Its keyboard
  handling and [selection handlers](https://github.com/keepassxreboot/keepassxc-browser/blob/8b0b2c4347126f4983f59ea7dd6ca2a2a667cf48/keepassxc-browser/content/credential-autocomplete.js)
  check `isTrusted`. That rejects page-generated events; it does not prove
  rejection of browser/CDP input or establish human-only approval. Candidates
  expose title, username and group, including tooltip data. Closed Shadow DOM is
  not a confidentiality boundary. The inspected menu lacked ARIA listbox/option
  semantics, so its accessibility should not be copied uncritically.
- [Proton Pass inline UI](https://github.com/ProtonMail/WebClients/blob/02d43d96401eaed7e815d096612840efabdca7e6/applications/pass-extension/src/app/content/services/inline/inline.app.ts)
  embeds an iframe inside its popover shadow root, preserving the frame-origin
  issue above. Its [dropdown lifecycle](https://github.com/ProtonMail/WebClients/blob/02d43d96401eaed7e815d096612840efabdca7e6/applications/pass-extension/src/app/content/services/inline/dropdown/dropdown.handler.ts)
  cancels stale openings and closes/cleans up on navigation, anchor and layout
  changes. Its [worker](https://github.com/ProtonMail/WebClients/blob/02d43d96401eaed7e815d096612840efabdca7e6/applications/pass-extension/src/app/worker/services/autofill.ts)
  resolves the focused frame's URL for credential matching. These lifecycle and
  frame-scoping ideas are useful independently of its embedding choice.

For a future Pateat inline UI, the design deduction is iframe-free rendering,
minimal candidate labels, selected-secret retrieval only after worker-side
document/origin/policy checks, and explicit keyboard/accessibility tests.
[WAI-ARIA guidance](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) distinguishes
focus from selection; moving among candidates must not itself fill or submit.

### Provider authentication, vault unlock and OTP

[Bitwarden passkey login](https://bitwarden.com/help/login-with-passkeys/)
distinguishes authentication alone from vault decryption using PRF. Decryption
requires the passkey's vault-encryption option and compatible browser and
authenticator PRF support. A successful provider login therefore does not prove
an unlocked vault. Official-client support also does not establish that an
existing credential works from a custom extension origin; RP ID, origin and
server acceptance remain a future interoperability gate. This provider-login
flow is separate from using a stored site passkey to create an assertion.

The [integrated authenticator documentation](https://bitwarden.com/help/integrated-authenticator/)
and [upstream TOTP implementation](https://github.com/bitwarden/sdk-internal/blob/main/crates/bitwarden-vault/src/totp.rs)
cover raw Base32 secrets, `otpauth://totp/` parameters, SHA-1/256/512,
digits/period, and `steam://` codes. Preserve the saved format and test vectors;
parsing an arbitrary OTP URI is not evidence of HOTP support. Generating a code
from a vault secret is separate from retrieving email/SMS codes or following a
magic link. Those external-channel flows remain deferred. Upstream `main` links
describe the inspected date, not a pinned future compatibility guarantee.

## Similar projects: references only

The owner's later instruction supersedes the earlier reuse proposal: do not
depend on or copy feature code from small similar projects. Implement our own
feature logic with established infrastructure libraries and standards tests.

| Project inspected                                                 | Useful observation                                   | Why it is not our foundation                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------ |
| [Fenko Vault](https://github.com/FenkoHQ/passkey-vault)           | Software WebAuthn mediation can live in an extension | Small project; import is not continuous Bitwarden sync; chooser UI |
| [auto-filler](https://github.com/kalinplus/auto-filler)           | DOM extraction/native setters/AI field matching      | Active-tab selection and actual values in prompts/logs             |
| [Superfill.ai](https://github.com/superfill-ai/superfill.ai)      | DOM verification and submission monitoring           | CDP-first path; active-tab dependency; license scope caveat        |
| [bronzewarden](https://github.com/1jehuang/bronzewarden)          | Small vault protocol implementation                  | Rust/native dependencies; organization/custom-field/passkey gaps   |
| [Boltwarden](https://github.com/vleeuwenmenno/boltwarden)         | WXT passkey MAIN entrypoint                          | Native desktop requirement; Commons Clause                         |
| [Bitwarden Map the Web](https://github.com/bitwarden/map-the-web) | Site field/action selector data                      | Experimental schema and GPL; not a full login state machine        |

The [official internal Bitwarden SDK](https://github.com/bitwarden/sdk-internal)
is not an externally supported stable personal-vault SDK. Browser buildability,
licensing and update coupling would need their own assessment before adoption.
The public Secrets Manager SDK is not a substitute for a personal vault client.

## Maintained tooling observations

Versions below came from published package metadata, not a resolved installation.
Implementation must lock a compatible combination and exercise it.

| Package                  | Observed version | Relevant constraint                                                   |
| ------------------------ | ---------------- | --------------------------------------------------------------------- |
| WXT                      | 0.21.4           | Node >=22; explicit MAIN/document_start available                     |
| Valibot                  | 1.5.0            | Direct runtime schema choice; optional official JSON Schema converter |
| Vitest                   | 5.0.3            | Node ^22.12, ^24, or >=26                                             |
| Cloudflare Vitest plugin | 1.4.0            | Peer Vitest ^4.1.0 or ^5.0.0                                          |
| Playwright               | 1.64.0           | Isolated persistent extension-capable Chromium context                |
| Oxlint / Oxfmt           | 1.87.0 / 0.72.0  | Separate type checking still required                                 |

Sources: [WXT](https://registry.npmjs.org/wxt),
[Valibot](https://registry.npmjs.org/valibot),
[Vitest](https://registry.npmjs.org/vitest),
[Workers plugin](https://registry.npmjs.org/@cloudflare/vitest-plugin),
[Playwright](https://registry.npmjs.org/@playwright/test),
[Oxlint](https://registry.npmjs.org/oxlint),
[Oxfmt](https://registry.npmjs.org/oxfmt).

WXT's [unit-test helper](https://wxt.dev/guide/essentials/unit-testing) provides
mocked extension APIs; it does not prove MV3 behavior. Playwright's
[extension guide](https://playwright.dev/docs/chrome-extensions) uses bundled
Chromium because ordinary Chrome/Edge side-loading flags changed. Installed
Chrome use acceptance remains a separate gate.

Use WebCrypto where it implements the exact needed algorithm. Argon2id remains
a dependency decision: [noble-hashes](https://github.com/paulmillr/noble-hashes)
is maintained, but its historical audit excludes Argon2; do not represent it as
audited by association. [hash-wasm](https://github.com/Daninet/hash-wasm) offers
Argon2 but its last published update observed here was November 2024. Benchmark
bounded vault KDF parameters before choosing. Neither is selected by this PR.
CBOR is deferred until a supported assertion extension or wire format needs it.

## Cloudflare and deployment

- Official [cf](https://developers.cloudflare.com/cf/) is open beta and supports
  [cloudflare.config.ts](https://developers.cloudflare.com/cf/projects/cloudflare-config/).
  Loading it requires Node >=22.18, an ESM package and local cf dependency; Bun
  may install dependencies but must not run cf configuration loading.
- [Project commands](https://developers.cloudflare.com/cf/projects/) and
  [CI guidance](https://developers.cloudflare.com/cf/ci/) document credential-free
  builds and prebuilt dry-run. The output is `.cloudflare/output/v0/` and build
  modes must match deployment.
- [D1 migration mapping](https://developers.cloudflare.com/cf/wrangler/migrate/#d1-migrations)
  uses `cf d1 migrations apply <DATABASE_ID> --dir db/migrations`; remote is the
  default, while `--local` selects local execution. This is evidence for future
  task design, not a command to execute during this PR.
- The [Workers testing guide](https://developers.cloudflare.com/workers/testing/vitest-integration/)
  now uses @cloudflare/vitest-plugin. Its example still uses wrangler.configPath;
  direct typed-config loading is not verified. Probe documented test-local
  Miniflare configuration if necessary without adding production Wrangler files.
  Plugin 1.4.0 includes transitive Zod and an alpha Miniflare dependency; direct
  Valibot choice does not imply a zero-Zod or entirely stable transitive graph.
- Owner action [v2.2.1](https://github.com/risu729/wrangler-deploy-action/releases/tag/v2.2.1)
  resolves to `6a93154ef1c550b760d8582bcf59d8d4a0710788`.
  [Source](https://github.com/risu729/wrangler-deploy-action/blob/6a93154ef1c550b760d8582bcf59d8d4a0710788/src/deploy.sh)
  runs caller-installed cf, consumes prebuilt output and checks exact deployment
  IDs. It does not build, install tooling, or own D1 migrations. No missing
  capability justifying an action PR was found.

## Inference and Anthropic credit

Anthropic's October 7 update introduced
[monthly API credits for Max and Team](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans).
Max 20x can claim $200 into a linked Console organization; these credits are
separate from subscription usage limits and expire by billing cycle. The owner's
actual eligibility, claim, balance, linked organization and spending controls
are not verified. Do not assume either that subscription usage is API credit or
that eligible plans can never include API credit. Do not repurpose session
cookies/tokens as API authentication.

[Claude structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
can propose constrained recipes. Validate semantics, not just JSON shape.
[Jev](https://docs.typesafe.ai/api) offers finite choice, score and probability
decisions, not arbitrary recipe generation. Its
[documented failure modes](https://docs.typesafe.ai/model-jaggedness/jev-1.13)
include adversarial inputs and option/context sensitivity. Jev performance for
these forms is unmeasured. [Cloudflare Clef](https://developers.cloudflare.com/ai/models/%40cf/cloudflare/clef/)
is another decision-model option, not a reason to add a second provider now.

First evaluate sanitized synthetic Japanese/English forms with no paid account
requests required. Claim support and latency only after the relevant benchmark
and integrated acceptance gates pass.

Ordinary [Claude Messages](https://platform.claude.com/docs/en/api/messages/create),
[Jev](https://docs.typesafe.ai/api), and OpenAI response usage documented in the
[prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
report token usage; the inspected schemas do not provide a universal final-price
field. Prefer explicit monetary data where a provider defines it; otherwise
estimate from usage and versioned rates, accounting for cache token categories.
Keep estimates distinct from billed charges. The selected monthly spending
threshold stops subsequent inference after usage accounting; concurrent or
in-flight calls can overshoot it. It is not a hard billing ceiling and must not
disable cached local recipes. No billing reconciliation was tested.

## Optional service authentication and MCP

[Cloudflare Access email OTP](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)
can admit permitted users without their own Cloudflare account or WARP. It must
be explicitly configured; new organizations do not automatically enable it.
Access is the initial service setup/admin identity gate, not a permanent product
dependency or the vault's authentication system. A future alternate identity
provider can replace that gate without moving vault authentication off-device.

[Worker Access identity](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
is available only when Access authenticates the invocation; the documented
context does not propagate over service bindings/RPC or the Static Assets
internal router. Other paths need appropriate
[JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/).
An Access login cookie is not a permanent unattended device credential. A
separate revocable device protocol must be paired with compatible route
protection; a Pateat token cannot satisfy an unconditional Access gate by itself.
Never package a shared [Access service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
in the extension. Authentication and client-side encryption-key recovery are
separate: identity alone does not supply an end-to-end encryption key.

Future remote MCP uses the versioned
[authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
and [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
with human identity, MCP authorization and local vault execution kept separate.
MCP is deferred and must not be required for core autofill. Its candidate
operations return allowed metadata/status or request scoped local execution,
never vault secret values. Cloudflare's
[remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
is an integration reference, not proof that Access supplies the complete MCP
authorization flow.

The [OpenAI API MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
allows `require_approval: never` or tool-specific approval configuration. Thus
per-call human confirmation is not inherent to MCP; this does not establish
Dots/Grok UI behavior or bypass any client's action policy. A synthetic
target-client test must verify authorized autonomous calls before claiming this
integration is useful for unattended operation. No such test was run.
