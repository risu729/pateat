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
