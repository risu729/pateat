# API

This Worker is the optional private settings/recipe sync service with device enrollment.
It has no vault or inference implementation, and it is not deployed. The `DB` D1 binding
is declared in `cloudflare.config.ts`, but no database is provisioned. cf deploy
provisions declared bindings that lack an ID, so record the bootstrapped database ID
there before enabling server delivery; a routine release must not create the database
implicitly.

## Routes

All responses carry `Cache-Control: no-store` and `nosniff`; no route sends CORS
headers. API routes answer JSON, and owner pages answer script-free HTML that cannot be
framed. Contracts live in `packages/contracts/src/sync.ts` and `enrollment.ts`.

| Route | Purpose |
| --- | --- |
| `GET`/`HEAD /health` | Build revision probe; other methods return 405 |
| `GET /v1/settings` | Current synced settings; revision 0 with `settings: null` before the first write |
| `PUT /v1/settings` | Replace settings when `expectedRevision` matches; otherwise 409 with the current state |
| `GET /v1/recipes?after=&limit=` | Latest state of recipes changed after the cursor, at most 100 per page |
| `PUT /v1/recipes/:recipeId` | Publish an active revision or a tombstone when `expectedRevision` matches |
| `DELETE /v1/device` | Revoke the calling device's own credential |
| `GET /enroll?challenge=&label=` | Access page asking the owner to type the device's pairing code |
| `POST /enroll` | Approve the challenge for 10 minutes when the typed code matches |
| `POST /redeem` | Exchange an approved verifier for a device credential, once |
| `GET /manage` | Access page listing the owner's devices |
| `POST /manage/devices/:deviceId/revoke` | Revoke one of the owner's devices |

`/v1` routes require `Authorization: Bearer pateat_device_…`. The Worker stores only
the SHA-256 digest of each 256-bit device credential and derives the owner from it;
paths and bodies never name an owner. Unknown credentials return 401 `unauthorized`
and revoked ones 401 `device_revoked`, before any body is read. Bodies must be
`application/json` and at most 128 KiB. Synced settings are server-readable policy
metadata; device-local field policies, vault values and provider sessions are
rejected by the strict schemas. Stored documents are revalidated on read and fail
closed with a 500 `internal_error`.

`/enroll` and `/manage` must sit behind one Cloudflare Access application, and the
Worker verifies the `Cf-Access-Jwt-Assertion` itself against the team's keys, the
`ACCESS_TEAM_DOMAIN` issuer and the `ACCESS_AUD` audience. Without both secrets those
pages answer 503. The owner is found by token issuer and subject, never by email.
Approval forms must come from the same origin. `/redeem` is anonymous, limited to 10
requests a minute per client address by the `REDEEM_LIMITER` binding, and returns the
same 404 `enrollment_not_found` for pending, expired, used and unknown verifiers. The
[enrollment design](../../docs/architecture.md#device-enrollment) describes the flow.

Recipe revisions are immutable. A write claims the head with a conditional statement
and writes the history row in the same D1 batch, guarded by a per-request write ID,
so a losing writer changes nothing. Each head write takes the owner's next sequence
number; clients sync by passing the last `cursor` back as `after`. A tombstone keeps
its revision, and only an explicit later write can republish the recipe.

## Schema and tests

`src/db/schema.ts` is the Drizzle schema. Run `mise run generate:server-migrations`
after changing it and commit the generated `migrations/`; `check:server-migrations`
fails when they drift. Vitest applies the committed migrations to a local Miniflare D1
database. Sync tests seed synthetic owners and devices directly; enrollment tests sign
synthetic Access tokens with keys generated per run. The concurrency cases interleave
requests in one local runtime; they do not demonstrate hosted D1 behavior.

`cloudflare.config.ts` is the production configuration and `worker-runtime.ts` holds
the compatibility settings it shares with Vitest. The credential-free build and
prebuilt dry run validate the exact `.cloudflare/output/v0/` artifact, and the local
artifact smoke test executes that bundle in workerd. None of this demonstrates a
deployed service or the service acceptance gates in
[the delivery plan](../../docs/delivery.md).

The Worker bundles `packages/contracts`, which is GPL-3.0-only. Running it is not
conveying it, but assess that combination as [LICENSING.md](../../LICENSING.md)
requires before distributing a built Worker.

Worker routing, account selection, credentials and resource provisioning are
intentionally absent. The server delivery workflow stays disabled until those
deployment inputs, a verified Access application and a reachable health endpoint exist.
