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
headers. API routes answer JSON; the owner web UI is a React app, and `/pair/signed-in`,
the Access and error pages are script-free HTML; none can be framed. Device routes
(`/v1/*`) also send `Server-Timing` with `total` from the Worker receiving the request,
before device authentication. A generation or completion request that reached the Claude
credential step adds `token` (that step) and, once it sent the model request, `model`; a
request refused at the credential step or by the role's local checks reports `token`
alone. Parse it by metric name, as Cloudflare may add entries; no `Timing-Allow-Origin`
is sent. Contracts live in `packages/contracts/src/sync.ts`, `pairing.ts`, `manage.ts`
and `generation.ts`.

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
| `POST /v1/recipes/:recipeId/outcome` | Keep how the first login of a revision ended, as result codes only; 204 |
| `POST /v1/recipes/:recipeId/logins` | Keep one record of a login that ended: its result codes, extension build and times, with the recipe's origin; 204 |
| `POST /v1/recipes/:recipeId/use` | Mark an active recipe used because a login started on one of its revisions; 204, or 404 |
| `POST /v1/recipes/:recipeId/page-sample` | Log a repeat login's signed-in page for evaluation, without a model call; 201 when kept, 204 when a sample of the recipe and branch is from the last 30 days |
| `GET /v1/device` | The calling device's paired time, the owner's live recipe count and settings revision, and whether recipe generation would run now, for the diagnostics page |
| `DELETE /v1/device` | Revoke the calling device's own credential |
| `POST /v1/device/problems` | Keep the calling device's `warn` and `error` local log lines, and `info` lines that say why Pateat did nothing, as it lets them leave (ADR 0066), each line checked on its own; 204, or 429 past the owner's 2,000 lines in 24 hours |
| `POST /pair` | Create a device for the signed-in owner from an allowed extension; 201 with the credential, once |
| `GET /pair/signed-in` | The page the extension opens when pairing needs a sign-in; it asks the user to go back to Pateat's settings |
| `GET /manage/dashboard`, `/manage`, `/manage/sites`, `/manage/sites/:scheme/:host`, `/manage/claude`, `/manage/problems`, `/manage/request-log` | Owner web UI (React app): the dashboard of login and request speed, counts, spend and failures; devices; the sites list with excluded sites, unreadable and revoked recipes; one origin's default account, recipes and bindings; Claude credentials, the connection test and each role's models; the newest problem lines devices sent; the request log with Delete all |
| `GET /manage/assets/*` | The web UI's built script, styles and notices |
| `GET /manage/api/dashboard?range=24h\|7d\|30d` | The dashboard's aggregates over the range ending now (default `7d`; another value is 400 `bad_request`), computed in the Worker from only the owner's rows: login time (total less the person's) of the signed-in login records, apart for those that waited on the service, with the median of each part (network, the rest of the service, waiting for the site, the rest, and the person apart) and per site and extension build; model, token, pre-model and server times per role, site and build (of requests that called the model; a request answered without a call counts only as a request and, unless its outcome is `recipe`, a failure; a signed-in page sample, outcome `sampled`, is left out), the median login and model time per UTC day (null on a day without one), the 10 slowest requests, counts, every login's result with how many signed in (in total and per day), the first-login result codes apart, tokens, this UTC day's and month's spend with the limits, active recipes, recipes generated, and failures by code with their latest 20; every set of durations has `n`, and below 20 its values instead of a p90 |
| `GET /manage/api/devices` | The owner's devices with their last use, newest first |
| `POST /manage/api/devices/:deviceId/revoke` | Revoke one of the owner's devices; 204 |
| `GET /manage/api/settings` | The settings `/v1/settings` serves; revision 0 before the first write; 404 `not_paired` without a paired device |
| `PUT /manage/api/settings` | Replace them like `PUT /v1/settings`; `connections` must be empty and the document at most 120 KiB |
| `GET /manage/api/recipes` | Every recipe head with its document and each layout's last use and first page's source (`firstPage`: origin, model, time; ADR 0060), most recently changed first; active heads whose document no longer validates are listed apart in `unreadable` |
| `POST /manage/api/recipes/:recipeId/revoke` | Revoke one recipe if `expectedRevision` is its head; otherwise 409 with the current head |
| `POST /manage/api/recipes/:recipeId/layouts/:layout/revoke` | Remove one layout as the next revision if `expectedRevision` is the head, revoking the recipe when it was the last; 404 for a layout the head lacks, otherwise 409 with the current head |
| `GET /manage/api/models` | The owner's model choices per role (`config`, the defaults while `saved` is false) and the models they may name (`models`): from the Models API with the owner's credential (`catalog: "models-api"`), else the pricing page (`"pricing"`), each with its efforts, rates and fast mode state (`none`, `available`, `failing`) |
| `PUT /manage/api/models` | Save `{ version: 1, config }`; a choice the list does not offer (a model, effort or speed, or fast mode while failing) answers 400 `model_unavailable` |
| `GET /manage/api/request-log` | How many request log rows (`entries`), login result codes (`outcomes`), login records (`logins`) and problem lines (`problems`) the owner has, and the oldest one's time (`oldestAt`, null when none) |
| `DELETE /manage/api/request-log` | Delete every request log row, login result code, login record and problem line of the owner, and clear `device_id` and `log_id` of the owner's `recipe_unit_sources` rows, and nothing else; answers how many (`deleted`, `outcomes`, `logins`, `problems`) |
| `GET /manage/api/problems` | The owner's newest 200 problem lines, newest first, with each device's label (ADR 0066) |
| `GET /manage/api/claude` | The Claude Console values for this owner and their saved WIF identifiers; 404 `not_paired` without a paired device |
| `PUT /manage/api/claude` | Replace the owner's four WIF identifiers |
| `POST /manage/api/claude/test` | Exchange one assertion and return only the outcome, never the token |

`/v1` routes require `Authorization: Bearer pateat_device_…`. The Worker stores only the
SHA-256 digest of each 256-bit device credential and derives the owner from it; paths
and bodies never name an owner. Unknown credentials return 401 `unauthorized`, revoked
ones 401 `device_revoked` and ones unused for 90 days 401 `device_expired`, before any
body is read. Each accepted request renews the device's `last_used_at`, at most once a
day; migration 0007 started existing devices at their pairing time. Bodies must be
`application/json` and at most 128 KiB. Synced settings are server-readable policy
metadata; device-local field policies, vault values and provider sessions are rejected
by the strict schemas. Stored documents are revalidated on read and fail closed with a
500 `internal_error`, except an active recipe whose document no longer validates, which
devices receive as revoked
([minimal service](../../docs/architecture.md#minimal-service)).

One Cloudflare Access application covers the whole host, and a more specific Bypass
application exempts `/v1/*`, `/health`, `/.well-known/openid-configuration` and
`/.well-known/jwks.json`, which clients call without an Access login. For `/pair` and
`/manage`, the Worker verifies the `Cf-Access-Jwt-Assertion` itself against the team's
keys, the `ACCESS_TEAM_DOMAIN` issuer and the `ACCESS_AUD` audience. Without both
secrets those routes answer 503. When the team's signing keys cannot be fetched (an
error, an answer that is not a key set, or no answer within five seconds), owner pages
answer 503 asking to try again later and the JSON routes 503 `access_keys_unavailable`,
not a refused sign-in.
`POST /pair` and `GET /pair/signed-in` also accept the `ACCESS_PAIR_AUD` audience of the
"pateat pair" Access application, which admits browsers without WARP to pairing only
([ADR 0030](../../docs/adr/0030-pairing-without-warp.md)). An empty value turns it off
only while that application does not exist. The owner is found by token issuer and
subject, never by email. The
[pairing design](../../docs/architecture.md#device-enrollment) describes the flow.

`POST /pair` is direct pairing
([ADR 0020](../../docs/adr/0020-direct-device-pairing.md)). The extension's background
sends `{ "version": 1, "label": "…" }` with the browser's login session. The Worker
checks, in this order, the Access token, the `Origin`, the rate limit and then the body;
it creates the owner on an identity's first pairing in the same transaction as the
device (a failed pairing leaves no owner), stores only the credential's SHA-256 and
answers 201 `{ version: 1, deviceId, credential }`. `Origin` must equal
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
| 503 | `access_keys_unavailable` | Access's signing keys could not be fetched; try again later |
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
`Origin`), `access_unavailable` (no Access configuration) and `access_keys_unavailable`
(Access's signing keys could not be fetched). An identity that never approved a pairing
has no owner and sees no data; its settings requests answer 404 `not_paired`. Settings
and recipe revisions written here record no device as their writer. The bundle includes
GPL-3.0-only `packages/contracts` code; each page links its source and the GPL text at
the built commit, and the third-party notices served with it
(`public/manage/assets/notices.md` and the build's `licenses.md`).

Recipe revisions are immutable. A write claims the head with a conditional statement and
writes the history row in the same D1 batch, guarded by a per-request write ID, so a
losing writer changes nothing. Each head write takes the owner's next sequence number;
clients sync by passing the last `cursor` back as `after`. A tombstone keeps its
revision, and only an explicit later write can republish the recipe. Devices revoke a
recipe their chosen item cannot run with `PUT /v1/recipes/:recipeId` and
`state: "revoked"`, before generating its page again
([ADR 0058](../../docs/adr/0058-automatic-recipe-removal.md)).

[Per-owner limits](../../docs/architecture.md#service-limits) live in `src/limits.ts`
and the shared recipe byte constants in `@pateat/contracts`. The `OWNER_LIMITER` binding
allows 120 requests a minute per owner on `/v1` and per Access identity on
`/manage/api`, checked before any body is read; over it, 429 `rate_limited` with
`Retry-After: 60`. An owner holds at most 1,000 active recipes: a write that would add
one more answers 409 `recipe_limit`. Active head documents also share a 1.5 MiB UTF-8
byte cap, checked in the claim statement itself on creation, republishing or a growing
update. Equal and shrinking updates and revocations always pass; tombstones and
historical revisions do not count. The shared device cache limit is 2 MiB, leaving
margin for its envelope. New recipes can initially overflow a stale device cache before
later shrinking current heads are reached. The extension saves removals and non-growing
newer heads during bounded lookahead, checkpoints its scan separately and resumes across
syncs and worker restarts without advancing past pending active changes. A settled feed
under this cap can therefore recover; see
[ADR 0013](../../docs/adr/0013-service-held-recipes-and-settings.md#amendment-durable-recovery-under-cache-pressure-2026-10-14).
The feed contains current heads, rather than every historical revision: a write moves
its recipe's head to a new increasing sequence. The same batch deletes revisions older
than the newest 10, and every earlier revision when the write revokes the recipe. Every
winning write sets the head's `last_used_at`, except a service write that only removes
layouts, and so do each accepted `/logins` record and `/use` report while the head is
active. Each layout's own last use is kept in `recipe_layout_uses` (ADR 0060): the
`/logins` record and `/use` report of a login on it, and the service's continuation,
handler and marker writes into it; a write that drops a layout deletes its row.
`GET /v1/recipes` and `GET /manage/api/recipes` first revoke up to 50 of the owner's
active recipes whose `last_used_at` is more than 90 days old, oldest first and never an
entry recipe, as tombstones with no writing device; a write that marks one used before
its revocation lands keeps it
([ADR 0058](../../docs/adr/0058-automatic-recipe-removal.md)). The same check then
goes through up to 50 active recipes whose own `last_used_at` is within those 90 days
and removes each layout whose newer of creation and last use is more than 90 days old,
as the next revision without it, as long as another layout stays. The write wins only
while none of the removed layouts was used since the check read their uses. A failed
check is logged and the request goes on.

`recipe_unit_sources` records which call made each unit of an active recipe
([ADR 0060](../../docs/adr/0060-recipe-layouts.md#generation-provenance)): service-only,
never synced and never in the document. A unit is named within its layout (`layout`,
null for an entry recipe) by `page:<n>` (the page whose steps start at index `n`),
`handler:<i>` and `marker:<i>` (by index, as the judge only appends them), `list` (a
chooser layout's buttons), `account/…` or `other/…` (a chooser branch's units) or
`entry`; `src/recipe-units.ts` defines them and each unit's content. A row holds the
unit's `digest` (32 hex digits of the SHA-256 of that content as canonical JSON), the
recipe `revision` whose write recorded it, its `origin` (`generated`, `judged` or
`device`), the model that answered (`provider`, `model`, `effort`, `speed`, from the
call's `served` model), the prompt version, the build, the writer device the revision
records, the request log row's ID (not a foreign key) and `created_at`, the time of the
winning write. `writeRecipe` writes the rows in the batch of the write that adds the
units, only when it wins: a generated first page or continuation page, each handler a
judgement adds (several under one log ID) and the marker it learns, a chooser's list and
branch pages, and an entry recipe. A device's active `PUT` splits each route at the
recorded pages, keeps the rows of units whose digest is unchanged, and writes `device`
rows for units it changed or added. The same batch deletes the rows of units and layouts
the document dropped, and every row of a revoked recipe.

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
  `svac_…` and `wrkspc_…`. None is a secret. The owner enters them on the web UI's
  Claude tab (`/manage/claude`) through `/manage/api/claude`, behind the same Access,
  same-origin, rate and body-size checks as the rest of `/manage/api`. Its test button
  only exchanges a token, which calls no model and costs nothing.
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
exchanged token serves one call and is then discarded. `/manage/claude` shows these
values and the saved identifiers.

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

- `POST /v1/recipes/generate` takes
  `{ version: 1, observation, slots, base?, branch?, signedIn? }`. Each origin and start
  path has one generated recipe, `gen-` and the first 32 hex digits of the SHA-256 of
  the JSON `[origin, path]`; a page without `base` is the start of its own. The recipe
  holds up to three layouts ([ADR 0060](../../docs/adr/0060-recipe-layouts.md)); a first
  page writes one, keyed by its creation time and marked with the page's language.
  `base` and `branch` go together: `branch` names the layout continued (`<key>`, or
  `<key>:account` / `<key>:other` for a chooser's branch), and a branch the stored
  recipe does not have answers `recipe-conflict`. Without `base`, an active recipe is
  returned as is; with `base`, the page's steps are appended after that layout's last
  `advance` step. A continuation whose write loses to a write of another layout, or of
  the chooser layout's other branch, is written once more onto that newer revision while
  its own layout or branch is unchanged. A stale `base` gets the current recipe back, a
  `base` whose recipe is revoked answers `recipe-revoked` while the revoked recipe's
  start page is generated again as the revision after its tombstone, a `base` whose
  recipe was not generated for this origin and its start path answers `recipe-conflict`.
  A first page needs room under the active recipe count limit; every generated page,
  including continuations and entry pages, needs at least 32 KiB of byte room before the
  model call. A refused write after the call also answers `recipe-limit`. A judge write
  refused for bytes keeps the page's answer (`challenge`, or `signed-in` once the recipe
  has a marker or the page is on another origin of the site) and is logged; only a first
  marker on the recipe's own origin refused for bytes answers `recipe-limit`. A `base`
  that is not a generated recipe ID is 400. The model maps the slots, the plan is
  checked with `validateGeneratedPage`, and the steps are stored with a conditional
  write. Up to 20 slots are accepted; a slot with a `fieldName` (and `fieldPosition` for
  a duplicate name) is a custom-field offer, and each offer names a different field
  ([ADR 0027](../../docs/adr/0027-per-account-login-routes.md)). Each offer the plan
  uses is named from the page's text for its element, such as `店番号`
  (`customSlotNames` in `packages/inference`), and the steps store that name instead of
  the request's slot ID; the model gives no names. An offer whose field the owner's
  saved bindings of the same origin and recipe ID already name (a `{ custom }` field of
  the same name, `position` and `count`) keeps that binding's slot name, unless the
  bindings give the field different names, the name is not a custom slot ID or equals a
  built-in slot or request slot ID, or another offer the page fills would carry it too.
  Every offer's carried name, filled on the page or not, is reserved before any page
  text, so page names are numbered apart from it
  ([ADR 0027](../../docs/adr/0027-per-account-login-routes.md#amendment-2026-10-19-slot-names-from-the-bindings)).
  Only the bindings' slot names and field references are read, and the prompt is
  unchanged. The answer that wrote the recipe adds `customSlots: [{ slot, offered }]`
  for those slots; an answer with a recipe another request stored has none. On a
  continuation, a name the `base` recipe already uses, compared without case, answers
  `failed` with `recipe-invalid`, whether it is carried or the name the page's text
  alone would give. A start page that offers several identifier sets (such as branch and
  account numbers, or a contract number) may get up to 3 `alternatives`, each with its
  own `slots` and `steps`, stored as further variants of the recipe's `password` route;
  the top-level `slots` and `steps` are its first variant. Each variant fills exactly
  its slots, starts on the start path and submits, so a recipe with alternatives is
  never continued. No element is filled as different slots in different variants, and no
  two variants fill the same elements. A continuation's answer, or a chooser branch
  page's, has its alternatives checked and dropped before its slots are named, so they
  name none. `customSlots` covers the custom slots of every variant, and the request log
  records the alternatives with the plan (on a continuation or chooser-branch page, only
  in `answer`). The answer may also name the start page's passkey sign-in button
  (`passkeyButton`); a candidate with the button role whose label or locator names a
  passkey or security key, not named like a registration and not used by any set or the
  account switch is stored as the recipe's `passkey` route, any other is dropped without
  failing the call, and a continuation's is dropped. The request log records the kept
  button. A recipe's first page that lists no accounts, and only it, carries `signedIn`
  (400 otherwise): the device's hint that the page shows the person signed in
  ([ADR 0035](../../docs/adr/0035-page-kinds-per-site.md)), sent to the model with the
  page. A page that lists accounts has `slots: []`, and only such a page or a
  passkey-only one may (400 otherwise): no slot, field name or value shape goes with a
  list, whose instructions say so
  ([ADR 0028](../../docs/adr/0028-account-chooser-login-pages.md#amendment-2026-10-23-sent-without-slots)).
  Every plan answers `pageKind` (`sign-in`, `confirm` or `unclear`) and `irreversible`
  (`yes`, `no` or `unclear`, for evaluation only). Each layout stores its first page's
  `pageKind` (ADR 0060): a continuation keeps the layout's, and a chooser branch's pages
  are `sign-in` whatever the model answers. Every layout of a recipe has the same
  `pageKind`, so a document mixing them fails validation (400 on a `PUT`), and a layout
  of another kind written by `withLoginLayout` replaces the recipe's layouts. A document
  also holds at most 20 slots over all its layouts and at most 120 KiB of JSON.
  `irreversible` is never stored on a recipe. A recipe stored without `pageKind` no
  longer validates, so it reads as revoked and its page is generated again rather than
  taken as `sign-in`.
- `POST /v1/recipes/generate` also takes
  `{ version: 1, observation, slots, repair: { recipeId, revision, layout?, step? } }`
  for a page the recipe's layouts no longer match
  ([ADR 0041](../../docs/adr/0041-repair-stale-recipes.md)): without `layout`, the
  start page of the recipe that starts on the page's path, a form or, with `slots: []`,
  a list of accounts; with `layout` and `step` together, the page where that layout's
  `step` did not show, which must follow an `advance` of a layout without
  alternatives and lists no accounts. No `base` or `branch` (400 otherwise). An entry
  request takes `repair: { recipeId, revision }` for an entry recipe whose link no
  longer shows. A revoked recipe answers `recipe-revoked`; one that is not this
  origin's active generated recipe, or a layout or step the recipe does not have,
  `recipe-conflict`; a newer revision than `revision` is returned as is. A later
  step's page is generated as a continuation of the layout cut before that step. The
  answer is added as a new layout (marked with the page's language, or the stale
  layout's for a later step); with three layouts, it takes the place of the least
  recently used one. A list answered for a chooser is added to the chooser's layouts
  the same way. A start page whose kind changed, a form where a list was or the other
  way round, is written as the page's kind in the next revision. A start page that a
  layout already has, or a later step whose steps a layout already holds, writes
  nothing and returns the recipe; an answer that only adds a passkey button to a
  layout's start page is merged into that layout, and only a `sign-in` answer is
  written. Instead of the retry window, a device repairs a recipe at most once a UTC
  day, whatever came of the call: the `recipe_repairs` row is written with the attempt,
  and another repair that day answers `unavailable` with `repair-limit`. Spend limits,
  byte room and the request log apply as for a first page.
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
- `POST /v1/recipes/generate` also takes
  `{ version: 1, observation, slots: [], passkeyOnly: true, signedIn }` for a
  passkey-only start page ([ADR 0053](../../docs/adr/0053-passkey-only-generation.md)):
  no `base` or `branch`, and an observation with no fill candidate and no `accounts`
  (400 otherwise; empty `slots` without `passkeyOnly` is 400 too). Its instructions are
  their own text, not the generation role's with a line added, and are logged under
  their own prompt version: the owner prefers instructions per page kind to one
  generalized prompt (2026-10-19), so a new kind of page gets its own text rather than
  changing the shared one. The model plans `fields: []` and one `submit` action on the
  button that signs in with an existing passkey, naming the same button as
  `passkeyButton`, or abstains. The plan check accepts only a `button` candidate whose
  label or locator names a passkey or security key and not a registration (the ADR 0027
  word lists). The stored recipe has `passkeyOnly: true`, `slots: []`, one click step
  that submits, `maxSubmissions: 1` and the same button as its `passkey` route, so it
  has no `password` route. The retry window, attempt row, spend limits, request log and
  revocation apply as for a first page; it grants no passkey signing permission.
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
- `stop: true` (only with the `password` route and a `branch` that names no chooser
  branch) marks the page of a
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
pages already judged. The row is written just before the first model request, so a
request the role refuses locally (`input-too-large`) gives the page back
([ADR 0027](../../docs/adr/0027-per-account-login-routes.md)). A stop's row is kept as
`challenge` or undecided, so it answers only later stops' pages, and a stop's judgement
counts toward the 20 a day. Rows of older revisions or of judge prompt versions other
than the two current ones are deleted once their UTC day is over.

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
reaches the model is an attempt; one the role refuses locally for its size writes no
attempt row, so its resend is refused for its size again, not `recently-tried`. Each
role asks the owner's model choices in order
(`src/claude/models.ts`, saved in `inference_model_configs` from `/manage/claude`, ADR
0014; by default Claude Opus 5.5 then Claude Sonnet 5.5, both at effort `low`): a
refusal asks the next choice, a fast mode call that fails `rate-limited`,
`provider-error` or `timeout` asks the same model at the standard speed, and any other
failure ends the request. Every call runs under the same lock, checks the spend stops
first, and is charged and logged on its own. Nothing is reserved: a call is charged
after it returns from reported usage, or at its upper bound (64 KiB of input as tokens
plus 1,024 output tokens at its rates, about $0.28 for Opus 5.5) when usage is unknown.
The `inference_log` row stores the provider, model, `effort` and `speed`, the role's
prompt version
(`prompt_version`: the first 12 hex digits of the SHA-256 of its instructions, a newline
and its response format's JSON Schema, computed once per set of instructions: the
generate role has one for a form, one for an entry request and one for a list of
accounts, whose instructions add one list line), the instructions and input as sent, the
structured result, the outcome code, usage and estimated cost. Since 2026-10-18
([ADR 0012](../../docs/adr/0012-inference-request-log.md#amendment-2026-10-18-rows-for-a-real-page-corpus))
it also records the recipe the call is for (`recipe_id`, `branch`, empty without one),
`layout` ([ADR 0060](../../docs/adr/0060-recipe-layouts.md): the layout `branch` names,
or for a recipe's first page sent to the model the key of the layout its answer creates;
null for an entry page and a first page answered without a call), `base_revision` (the
head revision when the call was made: 0 for none, the tombstone's for a revoked recipe
generated again, the judged one for the judge), `recipe_page` for generation (`first`
for a page sent without a base: a new recipe, one generated again, a list of accounts or
an entry page; `continuation` for one sent with a base, a chooser branch's pages
included), for generation `signed_in` (the request's hint), `page_kind` and
`irreversible` (the plan's answers, also for a plan the local checks refused; null when
the answer was no plan) ([ADR 0035](../../docs/adr/0035-page-kinds-per-site.md)),
`build` (`PATEAT_BUILD_REVISION`) and `observation_hash` (12 hex digits of the SHA-256
of the request's observation as JSON). `callClaude` returns the row's ID, and once the
answer's recipe write succeeds `keepLogRevision` sets `revision`; a write refused or
lost to a device leaves it null, and a failed update is logged as
`Inference log revision not kept` and never fails the request. Since the
[timings amendment](../../docs/adr/0012-inference-request-log.md#amendment-2026-10-18-request-timings),
`pre_model_ms` (from the Worker receiving the request to just before the model call:
authentication, the request limit, the route's reads, the lock and checks, the model
configuration and the credential; a later call of the same request includes the calls
before it), `token_ms` (resolving the credential: its D1 read,
signing the assertion and the token exchange, new on every call) and `model_ms` (the
model call and its output checks) are written with the row. `server_ms` (to the
response, the recipe write included) is set on every logged row, also one answered
without a model call, by an owner-scoped update through `waitUntil` once the route
answered, so it never delays the response. It stays null when that update failed,
logged as `Inference log server time not kept`, or when releasing the owner's lock threw
after the row was written, which fails the request. `src/request-timing.ts` does this
and adds the call's `token` and `model` to `Server-Timing`. `answer` holds
the model's own answer for every decision, `unclear` and refused output included, before
the local checks: `{ "decision": "signed-in", "marker": "c7" }`, or a generated plan
with a passkey button the plan check dropped. A candidate or slot it names that is not
one of the request's IDs is `?`, as for a refused plan below; output the response format
refused has no answer. For `invalid-output`, the result is `{ rejection }` when a check
named it (the judge role's check of its marker refuses without one, leaving the result
empty) and, when the plan check refused a plan, that plan as `output`: a candidate or
slot that is not one of the request's IDs becomes `?`. An unchecked string may quote the
page or a field name, so the model's text is never stored, and the Worker logs only
`Model output refused` with the role, its prompt version and the `rejection`. A schema
`path` resolves each key where the output format defines it, so a key the format defines
only in another object also ends the path as `unknown-key`; the options of a variant are
read together, so a key of a sibling option gives that object's issue instead. For
`refused`, the result is `{ refusalCategory }` with the provider's refusal category code
(for Claude, `stop_details.category`, such as `cyber`) when it reported a short code
([ADR 0014](../../docs/adr/0014-claude-generation-provider.md)), and empty otherwise;
the provider's explanation is never stored.

A request answered without a model call is logged too
([ADR 0012](../../docs/adr/0012-inference-request-log.md#amendment-2026-10-18-requests-answered-without-a-model-call)),
by the route through `logUnsent`: one refused locally (`input-too-large`) or by any
check above, `recently-tried`, a judgement gate, `not-judgeable`, a recipe state
refusal, `incomplete-observation`, `invalid-request`, or a recipe another request
stored. Its `outcome` is the answer's code (`recipe` for a stored recipe); `provider`,
`model_id`, `result`, `answer` and the token counts are null, the cost is 0 and nothing
is charged. `request` is what the model would have received; a judgement refused before
its route is found (`recipe-revoked`, `recipe-conflict`) has no `loginPaths`.
`base_revision` is the head read when the request arrived. A request answered the same
way within 10 minutes, with the same whole `request`, role, prompt version, origin,
path, recipe, branch and base revision, adds no row (the check and the insert are not
atomic, so two identical requests at once can both land), and past
`CLAUDE_CALL_LIMITS.unsentRowsPerDay` (500) such rows an owner's UTC day adds none,
logged as `Inference log row over the daily cap`. A failed write is logged as
`Inference log row not kept` with the role and outcome and never changes the answer.
Invalid bodies and requests answered 400 or 404 are not logged: a `base` ID not in the
`gen-…` form, a judged page of an origin no move reaches, a missing recipe. Such a row
has `server_ms` but no `pre_model_ms`, `token_ms` or `model_ms`.

`POST /v1/recipes/:recipeId/page-sample` takes `{ version: 1, revision, route, branch,
observation }`: the signed-in page of a login that the recipe's marker completed
([ADR 0029](../../docs/adr/0029-local-sign-in-state.md#amendment-signed-in-page-samples-2026-10-18),
owner 2026-10-18 08:05 UTC). The revision must be a kept, active revision of the owner's
recipe (404 otherwise, a tombstone, another owner's recipe and a revoked recipe's
earlier revisions included), with the route and branch, and the page on the recipe's
origin, complete, with no list of accounts and none of the password route's fill fields,
as the judge requires (400). The route then writes one `judge` row with the outcome
`sampled` (`logPageSample`): `request` is built as the judge's request would be
(`instructions`, `recipeId`, `route`, `loginPaths` from that revision, `observation`),
though the judge route answers such a page `not-judgeable` and never sends it, under the
judge's prompt version, `base_revision` is that revision, and `provider`, `model_id`,
`result`, `answer`, `revision`, `recipe_page`, the token counts, `pre_model_ms`,
`token_ms` and `model_ms` are null, at cost 0; `server_ms` is set as on every logged
row.
No model is called and no spend or judgement row is written. One statement writes it
only while the owner has no `sampled` row of the recipe and branch from the last
`PAGE_SAMPLE_INTERVAL_MS` (30 days, in `packages/contracts/src/manage.ts`), across
devices; otherwise the answer is 204 and nothing is written. Invalid bodies, 400 and 404
answers are not logged. Sampled rows are not limited by the ten-minute rule or
`unsentRowsPerDay` for requests answered without a call, and do not count toward that
daily cap; the dashboard leaves them out, so they count neither as requests nor as
failures (agent's choices, not confirmed by the owner).

Rows older than one year are deleted whenever a request is logged and on every
`GET /v1/recipes`, because routine releases do not apply cron triggers.
`DELETE /manage/api/request-log` deletes all of the owner's rows and clears `device_id`
and `log_id` of the owner's `recipe_unit_sources` rows, which keep the model, prompt
version, build, revision, digest and time; a call still running then logs its row
afterwards.

`POST /v1/recipes/:recipeId/outcome` takes
`{ version: 1, revision, branch, outcome, cause?, step }`: how the first login of that
revision on a device ended
([ADR 0019](../../docs/adr/0019-local-diagnostics-and-logs.md#amendment-2026-10-18-first-login-results-for-evaluation)).
`outcome` is a `loginOutcomeSchema` code, `cause` one of `loginOutcomeCauseSchema`'s
fixed codes and `step` the attempt's step index; any other field, a URL or free text
answers 400, a body over 1 KiB 413. A recipe the owner does not hold, a revision above
its head or a revoked head's tombstone answers 404. The `login_outcomes` row keeps the
owner, recipe, branch (the layout, ADR 0060), revision, the codes and the service's own
time; the first report of a revision is kept and any later one, from any device, is
answered 204 and ignored. Its rows follow the request log's one-year retention (deleted
with the expired log rows, also on each report) and its delete-all.

`POST /v1/recipes/:recipeId/logins` takes `{ version: 1, revision, branch, outcome,
cause?, extensionBuild, totalMs, serviceMs, networkMs, personMs, pageMs }`: one login of
that revision that ended
([ADR 0055](../../docs/adr/0055-login-records-sent-to-the-service.md)). The codes are
those of `/outcome`, `extensionBuild` a 7 to 40 digit commit or `development`, and the
times whole milliseconds up to a day: `networkMs` is the part of `serviceMs` spent to
and from this service, counted only for answers that named their `Server-Timing`
`total`, and `pageMs` the time the login waited for the site; any other field (an
origin, a URL, free text, `otherMs`) answers 400, a body over 1 KiB 413. A recipe the
owner does not hold, a revision above its head, a revoked head's tombstone, or a recipe
with no kept document (as after its revocation) answers 404. Each report is one
`login_timings` row: the owner, recipe, branch (the layout), revision, the
recipe's `origin` read from the reported revision's document (or the newest kept one
when that revision was pruned), the codes, the build, the times and the service's own
time. Its rows follow the request log's one-year retention and its delete-all. The same
batch marks the recipe used (`last_used_at`) while its head is active, whichever
revision the record names, and the record's layout when the head's document has it.

`POST /v1/recipes/:recipeId/use` takes `{ version: 1, revision, layout }`: a login
started on that revision, whatever happened after
([ADR 0058](../../docs/adr/0058-automatic-recipe-removal.md)), including the fill-only
logins and the logins that stop before an item's missing password, which send no
`/logins` record. Any other field answers 400, a body over 256 bytes 413. It sets the
head's `last_used_at` to the service's time when the head is active and the revision is
at most its head, and answers 204, and marks the layout used when the head's document
has it; a recipe the owner does not hold, a revision above its head or a revoked recipe
answers 404. Nothing else is stored.

`POST /v1/device/problems` takes `{ version: 1, extensionBuild, logId, entries }` with 1
to 100 entries `{ seq, time, level, event, fields }`: the calling device's `warn` and
`error` local log lines, and `info` lines that say why Pateat did nothing
(`PROBLEM_INFO_LINES`), it has not sent yet
([ADR 0066](../../docs/adr/0066-problem-lines-sent-to-the-service.md)).
`extensionBuild` is the build that wrote every line, `logId` the device log's random ID
(32 hex digits), `seq` the local log's key, `time` the device's, `level` `warn`, `error`
or, for an event and outcome of `PROBLEM_INFO_LINES`, `info`, `event` a log event name
of `PROBLEM_EVENT_FIELDS` (`packages/contracts/src/problems.ts`), and `fields` only the
fields that event lists, each of its kind (`PROBLEM_FIELD_KINDS`): codes, error names,
counts, flags, builds, recipe IDs, origins (a configured site's or an `origin:`
pseudonym), RP IDs, script positions and page paths. No string but a stack holds
whitespace, none `@`, `?` or `#`, only an origin `://`, and no path `;` or `=`, so free
text, a URL with a query or parameters or an email address does not pass. Each entry is
checked on its own (`problemReportEnvelopeSchema`): one that does not pass is left out
and the others are kept, so a newer extension's line an older service does not know
costs only that line; a report with no entry that passes, or whose envelope does not
pass, answers 400, and a body over 64 KiB answers 413. Each kept line is one
`problem_log` row: the owner, the device, the log ID, `seq`, the build, the level, the
event, the fields as JSON, the device's time and the service's own time. A line whose
device, log ID and `seq` are already stored is ignored and not counted, so a retry
changes nothing, and a log made again on the device never collides with the old one's
rows. A report whose new lines would take the owner past 2,000 lines received in the
last 24 hours is refused whole with 429 and `Retry-After: 3600`; the count is read
before the insert, so two reports at once may pass it by up to one report's lines. Rows
are kept a year, like the request log (deleted with its expired rows, also on each
report), and go with the request log's Delete all.

A Claude session reads them through the read-only D1 query tool, for example:

```sql
SELECT datetime(logged_at / 1000, 'unixepoch') AS at, event, level,
  json_extract(fields, '$.origin') AS origin, json_extract(fields, '$.outcome') AS outcome,
  fields, extension_build
FROM problem_log ORDER BY created_at DESC, seq DESC LIMIT 50;
```

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
