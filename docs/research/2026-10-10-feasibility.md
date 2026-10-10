# Feasibility and dependency evidence

Observed: 2026-10-10. This is dated research, not a current support matrix.
The documentation PR inspected sources without executing a new extension, paid
inference, deployment, or real-account login. The subsequent foundation work
built a synthetic extension shell and health-only Worker locally; the narrower
implementation evidence below does not establish product compatibility.

## Browser and vault findings

- Locally inspected Chrome use extension code creates inactive tabs and uses
  chrome.debugger/CDP. Locally inspected Bitwarden autofill selected active tabs
  and inserted extension-origin inline-menu frames. These are implementation
  observations, not a controlled end-to-end coexistence test.
- Chrome 154.0.8037.98 source checks child frames when authorizing an extension debugger
  and rejects another extension's URL. Hiding an iframe or placing it inside closed
  Shadow DOM does not remove that origin. The Chrome use runtime inspected still handled
  this error. Therefore avoid this UI pattern; do not claim the old failure is fixed.
  [Chromium source](https://github.com/chromium/chromium/blob/154.0.8037.98/chrome/browser/extensions/api/debugger/debugger_api.cc)
- Native content-script targeting supports explicit tab/frame/document identity.
  Focus-independent addressing is feasible; live/background execution still needs
  lifecycle and user-activation tests.
  [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting),
  [message targeting](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage)
- Bitwarden's Never timeout documents persistent unencrypted local encryption
  key storage. That demonstrates persistent unlock is technically possible, not
  that a browser store is an OS keystore or server login never expires.
  [Bitwarden timeout](https://bitwarden.com/help/vault-timeout/)
- Software-key assertions and UV/UP are distinct questions. Authenticator-data flags
  have normative ceremony semantics; a valid signature alone does not establish that
  verification occurred.
  [WebAuthn authenticator data](https://www.w3.org/TR/webauthn-3/#sctn-authenticator-data)

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
  uses ordinary elements in closed Shadow DOM and a manual popover where available,
  without an extension-origin iframe on this menu path. Its keyboard handling and
  [selection handlers](https://github.com/keepassxreboot/keepassxc-browser/blob/8b0b2c4347126f4983f59ea7dd6ca2a2a667cf48/keepassxc-browser/content/credential-autocomplete.js)
  check `isTrusted`. That rejects page-generated events; it does not prove rejection of
  browser/CDP input or establish human-only approval. Candidates expose title, username
  and group, including tooltip data. Closed Shadow DOM is not a confidentiality
  boundary. The inspected menu lacked ARIA listbox/option semantics, so its
  accessibility should not be copied uncritically.
- [Proton Pass inline UI](https://github.com/ProtonMail/WebClients/blob/02d43d96401eaed7e815d096612840efabdca7e6/applications/pass-extension/src/app/content/services/inline/inline.app.ts)
  embeds an iframe inside its popover shadow root, preserving the frame-origin issue
  above. Its
  [dropdown lifecycle](https://github.com/ProtonMail/WebClients/blob/02d43d96401eaed7e815d096612840efabdca7e6/applications/pass-extension/src/app/content/services/inline/dropdown/dropdown.handler.ts)
  cancels stale openings and closes/cleans up on navigation, anchor and layout changes.
  Its
  [worker](https://github.com/ProtonMail/WebClients/blob/02d43d96401eaed7e815d096612840efabdca7e6/applications/pass-extension/src/app/worker/services/autofill.ts)
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

The
[integrated authenticator documentation](https://bitwarden.com/help/integrated-authenticator/)
and
[upstream TOTP implementation](https://github.com/bitwarden/sdk-internal/blob/main/crates/bitwarden-vault/src/totp.rs)
cover raw Base32 secrets, `otpauth://totp/` parameters, SHA-1/256/512, digits/period,
and `steam://` codes. Preserve the saved format and test vectors; parsing an arbitrary
OTP URI is not evidence of HOTP support. Generating a code from a vault secret is
separate from retrieving email/SMS codes or following a magic link. Those
external-channel flows remain deferred. Upstream `main` links describe the inspected
date, not a pinned future compatibility guarantee.

### Bitwarden transport compatibility baseline

The isolated transport targets the prelogin and encrypted sync routes observed
in server v2026.9.2 at
[`9ee4e0e`](https://github.com/bitwarden/server/tree/9ee4e0ebf502fd1c8bf5c1bbcbc2942c3b66bbcc)
and browser v2026.9.3 at
[`8246ae9`](https://github.com/bitwarden/clients/tree/8246ae9c9a484a0a69f8b27203034555fb872523).
Synthetic response fixtures establish transport handling, not server login,
decryption or complete-vault compatibility.

The pinned server's
[sync filtering](https://github.com/bitwarden/server/blob/9ee4e0ebf502fd1c8bf5c1bbcbc2942c3b66bbcc/src/Api/Vault/Controllers/SyncController.cs#L160-L195)
uses client version and device type to omit unsupported item types and
leasing-gated partial ciphers. This transport does not yet advertise those
capabilities. A valid response envelope therefore cannot establish snapshot
completeness or authorize cache replacement. Before integrating the full adapter,
choose and test truthful protocol capability headers, validate encrypted
records and account ownership, and distinguish partial or unavailable records.
This gate preserves the planned full-sync scope.

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

Initial version observations came from published package metadata. Foundation
work then resolved the following combination in the Bun workspace. Exact pins
remain authoritative in the manifests and lockfiles; passing local tests do not
make beta dependencies stable.

| Package                  | Observed version | Relevant constraint                                                   |
| ------------------------ | ---------------- | --------------------------------------------------------------------- |
| WXT                      | 0.21.4           | Node >=22; explicit MAIN/document_start available                     |
| Valibot                  | 1.5.0            | Direct runtime schema choice; optional official JSON Schema converter |
| TypeScript / shared preset | 6.0.3 / 3.0.0 | `@risu729/tsconfigs` declares peer TypeScript ^6.0.0; 7.0.2 was not retained |
| Vitest                   | 5.0.3            | Node ^22.12, ^24, or >=26                                             |
| Cloudflare Vitest plugin | 1.4.0            | Peer Vitest ^4.1.0 or ^5.0.0                                          |
| cf | 1.0.0-beta.14 | Executes under pinned Node 26.11.1, not Bun |
| Cloudflare Vite plugin | 2.0.0-beta.sha-91c870c02 | Beta typed-config/Build Output path; latest stable 1.63.1 was unsuitable |
| Vite / Miniflare | 8.3.4 / 5.20261006.1-alpha | Production bundle and separate workerd smoke runtime |
| Playwright               | 1.64.0           | Isolated persistent extension-capable Chromium context                |
| Oxlint / Oxfmt           | 1.87.0 / 0.72.0  | Separate type checking still required                                 |

Sources: [WXT](https://registry.npmjs.org/wxt),
[Valibot](https://registry.npmjs.org/valibot),
[Vitest](https://registry.npmjs.org/vitest),
[Workers plugin](https://registry.npmjs.org/@cloudflare/vitest-plugin),
[cf](https://registry.npmjs.org/cf),
[Cloudflare Vite plugin](https://registry.npmjs.org/@cloudflare/vite-plugin),
[shared TypeScript preset](https://registry.npmjs.org/@risu729/tsconfigs),
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
- The
  [Workers testing guide](https://developers.cloudflare.com/workers/testing/vitest-integration/)
  uses @cloudflare/vitest-plugin. The foundation verified its documented test-local
  `main` and `miniflare` options, with compatibility settings imported from
  `cloudflare.config.ts`. It does not rely on `wrangler.configPath` or claim that the
  test plugin itself loads the full typed production configuration. Plugin 1.4.0
  includes transitive Zod and an alpha Miniflare dependency; direct Valibot choice does
  not imply a zero-Zod or entirely stable transitive graph.
- Owner action
  [v2.2.1](https://github.com/risu729/wrangler-deploy-action/releases/tag/v2.2.1)
  resolves to `6a93154ef1c550b760d8582bcf59d8d4a0710788`.
  [Source](https://github.com/risu729/wrangler-deploy-action/blob/6a93154ef1c550b760d8582bcf59d8d4a0710788/src/deploy.sh)
  runs caller-installed cf, consumes prebuilt output and checks exact deployment IDs. It
  does not build, install tooling, or own D1 migrations. No missing capability
  justifying an action PR was found.

### Foundation verification on 2026-10-10

The health-only Worker passed 13 Cloudflare Vitest cases, TypeScript checking with the
shared preset, production cf/Vite build, and cf's credential-free
`--prebuilt --mode production --dry-run`. Build Output was generated at
`services/api/.cloudflare/output/v0/`, with `isPreview: false`, production mode, and no
bindings. A separate Miniflare process consumed the exact emitted Worker bundle and
verified GET health/revision, bodyless HEAD, method rejection and an unimplemented
route. Outbound requests were disallowed in that runtime. This smoke path is separate
from Vitest's transformed source modules. Scoped Oxlint and Oxfmt checks passed.

Two compatibility findings changed the initial setup. cf requires the Vite
plugin to be declared in the service's own manifest for workspace discovery.
The typed-config build path requires the beta plugin rather than the observed
stable 1.63.1. Also, the pinned workerd build rejects compatibility date
`2026-10-10` with `ERR_FUTURE_COMPATIBILITY_DATE`; production and tests therefore
both use its supported `2026-10-06` date. This is a tested runtime constraint,
not a decision to disable compatibility checking.

The Worker only implements `/health`; this work does not verify Access, devices, D1,
tenant isolation, settings/recipes, inference, or hosted readback. The build uses
`PATEAT_REVISION` when supplied and `development` locally otherwise. Deployment
credentials, routing and initial provisioning were not exercised. At head `c24d82a`,
[Linux CI](https://github.com/risu729/pateat/actions/runs/37969704501) passed the full
check graph, including all three Playwright tests: production package permissions, the
installed shell's status/message validation, and the document-start bridge running in an
inactive tab with identity checked across navigation.
[CodeQL](https://github.com/risu729/pateat/actions/runs/37969704219) also passed. The
two Windows browser cases remain blocked before Chromium launch by a missing SideBySide
assembly; Linux success does not resolve that host issue. These isolated synthetic tests
do not establish actual installed Chrome use coexistence, which remains untested.
Complete M1 and deployed service acceptance remain separate gates in
[the plan](../plan.md).

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
include adversarial inputs and option/context sensitivity. Jev performance for these
forms is unmeasured.
[Cloudflare Clef](https://developers.cloudflare.com/workers-ai/models/clef/) is
another decision-model option. The update below expands its evaluation priority
without selecting a provider or enabling fallback.

First prepare sanitized synthetic Japanese/English fixtures without paid calls;
actual provider benchmarks require authorized API access and recorded cost.
Claim support and latency only after the relevant benchmark
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

### Clef update reviewed 2026-10-10

The
[October 9 announcement](https://blog.cloudflare.com/clef-faster-cheaper-multimodal/)
reports faster Clef serving, a lower Clef-flash price with reduced hosted context, and
Clef-omni audio/video support. Cloudflare reports roughly 152 ms median and 351 ms p95
for Clef on roughly 800-token requests. These are vendor measurements, not measured
Pateat latency, login accuracy or evidence that media is needed. Cloudflare describes
Jev API compatibility; Pateat still needs schema, usage and error normalization tests.
Self-hosting open weights is outside initial scope.

Current hosted model documentation lists the following input rates and context
limits; verify them again when implementing pricing and model settings. These
are list rates, not an account invoice or a fixed budget guarantee.

| Model | USD per million input tokens | Context tokens | Planned use |
| --- | --- | --- | --- |
| [Clef-flash](https://developers.cloudflare.com/workers-ai/models/clef-flash/) | 0.038 | 24,576 | Text/structured finite-choice evaluation |
| [Clef](https://developers.cloudflare.com/workers-ai/models/clef/) | 0.24 | 65,536 | Text/structured finite-choice evaluation |
| [Clef-omni](https://developers.cloudflare.com/workers-ai/models/clef-omni/) | 0.15 | 64,000 | Deferred multimodal evaluation |

The documented models have no output-token charge. Their finite-choice API uses
supplied state, questions and options; it does not generate arbitrary recipes.
Worker binding and REST transports are available. The flash documentation warns
that oversized text state may be truncated; cap complete requests, including
questions/options, and abstain on incomplete observations. Omni media also uses
context, so text-only limits must not be reused blindly if media is added later.

The
[input schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-input.json)
and
[output schema](https://developers.cloudflare.com/workers-ai/models/clef-flash/schema-output.json)
describe choice/probability results and input-token usage. Highest-scoring choice is not
native safe abstention: provide an unknown/none option, validate identifiers and
probability shape, and enforce local semantic checks. Missing usage remains unknown
rather than zero cost. No inference call or task-specific benchmark was performed for
this review. The resulting plan evaluates Clef-flash/Clef alongside Jev and keeps
generation/repair, media collection and submission authority separate.

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
An Access login cookie is not a permanent unattended device credential. A separate
revocable device protocol must be paired with compatible route protection; a Pateat
token cannot satisfy an unconditional Access gate by itself. Never package a shared
[Access service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
in the extension. Authentication and client-side encryption-key recovery are separate:
identity alone does not supply an end-to-end encryption key.

Future remote MCP uses the versioned
[authorization specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
and
[Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http),
with human identity, MCP authorization and local vault execution kept separate. MCP is
deferred and must not be required for core autofill. Its candidate operations return
allowed metadata/status or request scoped local execution, never vault secret values.
Cloudflare's
[remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
is an integration reference, not proof that Access supplies the complete MCP
authorization flow.

The
[OpenAI API MCP guide](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
allows `require_approval: never` or tool-specific approval configuration. Thus per-call
human confirmation is not inherent to MCP; this does not establish Dots/Grok UI behavior
or bypass any client's action policy. A synthetic target-client test must verify
authorized autonomous calls before claiming this integration is useful for unattended
operation. No such test was run.

## Early installed-Chrome acceptance, 2026-10-10

At approximately 06:24-06:34 UTC, the owner manually installed the frozen synthetic
probe built from `b96fc146e6d73dcef5fcf969734d67e2bcad04bc`. Its nine artifact hashes
were checked before use. In the owner's existing connected Chrome profile, Pateat
completed multi-page and single-page login, input/change-triggered submission and
input-triggered page advance using loopback-only synthetic credentials. The
controller navigated and observed; it did not fill fields or click login controls.
Fixture-side value matches and POST/click counts verified exactly one intended
submission. Rejection and unknown outcomes did not cause duplicate clicks; a
concurrent tab stayed empty while the original attempt retained ownership, and
ambiguous duplicate fields stayed empty.

A background multi-page run completed with each page's first script recording
hidden and unfocused state before extension execution. This is stronger evidence
than later observer visibility readings. The exact Chrome version and complete
extension inventory were not established. Official Bitwarden coexistence, the
later SDK/setup build, real-account authentication, passkeys, broader frames and
restart behavior in this actual profile remain separate gates. Owned fixture tabs
and servers were closed; the user-installed synthetic probe and settings remained.
