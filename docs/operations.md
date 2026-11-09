# Operations and recovery

This runbook describes the current private service and extension. It is a manual
triage guide, not evidence that disaster recovery has been rehearsed. It does not
open the owner's service to other users. Production mutations need the operator's
credentials and deployment authorization; the read-only diagnosis below does not.

## Start with evidence

1. Open the extension's settings, then **Diagnostics**. Record the extension build,
   service revision, pairing state, last recipe sync, settings hold, cache size and
   the connection's vault/sync/automatic-unlock states. **Copy for bug report** previews
   the value-free report. Review a log export before sharing it: including sites also
   includes paths. Do not include passwords, tokens, vault records or raw model input.
2. Read the service's public health response and the relevant CI run. These commands
   neither deploy nor call a model:

   ```sh
   curl --fail --silent --show-error https://pateat.takuk.me/health
   gh run list --repo risu729/pateat --workflow ci.yml --branch main --limit 10
   gh run view RUN_ID --repo risu729/pateat
   gh run view RUN_ID --repo risu729/pateat --log-failed
   ```

   Replace `RUN_ID` with the failing run's numeric ID. Keep the run URL and, when the
   run has one (it is written only after hosted health passes), the **Server release
   verified** summary's revision, version and deployment IDs. A 200 health response
   proves that revision is serving; it does not prove Access, pairing, D1, smoke checks
   or model credentials work. Do not paste an unreviewed
   full job log into a public issue.
3. Identify the failing boundary: local vault, browser permission, service device,
   Access, recipe, model/budget or release. Avoid resetting a healthy local cache
   to repair an unrelated service error.

## Extension and sign-in failures

| Symptom | Checks and recovery |
| --- | --- |
| Site access is missing | Check Chrome's site-access control and the extension's site policy. Grant only the intended origin. A missing provider host permission also prevents Bitwarden sync. |
| Vault works offline but Sync needs sign-in | The cached vault and the provider session are separate. Sign in to that Bitwarden connection again in settings. A failed online sign-in must not be treated as permission to delete the cache. |
| A vault is locked | The vault timeout locked it, or the browser restarted with a timeout other than Never. Press **Unlock** on its row in settings and enter the master password; no server is contacted. The diagnostics page logs each timeout as `vault.timeout`. |
| A connection is logged out | **Log out**, or the timeout with the Log out action, removed the key and the sync sign-in. **Sign in again**; the encrypted cache is kept. |
| A refresh failed temporarily | Retry **Sync** after connectivity, a 429 or a provider outage recovers. Retryable refresh failures retain the prior session. A rejected session needs sign-in again. |
| The service device is rejected/expired | Revoke the old device in `/manage` when possible, disconnect the extension's service connection and pair again through the intended Access login. A new device restores service-held settings/recipes, not the Bitwarden vault or unlock key. |
| Disconnect could not contact the service | The extension forgets the credential locally. Revoke the device separately in `/manage`; the UI reports when remote revocation was unconfirmed. |
| Pairing asks for sign-in repeatedly | Check the service origin, Chrome permission, Access session and allowed production extension ID. `/pair` needs Access and must stay outside the Bypass application. A store-assigned extension ID needs its own allowed ID and fresh pairing. |
| Access refuses `/manage` or pairing | Both use the host-wide Owner policy, which permits One-time PIN sign-in without WARP. Check that the identity satisfies that policy; pairing has no separate application or audience. |
| `/pair/signed-in` loops after consolidating Access | Remove only the obsolete `CF_Authorization` and `CF_Binding` cookies scoped to `/pair`, then reopen the page. The parent's host-wide cookies can stay; signing in on this page creates no device. |
| A recipe is wrong or structurally mismatched | Inspect that site's recipe in `/manage`; revoke that recipe rather than replacing the Worker or changing credentials. Sync the extension. Cached/offline devices cannot learn the revocation until they reconnect; disable that site locally when an immediate stop is needed. Automatic repair of an existing mismatched recipe is not implemented. |
| `cacheFull` or a held settings sync | The extension has refused an update, not silently accepted a truncated cache. Check the diagnostics reason and [configured limits](architecture.md#service-limits). Reduce/revoke unnecessary service recipes or resolve the settings conflict before retrying. Do not remove restrictions just to make a merge fit. |
| Generation says `busy`, `daily-limit` or `monthly-limit` | `busy` means five requests of the owner are already making model calls, or a request that died held a slot in the last 90 seconds: retry once one ends. Otherwise wait for the next UTC budget period. Cached compatible recipes can still run. Do not reset spend rows to bypass the cap. |
| Generation credentials fail | Inspect `/manage/claude` and the diagnostics outcome. Its token-exchange test calls no model; real inference is separately paid and authorized. Check WIF identifiers and issuer/JWKS configuration using the [API guide](../services/api/README.md#claude-credentials). Never put tokens or private signing JWKs in a report. |

**Delete connection** removes the connection from this device with its local vault
cache, unlock key and sync sign-in; synced settings that name it stay and show it as
unavailable. Use it for deliberate removal, not as an initial troubleshooting step.
**Forget sync sign-in** removes only the local provider session; it is not a Bitwarden
server logout. Revoke a lost service device and secure the browser/profile
separately: service revocation cannot erase offline secrets.

## Server errors

The Worker's failures show in the Cloudflare dashboard as
[Workers Issues](https://developers.cloudflare.com/workers/observability/issues/) of
`pateat-api` (an open beta). Cloudflare records an occurrence for an uncaught
exception, a failed invocation (such as an exceeded CPU limit), a 5xx response and a
`console.error` line or any log line that holds an `Error` object or a stack, and
groups related occurrences into one issue. The service's `console.warn` lines pass no
`Error`, so they are not occurrences; they stay in Workers Logs. In this service that
means:

| What the Worker does | What the issue shows |
| --- | --- |
| A route throws | The app's error handler answers 500 and logs an `Error` named after the thrown error's class (such as `TypeError`) with the message `Unhandled API error`, the thrown error's stack frames, and the request's method and registered route, such as `{ method: "POST", route: "/v1/recipes/generate" }`. A failed model call is reported once, not again after the response |
| The web UI's built files cannot be read | A 500 page, with no log line |
| Access is not configured or its signing keys cannot be fetched | A 503: `access_unavailable` or `access_keys_unavailable`, or an `Unavailable` page on `/manage` and the `signed-in` tabs |
| `PAIRING_EXTENSION_IDS` is invalid | A 503 `pairing_unavailable` and the line `Pairing extension IDs misconfigured` |
| `OIDC_ISSUER` or `OIDC_SIGNING_KEYS` is missing or invalid | A 503 `issuer_unavailable` |
| Another value-free `console.error` line | That line, such as `Inference log purge failed` or `Stored recipe document no longer validates` |

The service never logs an error's message: a D1 query error from drizzle-orm quotes the
query's parameters (`Failed query: <sql>` then `params: <values>`), and an issue stays
listed after its occurrences expire. `services/api/src/error-log.ts` keeps only the
class name and the stack's `at` lines that end in a source position, without V8's
`[as <key>]` (the property a function was called through). It cuts the
`<name>: <message>` header off as a whole because a message can hold line breaks, and
drops every frame of a stack that does not start with that header. The route is the
pattern the request's handler was registered with, or for a path no handler matched
the last route that did (such as `/v1/*`), never the request path, which can hold
IDs. Hono passes only `Error` values to the handler; anything else thrown reaches the
runtime as an uncaught exception. Frames point into the built bundle, which is not
minified; no source map is uploaded. The owner chose this on 2026-11-09 (22:13
UTC), applying the extension's rule ([ADR 0019](adr/0019-local-diagnostics-and-logs.md):
name and stack positions, no message) to the service.

Occurrence details are kept for seven days; the issue stays listed after them. An
issue is never resolved automatically, and a resolved issue becomes active again on
its next occurrence. No automation (alert, webhook or coding agent) is set up: the
owner chose on 2026-11-09 (22:13 UTC) to have the project's agent check the issues
regularly instead.
`observability.issues` in `services/api/cloudflare.config.ts` turns Issues on: the
next release undoes a change made only in the dashboard.

## Moving the owner to another sign-in email

The service finds the owner by the Access token's issuer and `sub`
(`owner_identities`), never by email, and Access gives each email its own `sub`. A
new sign-in email therefore opens an empty `/manage`, and its first pairing would
create a second, empty owner. To move the owner to a new email:

1. Add the new email to the Owner policy's Include, sign in with it and read
   `user_uuid` from `https://pateat.takuk.me/cdn-cgi/access/get-identity`; it is the
   token's `sub`. Do not pair with the new email before step 2.
2. In D1, add the new identity to the existing owner, then delete the old
   identity's row:

   ```sql
   INSERT INTO owner_identities (issuer, subject, owner_id, created_at)
     SELECT issuer, 'NEW_USER_UUID', owner_id, unixepoch('subsec') * 1000
     FROM owner_identities WHERE subject = 'OLD_SUB';
   DELETE FROM owner_identities WHERE subject = 'OLD_SUB';
   ```

   The owner ID and every row that references it (devices, profiles, recipes,
   settings) stay as they are, and paired devices keep working.
3. Remove the old email from the Owner policy and, in Zero Trust **Users**, remove
   the old user.

The owner's email moved this way on 2026-11-08. This is a manual production write;
D1 is otherwise changed only by releases.

## A failed server release

The deployed source order check, artifact digests, database identity check, migration
list, activation readback, health and hosted smoke each answer a different question.
Read the failed step before choosing recovery:

- Before activation: a failed build/check, artifact verification or database identity
  check must be fixed before deploying. A migration failure prevents activation, but
  earlier migrations in the set may already have applied. Inspect applied migrations
  before retrying; never edit an already applied migration or apply down-migrations.
- Activation/readback: the workflow retries activation once, right away. A
  failed readback can coexist with a live new version. Read `/health` and the run
  output before retrying; an upload alone is not release success.
- Health or hosted smoke: a failure does not roll back the activated Worker. Hosted
  smoke covers synthetic device isolation and D1 round trips, not real Access
  pairing or inference. Preserve the failure and assess the serving version.

For a transient failure, the existing workflow's retry is:

```sh
gh run rerun RUN_ID --repo risu729/pateat --failed
```

This is a production mutation when a deploy job retries. The workflow restores the
artifact from that same run, verifies digests, rechecks source order, applies its
pending migrations and repeats activation/readback/smoke. A retry of the live
revision is permitted; an older revision is skipped. If the artifact has expired,
do not substitute another run's output: create a reviewed change from current main
and let its normal checks build a new artifact.

A failed run does not disable future automatic releases: each successful main push
can promote a newer revision. If the incident requires a freeze, the operator must
coordinate a pause before further merges/retries. The repository currently has no
separate promotion/failure-acknowledgement switch.

## Roll back application behavior

Prefer a reviewed revert on current main followed by the normal release path. For
a single offending squash commit, the preparation commands are:

```sh
git fetch origin
git switch -c recovery/revert-service origin/main
git revert --no-commit BAD_COMMIT
```

Replace `BAD_COMMIT` with the identified service commit. Review the diff, keep
already applied migration files intact, add a forward schema correction if needed,
and run the appropriate service checks:

```sh
mise run //services/api:test
mise run //services/api:check:artifact
mise run check
```

Commit and propose the recovery through a PR. Its release has a new revision, so the
normal source-order gate can promote it. The currently unreleased service has no
old-Worker/new-schema compatibility guarantee; a revert is safe only after verifying
it against the schema already applied in production. Re-running an old successful
run is not a rollback command: source ordering normally skips it. An out-of-band
Cloudflare version rollback bypasses these safeguards and is not a tested recovery
procedure in this repository.

A retained compatible prebuilt artifact can support manual recovery through the
scoped deployment action described in [delivery](delivery.md#failure-and-rollback),
but there is no implemented rollback workflow or rehearsed artifact-restore command.
Do not describe that intended mechanism as an automated feature.

## Database and lost-device recovery limits

The database ID and expected name in the tested release artifact identify the target;
they do not back it up. This repository has no configured backup schedule or tested
D1 restore procedure. Before any provider restore, the operator must establish the
available recovery point, target database, migration state and compatible Worker.
Never point a routine release at a fresh database to hide a failed migration: cf
could provision a new empty database if its binding ID were removed.

A database restored to older state can conflict with an extension's newer settings
revision. The extension holds that sync rather than silently replacing its local
restrictions. Resolve the conflict with the restored/current owner settings before
resuming. D1 recovery also does not restore a browser's vault cache, retained key or
provider sessions; reconnect Bitwarden locally on a replacement device and pair a
new service device. Revoke the lost device from the service's management list.

After any recovery, record the new health revision, action deployment/version IDs,
applied migration state and hosted-smoke result in the release output. Verify the
specific symptom with synthetic data before claiming recovery. Installed-Chrome,
real-account and paid-model acceptance remain separate gates.
