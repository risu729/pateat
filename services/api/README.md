# API

This Worker is the optional private settings/recipe sync service with device pairing,
deployed at `pateat.takuk.me` and released automatically from main
([delivery](../../docs/delivery.md)). It has no vault implementation. It generates
recipes with the owner's own Claude credentials
([recipe generation](#recipe-generation)). The `pateat` D1 database was bootstrapped on
2026-10-11, and `cloudflare.config.ts` records its ID. cf deploy provisions declared
bindings that lack an ID, so the release artifact refuses a build without one; a routine
release never creates the database implicitly. The release applies the committed
migrations to that database before activation
([delivery](../../docs/delivery.md)).

## Routes

All responses carry `Cache-Control: no-store` and `nosniff`; no route sends CORS
headers. API routes answer JSON, and owner pages answer script-free HTML that cannot be
framed. Contracts live in `packages/contracts/src/sync.ts`, `pairing.ts` and
`generation.ts`.

| Route | Purpose |
| --- | --- |
| `GET`/`HEAD /health` | Build revision probe; other methods return 405 |
| `GET /.well-known/openid-configuration` | OIDC discovery for Claude Workload Identity Federation |
| `GET /.well-known/jwks.json` | Public halves of the issuer's ES256 keys |
| `GET /v1/settings` | Current synced settings; revision 0 with `settings: null` before the first write |
| `PUT /v1/settings` | Replace settings when `expectedRevision` matches; otherwise 409 with the current state |
| `GET /v1/recipes?after=&limit=` | Latest state of recipes changed after the cursor, at most 100 per page |
| `PUT /v1/recipes/:recipeId` | Publish an active revision or a tombstone when `expectedRevision` matches |
| `POST /v1/recipes/generate` | Generate or extend this origin's recipe from one login page observation |
| `POST /v1/recipes/:recipeId/completion` | Judge the page after a recipe's final submission and learn its completion |
| `GET /v1/device` | The calling device's paired time, the owner's live recipe count and settings revision, and whether recipe generation would run now, for the diagnostics page |
| `DELETE /v1/device` | Revoke the calling device's own credential |
| `POST /pair` | Create a device for the signed-in owner from an allowed extension; 201 with the credential, once |
| `GET /pair/signed-in` | The page the extension opens when pairing needs a sign-in; it asks the user to go back to Pateat's settings |
| `GET /manage`, `/manage/sites`, `/manage/sites/:scheme/:host` | Owner web UI (React app): devices; the sites list with excluded sites and revoked recipes; one origin's default account, recipes and bindings |
| `GET /manage/assets/*` | The web UI's built script, styles and notices |
| `GET /manage/api/devices` | The owner's devices with their last use, newest first |
| `POST /manage/api/devices/:deviceId/revoke` | Revoke one of the owner's devices; 204 |
| `GET /manage/api/settings` | The settings `/v1/settings` serves; revision 0 before the first write; 404 `not_paired` without a paired device |
| `PUT /manage/api/settings` | Replace them like `PUT /v1/settings`; `connections` must be empty and the document at most 120 KiB |
| `GET /manage/api/recipes` | Every recipe head with its document, most recently changed first |
| `POST /manage/api/recipes/:recipeId/revoke` | Revoke one recipe if `expectedRevision` is its head; otherwise 409 with the current head |
| `GET /manage/claude` | Access page showing the Console values and the owner's WIF identifiers |
| `POST /manage/claude` | Save the owner's four WIF identifiers |
| `POST /manage/claude/test` | Exchange one assertion and show only the outcome, never the token |

`/v1` routes require `Authorization: Bearer pateat_device_…`. The Worker stores only the
SHA-256 digest of each 256-bit device credential and derives the owner from it; paths
and bodies never name an owner. Unknown credentials return 401 `unauthorized`, revoked
ones 401 `device_revoked` and ones unused for 90 days 401 `device_expired`, before any
body is read. Each accepted request renews the device's `last_used_at`, at most once a
day; migration 0007 started existing devices at their pairing time. Bodies must be
`application/json` and at most 128 KiB. Synced settings are server-readable policy
metadata; device-local field policies, vault values and provider sessions are rejected
by the strict schemas. Stored documents are revalidated on read and fail closed with a
500 `internal_error`.

One Cloudflare Access application covers the whole host, and a more specific Bypass
application exempts `/v1/*`, `/health`, `/.well-known/openid-configuration` and
`/.well-known/jwks.json`, which clients call without an Access login. For `/pair` and
`/manage`, the Worker verifies the `Cf-Access-Jwt-Assertion` itself against the team's
keys, the `ACCESS_TEAM_DOMAIN` issuer and the `ACCESS_AUD` audience. Without both
secrets those routes answer 503. `POST /pair` and `GET /pair/signed-in` also accept the
`ACCESS_PAIR_AUD` audience of the "pateat pair" Access application, which admits
browsers without WARP to pairing only
([ADR 0030](../../docs/adr/0030-pairing-without-warp.md)). An empty value turns it off
only while that application does not exist. The owner is found by token issuer and
subject, never by email. The
[pairing design](../../docs/architecture.md#device-enrollment) describes the flow.

`POST /pair` is direct pairing
([ADR 0020](../../docs/adr/0020-direct-device-pairing.md)). The extension's background
sends `{ "version": 1, "label": "…" }` with the browser's login session. The Worker
checks, in this order, the Access token, the `Origin`, the rate limit and then the body;
it creates the owner on an identity's first pairing, stores only the credential's
SHA-256 and answers 201 `{ version: 1, deviceId, credential }`. `Origin` must equal
`chrome-extension://<id>` exactly for an ID in `PAIRING_EXTENSION_IDS`, a JSON array
committed in `cloudflare.config.ts` (Pateat's own production ID; a self-hosted extension
build with its own key lists its ID instead). It is not a secret. The `PAIR_LIMITER`
binding allows about 10 pairings a minute per verified identity (issuer and subject).
The body must be `application/json` and at most 4 KiB. No CORS headers are sent, so an
`OPTIONS` preflight gets 405 and no web page can read a response; extension contexts
with host access skip CORS. Errors are `{ "error": code }`:

| Status | Code | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Malformed JSON, an invalid label, an unknown field or another version |
| 401 | `unauthorized` | No Access token: sign in to the service first |
| 403 | `forbidden` | The Access token failed verification |
| 403 | `extension_not_allowed` | `Origin` is not a listed extension |
| 405 | `method_not_allowed` | Any method but `POST`, with `Allow: POST` |
| 413 | `payload_too_large` | The body exceeds 4 KiB |
| 415 | `unsupported_media_type` | The body is not `application/json` |
| 429 | `rate_limited` | Too many pairings by this identity, with `Retry-After: 60` |
| 500 | `internal_error` | An unexpected failure |
| 503 | `access_unavailable` | The Access secrets are missing or invalid |
| 503 | `pairing_unavailable` | `PAIRING_EXTENSION_IDS` is missing, empty or malformed |

Without an Access session, Access itself redirects to its login or answers with its own
page before the Worker runs. The extension treats a redirect, a response that is
not JSON and `401` as "sign in first" (ADR 0020).

The web UI is built from `web/` (entry `manage/index.html`) into the Worker's static
assets under `/manage`. Every request runs the Worker first, so no built file is served
before the Access check; the Worker serves the app only at its page paths and its
assets, all with a Content Security Policy that allows only this origin's scripts and no
framing. `/manage/api` answers with JSON and its contracts are in
`packages/contracts/src/manage.ts`; failures are `unauthorized` (no token), `forbidden`
(a token that fails verification, or a state-changing request without this origin's
`Origin`) and `access_unavailable` (no Access configuration). An identity that never
approved a pairing has no owner and sees no data; its settings requests answer 404
`not_paired`. Settings and recipe revisions written here record no device as their
writer. The bundle includes GPL-3.0-only `packages/contracts` code; each page links its
source and the GPL text at the built commit, and the third-party notices served with it
(`public/manage/assets/notices.md` and the build's `licenses.md`).

Recipe revisions are immutable. A write claims the head with a conditional statement
and writes the history row in the same D1 batch, guarded by a per-request write ID,
so a losing writer changes nothing. Each head write takes the owner's next sequence
number; clients sync by passing the last `cursor` back as `after`. A tombstone keeps
its revision, and only an explicit later write can republish the recipe.

[Per-owner limits](../../docs/architecture.md#service-limits) live in `src/limits.ts`
and the shared recipe byte constants in `@pateat/contracts`. The `OWNER_LIMITER` binding
allows 120 requests a minute per owner on `/v1` and per Access identity on
`/manage/api`, checked before any body is read; over it, 429 `rate_limited` with
`Retry-After: 60`. An owner holds at most 1,000 active recipes: a write that would add
one more answers 409 `recipe_limit`. Active head documents also share a 1.5 MiB UTF-8
byte cap, checked in the claim statement itself on creation, republishing or a growing
update. Equal and shrinking updates and revocations always pass; tombstones and
historical revisions do not count. The shared device cache limit is 2 MiB, leaving
margin for its envelope. A page of new recipes can still overflow a device holding
older large revisions even when shrinking updates are already on later feed pages.
The cursor stays unchanged, so retries of that feed repeat the additions page and can
remain blocked indefinitely without a further service change or cache reset that lets
it fit. The same batch deletes revisions older than the newest 10, and every earlier
revision when the write revokes the recipe.

## Claude credentials

[ADR 0015](../../docs/adr/0015-per-owner-claude-credentials.md) gives each owner their
own Claude credentials. `src/claude/` holds the only path from an owner to a credential:

- The Worker is an OIDC issuer. `OIDC_ISSUER` is its public origin, such as
  `https://pateat.example.com` (HTTPS, no port, path or IP literal), and
  `OIDC_SIGNING_KEYS` is `{ "signingKeyId": "2026-10", "keys": [<private ES256 JWK>] }`.
  `mise run generate:oidc-key [kid]` prints a new value; send it straight to the
  Worker secret. Every listed key is published in the JWKS without `d`, and only
  `signingKeyId` signs. To rotate, add the new key, wait at least 15 minutes, switch
  `signingKeyId`, and remove the old key after five more minutes. Without valid
  settings both `/.well-known` routes answer 503 and nothing is signed.
- The `inference_credentials` table holds one row per owner with kind `wif` and the
  identifiers of the owner's own federation rule: `fdrl_…`, the organization UUID,
  `svac_…` and `wrkspc_…`. None is a secret. The owner enters them on
  `/manage/claude`, a temporary script-free page that the React web UI will replace.
  It applies its own Access, same-origin and body-size checks; no app-wide `/manage`
  middleware covers it. Its test button only
  exchanges a token, which calls no model and costs nothing.
- `resolveClaudeCredential(env, ownerId)` signs a fresh assertion
  `{ iss, sub: "owner:<ownerId>", aud: "https://api.anthropic.com", iat, nbf, exp, jti }`
  that lasts five minutes. It exchanges the assertion once at
  `https://api.anthropic.com/v1/oauth/token` and returns `{ authToken }` for
  `createClaudeGenerationModel`. The `ownerId` must come from the authenticated request
  scope. Anthropic answers every denied assertion with the same 401, so the reason is
  only visible in the owner's Console authentication history.

In the owner's Claude Console (Settings → Workload identity → Connect workload →
Custom OIDC), the issuer URL is `OIDC_ISSUER`, with discovery. The federation rule
matches `subject_prefix` `owner:<ownerId>` exactly, may also match audience
`https://api.anthropic.com`, and should use the `workspace:inference` scope where the
Console offers it. On 2026-10-11 the Connect workload wizard offered only
`workspace:developer` and `org:admin`, so the owner's rule uses `workspace:developer`
with the wizard's 600-second token lifetime. That scope also allows Files, Skills and
Managed Agents in the rule's workspace; Pateat calls only the Messages API, and each
exchanged token serves one call and is then discarded. `/manage/claude` shows the saved
identifiers.

## Recipe generation

[ADR 0018](../../docs/adr/0018-recipe-generation-route.md) routes, in
`src/recipes/generate.ts`. Both answer 200 with a `status`: `recipe` or `signed-in`
with the stored change, `abstained`, `rejected`, `challenge` or `unclear`, `failed` with
a code, or `unavailable` with a reason when no model was called. A generation that fails
`invalid-output` because a check refused the model's output also names it as
`rejection`, in codes only: `{ check: "json" }` for output that was not JSON,
`{ check: "schema", issue, path }` for the first issue of the output format (such as
`max-length` at `result.alternatives`; `unknown-key` where the model added a key, with
the path ending before it), or `{ check: "plan", reason }` with the plan check's code
(such as `incompatible-role`).

- `POST /v1/recipes/generate` takes `{ version: 1, observation, slots, base? }`. Each
  origin and start path has one generated recipe, `gen-` and the first 32 hex digits of
  the SHA-256 of the JSON `[origin, path]`; a page without `base` is the start of its
  own. Without `base`, an active recipe is returned as is; with `base`, the page's steps
  are appended after the recipe's last `advance` step. A stale `base` gets the current
  recipe back, a `base` whose recipe is revoked answers `recipe-revoked` while the
  revoked recipe's start page is generated again as the revision after its tombstone, a
  `base` whose recipe was not generated for this origin and its start path answers
  `recipe-conflict`. A first page needs room under the active recipe count limit;
  every generated page, including continuations and entry pages, needs at least 32 KiB
  of byte room before the model call. A refused write after the call also answers
  `recipe-limit`. A judge write refused for bytes keeps the page's answer
  (`challenge`, or `signed-in` once the recipe has a marker or the page is on another
  origin of the site) and is logged; only a first marker on the recipe's own origin
  refused for bytes answers `recipe-limit`. A `base` that is not a
  generated recipe ID is 400. The model maps the
  slots, the plan is checked with `validatePagePlan`, and the steps are stored with a
  conditional write. Up to 20 slots are accepted; a slot with a `fieldName` (and
  `fieldPosition` for a duplicate name) is a custom-field offer, and each offer names a
  different field ([ADR 0027](../../docs/adr/0027-per-account-login-routes.md)). The
  model gives each offer it uses a generic ID in lowercase words, such as
  `branch-number`, which the steps store instead of the request's slot ID. The answer
  that wrote the recipe adds `customSlots: [{ slot, offered }]` for those slots; an
  answer with a recipe another request stored has none. On a continuation, a generic ID
  the `base` recipe already uses answers `failed` with `recipe-invalid`. A start page
  that offers several identifier sets (such as branch and account numbers, or a contract
  number) may get up to 3 `alternatives`, each with its own `slots` and `steps`, stored
  as further variants of the recipe's `password` route; the top-level `slots` and
  `steps` are its first variant. Each variant fills exactly its slots, starts on the
  start path and submits, so a recipe with alternatives is never continued. No element
  is filled as different slots in different variants, and no two variants fill the same
  elements. A continuation's answer has its alternatives dropped before assembly.
  `customSlots` covers the custom slots of every variant, and the request log records
  the alternatives with the plan. The answer may also name the start page's passkey
  sign-in button (`passkeyButton`); a candidate with the button role whose label or
  locator names a passkey or security key, not named like a registration and not used by
  any set or the account switch is stored as the recipe's `passkey` route, any other is
  dropped without failing the call, and a continuation's is ignored. The request log
  records the kept button.
- `POST /v1/recipes/generate` also takes `{ version: 1, observation }` without `slots`:
  an entry request ([ADR 0031](../../docs/adr/0031-sign-in-entry-pages.md)) for a page
  without a login form, whose observation has no fill candidate and no `accounts`, and
  which has no other key, such as `base` or `branch` (400 otherwise). Its instructions
  are the generation role's plus one entry line, which no request with slots gets, and
  the model answers `{ "result": { "decision": "entry", "entry": "c2" } }` or abstains.
  The plan check accepts `entry` only for such a request and only for a `link` candidate
  whose label and locator value hold no `@`, `[email]`, `[masked]`, `[number]` or run of
  four digits, the rule of a chooser's `other` button (`account-text`); otherwise the
  call fails `invalid-output` with `unexpected-entry` (a request with slots),
  `unexpected-plan` or `unexpected-account-list` (an entry request answered with a plan
  or an account list), `unknown-candidate` or `incompatible-role`. The answer is stored
  as the generated recipe of the page's origin and path,
  `{ version: 1, id, revision, origin, entry: { path, target } }` with the candidate's
  locator, and returned as `recipe`; an active entry recipe there is returned as is, and
  a login or chooser recipe there answers `recipe-conflict`, as a form request does when
  an entry or chooser recipe starts on its path or is its `base`. The retry window,
  attempt row, spend limits, request log and revocation apply as for a first page; the
  log row has the entry request's own prompt version and records `{ entry }` with the
  candidate ID.
- `POST /v1/recipes/:recipeId/completion` takes
  `{ version: 1, revision, route, observation, partial?, stop? }` for a page an effect
  step of that revision led to, on the recipe's origin
  ([ADR 0027](../../docs/adr/0027-per-account-login-routes.md)) or on another HTTPS
  origin that a `password` login's tab moved to: of its registrable domain, or, right
  after a second factor (a TOTP code, or a passkey answered after the password), of any
  site; the service cannot see the second factor, so the extension decides when to send
  such a page ([ADR 0022](../../docs/adr/0022-login-attempts-per-tab-and-origin.md); an
  origin that is not HTTPS or is a bare public suffix, or another origin on another
  route, answers 400). On that other origin the recipe's paths are not compared with the
  page, only markers learned there count, a `signed-in` marker is stored with that
  `origin` (or, when it cannot be learned, the answer is still `signed-in`), and a
  `challenge` adds no handler. `partial: true` says the description left out a disabled
  field that may not be a sign-in field
  ([ADR 0029](../../docs/adr/0029-local-sign-in-state.md)). Another revision, or a route
  the stored recipe lacks, answers `recipe-conflict`. The request never names a
  `password` variant. On the `passkey` route, a page that shows a fill field of any
  `password` variant on any path, or its button on its path or a `password` route path,
  answers `not-judgeable`, and its path and every `password` route path are login paths.
  A page that shows one of the route's fill fields, of any variant (on any path), or the
  completion marker answers `not-judgeable` before any model call. The login paths are
  the step paths of every variant of the route and the recipe's handler paths, from the
  stored recipe. A `signed-in` marker passes `addCompletion` and is stored as
  `completion` in the next revision; with a completion already stored, the answer is
  `signed-in` without a change. A `challenge` verdict that names a security-key or
  passkey button passes `addHandler` (a button of the page, not one that registers,
  adds, sets up, turns on or manages a passkey, not a step, switch, rejection or
  completion target, one handler per kind and path) and is stored as a `passkey` handler
  in the next revision. A `challenge` verdict that names a code the page does not say
  was sent to the person or comes from another source (from an authenticator app, or
  with no source said; ADR 0027, 2026-10-13), in the only input of its form the TOTP
  fill rule accepts (not limited below 6 characters) with a button of that form, passes
  `addHandler` too (a field and button of the page, the field not one a route fills or
  another handler's, the button not a field the route fills, the `passkey` route's
  button, a switch, rejection, completion or other handler target) and is stored as a
  `totp` handler; a code sent to the person or from another source stores nothing. Both
  handlers of one page land in the same next revision, and the answer carries it as
  `change`. The kept and dropped handler kinds, with the reason a handler was dropped,
  are logged without elements or values. A code the model named but the judge's own
  checks refused (its source or the TOTP fill rule, before `addHandler`) is logged the
  same way, and its request log's result carries why as `totpDropped`: its source when
  the page says it was sent to the person or names another source (`source-sms`,
  `source-email`, `source-other`), `unknown-field` or `unknown-submit` for an ID that is
  no element of the page, or `not-input`, `text-locator`, `not-code-field`,
  `code-too-short`, `several-code-fields`, `submit-not-button`, `submit-other-form` or
  `href-locator` (an element located by a link's path, which only a marker may be). A
  `signed-in` marker on a `totp` handler's path that shows its code field fails
  `addCompletion` like one on the sign-in page, and the call answers `invalid-output`.
- `stop: true` (only with the `password` route and no `branch`) marks the page of a
  `password` login's stop before its item's missing password
  ([ADR 0036](../../docs/adr/0036-passkey-after-the-identifier.md), owner 2026-10-13
  05:39 UTC); like the `passkey` route's name, it tells the service that the item has no
  password but a passkey. Such a page must show one of the route's fill fields as a
  password input, and not the completion marker; the route's other fill fields and
  sign-in targets do not keep it from the judge, but a list of accounts, a chooser
  recipe, another origin or a path where the recipe already has a `passkey` handler
  answers `not-judgeable` before any model call. The password input must match a fill
  target's locator exactly; a site that changes the field's locator is not judged (a
  known gap). It is judged with the stop's
  instructions, which ask only for a button that signs in with a passkey or security key
  instead of the password and name no fact of the account, under their own prompt
  version. Only a `passkey` handler is kept from it, through `addHandler` as above; a
  code is logged as not kept (`stop`), and `signed-in` or `rejected` stores no marker
  and answers `unclear`.

Judgements are limited under the lock, before credentials are resolved:
`page_judgements` holds one row per recipe revision, page origin and path and judge
prompt version (its instructions and output schema; a stop's page has its own), so a
repeat answers `judged-signed-in` when the model answered `signed-in`, `already-judged`
when it abstained (`unclear`), and `judged-challenge`, `judged-rejected` or
`judgement-unanswered` when it judged the page `challenge` or `rejected` or the row has
no verdict, as after the request failed or while it still runs past the owner's lock
(the row's `verdict`, ADR 0029). An abstention on a `partial` request is kept as
`partial`: another `partial` request for the path answers `already-judged`, and one
without it is judged again on the same row, which counts in the day it was first taken;
that adds at most one model call per path, as the new verdict is never `partial`. A
recipe judged 20 times since the start of the UTC day answers `judgement-limit`. A row
of another judge prompt version does not answer a repeat, so a changed prompt judges the
page again, as one that can now name a handler an earlier prompt could not. A change to
the local checks that keep a handler alone does not; it needs a prompt change to reach
pages already judged. The row is written with the spend reservation, so a request the
role then refuses locally still uses it. A stop's row is kept as `challenge` or
undecided, so it answers only later stops' pages, and a stop's judgement counts toward
the 20 a day. Rows of older revisions or of judge prompt versions other than the two
current ones are deleted once their UTC day is over.

`src/claude/calls.ts` wraps every model call. Per owner it takes a 90-second lock
(`busy` otherwise), refuses past $100 of estimated spend a month or $5 a day (UTC, both
roles counted), and only then resolves credentials: missing, refused or failed
credentials answer `credentials-not-configured`, `credentials-rejected`,
`issuer-unavailable` or `token-exchange-failed`. Generation also re-reads the recipe
under the lock, answering with a recipe another device stored meanwhile, and refuses a
page tried in the previous 10 minutes (ADR 0016), abstentions and failures included. The
attempt key is the generated recipe ID, the path and the revision being continued (0 for
a first page, the tombstone's revision for a revoked recipe generated again), so two
recipes of one origin that lead to the same page do not block each other. A request that
passes every check is an attempt, including one the role then refuses locally for its
size, which would be refused again. Each call first reserves its upper bound (64 KiB of
input as tokens plus 8,192 output tokens at the ADR 0014 rates, about $0.43) and then
corrects it from reported usage; usage the provider does not report keeps the
reservation. The `inference_log` row stores the provider and model, the role's prompt
version (`prompt_version`: the first 12 hex digits of the SHA-256 of its instructions, a
newline and its response format's JSON Schema, computed once per set of instructions:
the generate role has one for a form, one for an entry request and one for a list of
accounts, whose instructions add one list line), the instructions
and input as sent, the structured result, the outcome code, usage and estimated cost; a
request refused locally before any model call is not logged. For `invalid-output`,
the result is `{ rejection }` when a check named it (the judge role's
check of its marker refuses without one, leaving the result empty) and, when the plan
check refused a plan, that plan as `output`: a candidate or slot that is not one of the
request's IDs becomes `?`, and each name the model gave that is not a request slot ID
becomes `name-1`, `name-2` and so on by first appearance, so equal names stay visible.
An unchecked string may quote the page or a field name, so the model's text is never
stored, and the Worker logs only `Model output refused` with the role, its prompt
version and the `rejection`. A schema `path` resolves each key where the output format
defines it, so a key the format defines only in another object also ends the path as
`unknown-key`; the options of a variant are read together, so a key of a sibling option
gives that object's issue instead. Rows older than 90 days are deleted whenever a call
is logged and on every `GET /v1/recipes`, because routine releases do not apply cron
triggers.

## Schema and tests

`src/db/schema.ts` is the Drizzle schema. Run
`mise run //services/api:generate:migrations` after changing it and commit the generated
`migrations/`; `//services/api:check:migrations` fails when they drift. Vitest applies
the committed migrations to a local Miniflare D1 database. Sync tests seed synthetic
owners and devices directly; pairing and owner tests sign synthetic Access tokens
with keys generated per run (`test/access-helpers.ts`) and use a synthetic extension ID.
Claude credential tests use a synthetic issuer key generated per run
and a fake token endpoint; they never reach Anthropic. Generation tests also answer
the Messages API locally with synthetic plans and judgements. The concurrency cases
interleave requests in one local runtime; they do not demonstrate hosted D1 behavior.

Adding a NOT NULL column makes Drizzle rebuild the table (create `__new_<table>`, copy,
drop, rename). D1 enforces foreign keys and no pragma turns that off, so the rebuild
fails with `SQLITE_CONSTRAINT_FOREIGNKEY` for a table that other rows reference, such
as `devices`; a table nothing references rebuilds fine. Declare such a column with
`.notNull().default(0)`, so that Drizzle emits
`ALTER TABLE ... ADD ... DEFAULT 0 NOT NULL`, then append an `UPDATE` by hand for the
real values, as `migrations/0007_device_last_used.sql` does. The tests start from an
empty database, so seed referencing rows before trying such a migration. A new
`devices` column the hosted smoke checks must set goes into `seedOwner()` in
`smoke/hosted.ts` as well.

`cloudflare.config.ts` is the production configuration and `worker-runtime.ts` holds
the compatibility settings it shares with Vitest. The credential-free build and
prebuilt dry run validate the exact `.cloudflare/output/v0/` artifact, and the local
artifact smoke test executes that bundle in workerd. None of this demonstrates a
deployed service or the service acceptance gates in
[the delivery plan](../../docs/delivery.md).

## Hosted smoke checks

After each release activates and `/health` reports its revision, the deploy job runs
`smoke/hosted.ts` against the hosted server. It checks that `/manage` and
`/manage/api/devices` are answered by Access even with a forged
`Cf-Access-Jwt-Assertion`. It then seeds two synthetic owners with IDs starting
`smoke-`, each with one device whose credential it generates and stores only as a
SHA-256 digest, through the D1 REST API with the deploy token. Pairing a device needs
an owner's Access sign-in, so the job writes the device itself; synthetic owners get no
`owner_identities` row, so no sign-in can reach them. Over HTTPS the checks cover
missing and unknown credentials, settings and recipe round trips, owners neither seeing
nor changing each other's data, and `DELETE /v1/device` followed by `device_revoked`.
Every row of every `smoke-` owner is deleted before and after the checks, also after a
failed check. A run killed by its timeout or a cancel leaves its rows until the next
release removes them; their device credentials were never stored or printed. Cleanup
removes every `smoke-` owner, so the checks run only inside the deploy job's
`server-production` lock. A failed check fails the release. The checks never call
inference.

`test/hosted-smoke.test.ts` runs the same checks against the local Worker, so a
contract or schema change that would break them fails CI first; it also requires
`OWNER_TABLES` to list every table with an `owner_id` column, which cleanup depends on.

The Worker bundles `packages/contracts` and `packages/inference`, which are
GPL-3.0-only, and the Apache-2.0 AI SDK. Running it is not
conveying it, but assess that combination as [LICENSING.md](../../LICENSING.md)
requires before distributing a built Worker.

The configuration records the bootstrapped D1 database and the Custom Domain
`pateat.takuk.me`; the account, credentials and Access applications are owner settings
outside the repository. The server delivery workflow runs after every successful main
CI and releases the newest tested main revision ([delivery](../../docs/delivery.md)).
