# API

This Worker is the optional private settings/recipe sync service with device enrollment.
It has no vault implementation, and it is not deployed. It generates recipes with the
owner's own Claude credentials ([recipe generation](#recipe-generation)). The
`pateat` D1 database was bootstrapped on 2026-10-11, and `cloudflare.config.ts` records
its ID. cf deploy provisions declared bindings that lack an ID, so the release artifact
refuses a build without one; a routine release never creates the database implicitly.
The release applies the committed migrations to that database before activation
([delivery](../../docs/delivery.md)).

## Routes

All responses carry `Cache-Control: no-store` and `nosniff`; no route sends CORS
headers. API routes answer JSON, and owner pages answer script-free HTML that cannot be
framed. Contracts live in `packages/contracts/src/sync.ts`, `enrollment.ts` and
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
| `DELETE /v1/device` | Revoke the calling device's own credential |
| `GET /enroll?challenge=&label=` | Access page asking the owner to type the device's pairing code |
| `POST /enroll` | Record the owner's approval and typed code for 10 minutes |
| `POST /redeem` | Exchange an approved verifier for a device credential, once |
| `GET /manage`, `/manage/sites`, `/manage/bindings`, `/manage/recipes` | Owner web UI (React app): devices, excluded sites and site defaults, account bindings, recipes |
| `GET /manage/assets/*` | The web UI's built script, styles and notices |
| `GET /manage/api/devices` | The owner's devices, newest first |
| `POST /manage/api/devices/:deviceId/revoke` | Revoke one of the owner's devices; 204 |
| `GET /manage/api/settings` | The settings `/v1/settings` serves; revision 0 before the first write; 404 `not_paired` without a paired device |
| `PUT /manage/api/settings` | Replace them like `PUT /v1/settings`; `connections` must be empty and the document at most 120 KiB |
| `GET /manage/api/recipes` | Every recipe head with its document, most recently changed first |
| `POST /manage/api/recipes/:recipeId/revoke` | Revoke one recipe if `expectedRevision` is its head; otherwise 409 with the current head |
| `GET /manage/claude` | Access page showing the Console values and the owner's WIF identifiers |
| `POST /manage/claude` | Save the owner's four WIF identifiers |
| `POST /manage/claude/test` | Exchange one assertion and show only the outcome, never the token |

`/v1` routes require `Authorization: Bearer pateat_device_…`. The Worker stores only
the SHA-256 digest of each 256-bit device credential and derives the owner from it;
paths and bodies never name an owner. Unknown credentials return 401 `unauthorized`
and revoked ones 401 `device_revoked`, before any body is read. Bodies must be
`application/json` and at most 128 KiB. Synced settings are server-readable policy
metadata; device-local field policies, vault values and provider sessions are
rejected by the strict schemas. Stored documents are revalidated on read and fail
closed with a 500 `internal_error`.

One Cloudflare Access application covers the whole host, and a more specific Bypass
application exempts `/v1/*`, `/redeem`, `/health`, `/.well-known/openid-configuration`
and `/.well-known/jwks.json`, which clients call without an Access login. For the owner
pages, `/enroll` and `/manage`, the Worker verifies the `Cf-Access-Jwt-Assertion` itself
against the team's keys, the `ACCESS_TEAM_DOMAIN` issuer and the `ACCESS_AUD` audience.
Without both secrets those pages answer 503. The owner is found by token issuer and
subject, never by email. Approval forms must come from the same origin. `/redeem` is
anonymous and issues a credential only when the typed code equals the code derived from
the verifier; a mismatch returns 409 `enrollment_code_mismatch`, and unapproved,
expired, used and unknown verifiers return the same 404 `enrollment_not_found`. The
`REDEEM_LIMITER` binding allows about 10 requests a minute per client address (the
hosted limiter is approximate and per location), so poll no more than every 6 seconds.
The [enrollment design](../../docs/architecture.md#device-enrollment) describes the
flow.

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
`https://api.anthropic.com`, and should use the `workspace:inference` scope.

## Recipe generation

[ADR 0018](../../docs/adr/0018-recipe-generation-route.md) routes, in
`src/recipes/generate.ts`. Both answer 200 with a `status`: `recipe` or `signed-in`
with the stored change, `abstained`, `rejected`, `challenge` or `unclear`, `failed` with
a code, or `unavailable` with a reason when no model was called.

- `POST /v1/recipes/generate` takes `{ version: 1, observation, slots, base? }`. Each
  origin has one generated recipe, `gen-` and the first 32 hex digits of the SHA-256 of
  the origin. Without `base`, an active recipe is returned as is; with `base`, the
  page's steps are appended after the recipe's last `advance` step. A stale `base`
  gets the current recipe back, a revoked recipe answers `recipe-revoked`, and a
  `base` naming another recipe is 400. The model maps the slots, the plan is checked
  with `validatePagePlan`, and the steps are stored with a conditional write.
- `POST /v1/recipes/:recipeId/completion` takes `{ version: 1, revision, observation }`
  for the page after the final `submit` step of that revision, on the recipe's origin.
  The login paths come from the stored recipe. A `signed-in` marker passes
  `addCompletion` and is stored as `completion` in the next revision.

`src/claude/calls.ts` wraps every model call. Per owner it takes a 90-second lock
(`busy` otherwise), refuses past $150 of estimated spend a month or $5 a day (UTC,
both roles counted), and only then resolves credentials: missing, refused or failed
credentials answer `credentials-not-configured`, `credentials-rejected`,
`issuer-unavailable` or `token-exchange-failed`. Generation also re-reads the recipe
under the lock, answering with a recipe another device stored meanwhile, and refuses a
page tried in the previous 24 hours, abstentions and failures included. The attempt key
is the origin, the path and the revision being continued (0 for a first page). A request
that passes every check is an attempt, including one the role then refuses locally for
its size, which would be refused again. Each call first reserves its upper bound (64 KiB
of input as tokens plus 8,192 output tokens at the ADR 0014 rates, about $0.43) and then
corrects it from reported usage; usage the provider does not report keeps the
reservation. The `inference_log` row stores the provider and model, the instructions and
input as sent, the structured result, the outcome code, usage and estimated cost; a
request refused locally before any model call is not logged. Rows older than 90 days are
deleted whenever a call is logged and on every `GET /v1/recipes`, because routine
releases do not apply cron triggers.

## Schema and tests

`src/db/schema.ts` is the Drizzle schema. Run
`mise run //services/api:generate:migrations` after changing it and commit the generated
`migrations/`; `//services/api:check:migrations` fails when they drift. Vitest applies
the committed migrations to a local Miniflare D1 database. Sync tests seed synthetic
owners and devices directly; enrollment tests sign synthetic Access tokens with keys
generated per run. Claude credential tests use a synthetic issuer key generated per run
and a fake token endpoint; they never reach Anthropic. Generation tests also answer
the Messages API locally with synthetic plans and judgements. The concurrency cases
interleave requests in one local runtime; they do not demonstrate hosted D1 behavior.

`cloudflare.config.ts` is the production configuration and `worker-runtime.ts` holds
the compatibility settings it shares with Vitest. The credential-free build and
prebuilt dry run validate the exact `.cloudflare/output/v0/` artifact, and the local
artifact smoke test executes that bundle in workerd. None of this demonstrates a
deployed service or the service acceptance gates in
[the delivery plan](../../docs/delivery.md).

The Worker bundles `packages/contracts` and `packages/inference`, which are
GPL-3.0-only, and the Apache-2.0 AI SDK. Running it is not
conveying it, but assess that combination as [LICENSING.md](../../LICENSING.md)
requires before distributing a built Worker.

The configuration records the bootstrapped D1 database and the Custom Domain
`pateat.takuk.me`; the account, credentials and Access applications are owner settings
outside the repository. The server delivery workflow runs after every successful main
CI and fails before any change until those deployment inputs exist.
