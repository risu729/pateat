# ADR 0019: Local diagnostics page and logs

Status: accepted by the owner on 2026-10-11 and amended the same day (see
[Amendment: server information](#amendment-server-information)) and on 2026-10-12 (see
[Amendment: logins that did not finish](#amendment-logins-that-did-not-finish) and
[Amendment: sites shown in log downloads](#amendment-sites-shown-in-log-downloads) and
[Amendment: a page limit per level](#amendment-a-page-limit-per-level) and
[Amendment: what the log records](#amendment-what-the-log-records)) and on 2026-10-13
(see
[Amendment: URLs keep parameter names, not values](#amendment-urls-keep-parameter-names-not-values)).
The diagnostics page, the logs, the Bitwarden server information, recent log lines and
the Pateat service's record for the device are implemented.

Date: 2026-10-11

## Context

Pateat may be published, so a user must be able to file a useful bug report without
leaking secrets. Before this decision the extension had no build revision (the manifest
version is always `0.1.0`), its settings page showed a fixed placeholder status from
`getFoundationStatus()`, and its only log was one `console.info` for passkey requests,
visible only while the service worker's DevTools were open.

Researched practice on 2026-10-11:

- The official Bitwarden browser extension keeps an in-memory flight recorder of 1,000
  events inside its SDK and does not persist it; its About dialog copies the lines
  `Version`, `SDK` and `Server version`
  ([about-dialog](https://github.com/bitwarden/clients/tree/main/apps/browser/src/tools/popup/settings/about-dialog),
  [flight recorder](https://github.com/bitwarden/sdk-internal/blob/main/crates/bitwarden-logging/README.md)).
  Its SDK logging is opt-in per field.
- MetaMask persists logs for 7 days and exports a JSON state log with secrets excluded
  per field
  ([LoggingController](https://github.com/MetaMask/core/blob/main/packages/logging-controller/src/LoggingController.ts)).
- uBlock Origin keeps its logger in memory and copies a redacted support summary.
- `chrome.storage.local` has a 10 MB quota that Pateat already shares with the recipe
  cache and settings, and rewrites a whole key on each `set`. IndexedDB is reachable
  from the service worker and extension pages (not from content scripts), is not
  cleared with browsing data, and supports indexed range deletes
  ([storage and cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)).
- A service worker stops after 30 s idle, losing anything buffered in memory
  ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).

## Decision

The owner approved the following on 2026-10-11.

### Diagnostics page

- A new extension page `diagnostics.html`, linked from the settings page, shows
  per-device diagnostics. It stays in the extension because everything on it belongs to
  the device; the service web UI (ADR 0013) cannot see it.
- The page never opens the vault database. It sends the read-only message
  `{ type: "diagnostics.status" }`, which the service worker accepts only from the exact
  `diagnostics.html` URL, and receives a value-free summary. Its only writes are
  clearing the logs and enabling debug logging for 24 hours.
- It shows: Pateat version with the build revision (`PATEAT_REVISION`, as the service
  already uses) and install type; Chrome version and platform; granted permissions; the
  Bitwarden SDK version and protocol label; per connection the environment kind, state,
  auto-unlock, sync sign-in, last accepted time, item counts while unlocked and, on
  screen only, the unlock KDF; the Pateat service pairing state, revision from
  `GET /health`, last sync, settings revision and recipe cache; setting counts;
  `storage.local` usage; log size; and doctor-style checks with existing reason codes
  (site access, crypto host, vault cache, sync sign-in, service reachability, clock skew
  over 30 s against the service `Date` header, overdue recipe sync, recent errors).
- The service worker makes the new requests (`GET /health` on the paired service, and
  later `GET {api}/config` for the Bitwarden server version) only for enabled
  connections with site access, through the same checks as sync.
- "Copy for bug report" and "Download logs" open a preview of exactly what leaves the
  page. Copy uses `navigator.clipboard` on the page; download uses a `Blob` link, so no
  `downloads` permission is added. The placeholder status (`getFoundationStatus`,
  `isStatusRequest`, `RuntimeStatus`) is removed.

### What is never shown or exported

- Never recorded: passwords, keys, tokens, TOTP secrets or codes, field values, passkey
  private keys, emails, usernames, item names, connection labels, custom field names,
  service response bodies, and URL paths, queries or fragments (amended below: a
  login-related page's URL is recorded).
- Pseudonymized with HMAC-SHA-256 under a random per-device key: item IDs
  (`item:3f9a0c1e`) and connection IDs (`bitwarden:5c1e9a`).
- Origins are logged in full only when the origin is in the recipe cache, site defaults,
  bindings or excluded sites; any other origin is logged as `origin:7d2b91aa`, so the
  log does not become a browsing history.
- Copy and download replace origins, passkey RP IDs and recipe IDs with `site-1` and
  `recipe-1` within one export unless the user opts in (amended below: they are shown
  unless the user hides them). Self-hosted Bitwarden and Pateat
  service host names are never shown. The unlock KDF parameters are never exported
  (amended below: the KDF family is).
- Exceptions keep `error.name` and stack positions; `error.message` is kept only when it
  equals one of Pateat's own error codes, because engine messages can quote input.
- Each event has a Valibot schema that allowlists its fields; unknown fields are dropped
  and a field over 512 characters becomes `"[truncated]"`.

### Logs

- Logs live in a separate IndexedDB database `pateat.diagnostics.v1` with an `entries`
  store indexed by time and level, and a `meta` store for the HMAC key and the previous
  build revision. Each entry is written in its own transaction with no in-memory buffer,
  and is mirrored to the console.
- Only the service worker writes logs, from decisions it already makes. No new message
  lets a content script write a log entry. Page-triggered events are limited to 20 per
  minute per tab and origin; the excess is counted in a `log.dropped` entry.
- Retention: 14 days; at most 5,000 entries, deleting `debug` then `info` first, with
  `warn` and `error` kept in a separate allowance of 1,000; `debug` entries expire after
  24 hours. Default level is `info`. Pruning runs at worker start and every 500 writes.
  No `unlimitedStorage` permission is added. Clearing logs also replaces the HMAC key.
  Logs are never synced.
- Library: no new dependency. A small logger with Valibot event schemas over plain
  IndexedDB, as in `vault/database.ts`. LogTape 2.4.1 was considered but has no
  IndexedDB sink and its free-text API would still need a separate allowlist.
  (2026-10-13: the owner chose `idb` for IndexedDB access here and in the vault and
  provider-session stores, replacing the hand-written wrappers; the logger, its
  schemas and the single-transaction writes are unchanged. See
  [development](../development.md#dependency-policy).)

## Consequences

- Bug reports carry the exact build revision and environment without secrets.
- Logs survive browser restarts but stay on the device and disappear with the extension.
- A pseudonym cannot be traced across a log clear or another device.
- Delivery is split into the diagnostics page, the logs and the Bitwarden server
  version, each in its own PR.

## Amendment: server information

After testing the page in Chrome on 2026-10-11, the owner found the bug report too thin
to act on and asked for Bitwarden and Pateat server details. On 2026-10-11 the owner
approved all of the following; this section records each part with its
implementation.

- Per enabled connection with the provider permission, the worker reads
  `GET {api}/config` without credentials. It keeps only `version` and the server kind
  from `server`: `null` means Bitwarden, the name `Vaultwarden` means Vaultwarden, and
  any other name is shown only as `third-party`. A third-party server's version is
  labelled as the Bitwarden version it is compatible with. The response's
  `environment`, which holds host URLs, is never read.
- A check reports whether `/config` was reachable, by reason code.
- The bug report now carries the unlock KDF family (`PBKDF2` or `Argon2id`), because
  unlock failures differ by family. Its parameters stay on the page only.
- The bug report ends with recent log lines built by the service worker: the last
  update (`runtime.updated`), the newest 10 warnings and errors of 24 hours, and passkey
  delegations of 24 hours counted by reason (passkey requests are `info`, so only their
  counts are copied). Sites and recipes in these lines are numbered as `site-N` and
  `recipe-N` separately from a log download, and the page says so.
- A new `vault.sync` event records each settings-page Sync: `info` for a result,
  `warn` for a failure, with the outcome code and, for an account mismatch, the check.
  The HTTP status the proposal mentioned is not recorded, because the Sync reply
  carries only a code.
- An authenticated `GET /v1/device` returns, for the calling device only, when it was
  paired, the owner's live recipe count and settings revision, and whether recipe
  generation would run now, checked in the order a generation call checks it:
  `monthly-limit` or `daily-limit` at a spend stop, `credentials-not-configured` without
  stored Claude credentials, `issuer-unavailable` when the token issuer's configuration
  is missing or its signing key does not import, otherwise `ok`. It returns no IDs,
  labels, amounts or other devices, and never exchanges a Claude token. The page
  compares the counts with the device's copy and reports a difference as information,
  since the next sync catches up. A credential the service already rejected is not sent.

## Amendment: logins that did not finish

On 2026-10-12 the owner found the page showing "Errors in the last 24 h: 0" while
logins on the day's sites were failing: a judged page answered `unclear` twice and
earlier logins had stopped as `blocked`. Only `error` entries were counted, and a
stopped login is a `warn` entry, while a login whose result settles as unknown was a
`debug` entry. The owner also saw one held tab log a `tab-busy` refusal for each of
about 15 ad frames on its page. The simplest change that makes the summary match what
happened:

- A login whose result settles as unknown (`unknown-submit`) is logged once, at that
  moment, as a `warn` `login.attempt` entry marked `settled`. A `blocked` login was
  already `warn`. Other events keep their levels.
- Each new page of the tab resumes the attempt and reports it again. A resumed attempt
  whose state and outcome did not change is `debug`, so one stopped login is one
  warning however many pages follow. The count is per stop, not per login: a settled
  login whose later page shows a challenge stops again and warns again.
- The page's row becomes "Problems in the last 24 h" with both counts, such as
  `0 errors, 3 warnings`; the bug report's `Logs:` line and the `logs` check carry the
  same counts. The check is `warn` when there is an error and `info` for warnings only,
  since a login can stop for reasons outside Pateat, such as a site's own challenge.
- A `tab-busy` refusal of a frame, not the tab's page, is `debug`, and the entry marks
  `frame`. A refusal of the tab's page stays `info`.

## Amendment: sites shown in log downloads

On 2026-10-12 the owner asked to reverse the log download's checkbox: site addresses
and recipe IDs are what a log is read for, and hiding them should be the choice made on
purpose.

- **Download logs** now shows origins, passkey RP IDs and recipe IDs as logged. The
  checkbox reads **Hide site addresses and recipe IDs**; checking it numbers them as
  `site-N` and `recipe-N` within that export, as before.
- Origins of sites not set up when an entry was written stay pseudonymous
  (`origin:7d2b91aa`) either way, so the log still does not become a browsing history.
- The bug report's recent log lines keep their `site-N` and `recipe-N` numbering.

## Amendment: a page limit per level

On 2026-10-12 a login on the owner's hotel site wrote 21 page events within a minute
while debug logging was on: frame `tab-busy` refusals and repeated `reconciling`
reports, all `debug`, used up the page's 20, and the 21st, an `info` judgement, was
dropped. The owner could not tell from the log why the site was not filled.

- `debug` page events now have an allowance of 20 per minute per tab and origin of
  their own, so they never crowd out `info`, `warn` or `error` events of the same page.
- A `log.dropped` entry for dropped `debug` events is `debug`; one for any other events
  stays `warn`.

## Amendment: what the log records

On 2026-10-12 the owner found that logs often lacked the reason for what happened, and
asked for a standard of what to log. The owner had already set the rule (05:44 UTC):
whenever Pateat does nothing and no login happens, the log says why. The owner approved
the proposal below on 2026-10-12 (06:54 and 06:55 UTC), with two changes: debug logging
can be turned on and off, and a page's URL path, query and fragment may be recorded.

Goal: on every login-related page, the log tells what Pateat did or, if it did nothing,
why, without debug logging.

A login-related page is the tab's own page (not a frame inside it) when the origin has a
recipe, or when a login is in progress in that tab. Other pages are ordinary browsing
and are not logged, so the log does not become a browsing history; a sign-in form on a
site without a recipe is not logged either.

What is logged, and at which level:

- On a login-related page, the reason Pateat did nothing: no recipe, no account chosen,
  an excluded site, no site access, another login in the tab, waiting after a logout,
  and so on. `info`, one line per reason per page; the same reason again on the same
  page is `debug`, also after the worker restarts and every page announces again. A
  `stale-document` race that a later announcement resolves stays `debug`; the page
  giving up after its retries is `info`.
- Decisions: a login started (with its route and variant), an account chosen
  automatically (the candidate count and the `item:` pseudonym only), a logout
  recognized. `info`.
- Results: unchanged. `authenticated` is `info`; `blocked` and a result settled as
  unknown are `warn`.
- Requests that leave the device (generation and judgement, the Pateat service sync,
  Bitwarden sync and token refresh, passkey answers): one line per request with its
  result. A routine success that changed nothing is `debug`, one that changed something
  `info`, a failure `warn`. A request that never got an answer logs that it was sent.
- An exception that stops a login: `warn`, with Pateat's error code and the exception
  name only.
- Step-by-step progress, frame refusals and repeated states: `debug`.
- Reasons are not folded into coarser codes: a step timeout, a failed step check, a
  page change, an expired authorization and a real cancel each get their own code.
  Counts and flags are kept.

Who writes: still only the service worker, from the answers it gives. A content script
does not get a message to write a log line, because a page could forge it; the reasons
a content script stops are logged by the service worker when it answers. Reasons that
only a page's own script knows, such as a passkey request it leaves to the browser, are
not logged.

URLs:

- For the tab's own page of an origin that is logged in full, the log records the URL's
  path, query and fragment. A pseudonymized origin (`origin:7d2b91aa`) gets no URL.
  (Amended below: only the names of the query's and fragment's parameters are kept.)
- Queries and fragments can carry one-time codes or tokens that sites put in links, a
  username or email address, or another site's address; the owner accepted that.
  (Superseded on 2026-10-13: values are no longer kept.) The value is cut at 512
  characters; unlike other fields it keeps its first 512 characters instead of becoming
  `[truncated]`. (Amended below: a longer one keeps its path alone.)
- **Hide site addresses and recipe IDs** also leaves the URL out of an export. The bug
  report's recent lines never carry it.

Debug logging:

- The diagnostics page turns debug logging on and off. Turning it on lasts 24 hours,
  then it turns itself off.

Limits:

- `debug` and `info` entries: 14,000 (was 5,000), enough for about 14 days at an
  estimated 1,000 a day on a testing day. `warn` and `error`: 1,000, unchanged. The
  number of entries, not the 14 days, decides how long logs last.
- Page events other than `debug`: 30 per minute per tab and origin (was 20), since one
  login now writes 6 to 8 such entries. `debug` keeps its own 20.
- `log.dropped` also names the dropped events.

Delivery, one pull request each: debug logging on and off; reasons for doing nothing
(including an exception that stops a login); decisions; URLs; requests and sync
results; finer reasons; limits. The page limit per level (#291), debug logging on and
off, reasons for doing nothing, decisions, URLs, requests and sync results, finer
reasons and limits are done.

When reasons for doing nothing were delivered, frame refusals were read as the
proposal's example put it, refusals of embedded frames such as ads: a frame whose own
origin has a recipe, as a login form embedded in a page, is logged like the tab's page,
as it already was, so a framed login's refusal stays `info`.

## Amendment: a login attempt's state changes are never dropped

On 2026-10-12 a Microsoft login on an agent's browser used up its page's 30 events
within a minute, and three `login.attempt` lines and a `login.refused` line at the
login's outcome were dropped, so the log could not tell what happened.

- `login.attempt` entries other than `debug` (state changes such as `blocked`,
  `watching`, `authenticated` and a settled result) neither count against the page's 30
  nor are dropped by it. They have an allowance of their own, 60 per minute per tab and
  origin; a drop there is a `warn` `log.dropped`.
- That allowance stays because one attempt writes only a few, but a page can keep
  starting attempts: after a logout, each new document runs a fill-only login, so a
  redirect loop would otherwise write one entry per document load.
- Step-by-step `login.attempt` detail is `debug` and keeps the `debug` allowance; every
  other page event, `login.refused` included, keeps the page's 30.

## Amendment: URLs keep parameter names, not values

On 2026-10-13 an OpenAI login's `login.attempt` (`authenticated`) and `login.choice`
lines in the owner's Chrome held the OAuth callback URL with its authorization `code`
and `state`. The owner chose (15:17 UTC) to keep only the parameters' names:

- The log keeps the URL's path and the names of its query's and fragment's `name=value`
  parameters with empty values: `/callback?code=abc&state=xyz` becomes
  `/callback?code=&state=`.
- A part without `=` or with an empty value, which may be a token itself (`?<token>`, or
  a base64 token's `=` padding), and a name that is not 1 to 40 letters, digits, `_`,
  `.`, `-` or brackets starting with a letter or `_` are left out.
- A fragment that is a route (`#/signin`, `#!/signin`) keeps the route, up to a second
  `#`, and its own query's names; any other fragment keeps its parameter names, or `#`
  alone.
- When the result is over 512 characters, only the path is kept, cut at 512, so that no
  part of a name is cut.
- A path segment or a route can still hold a token, as a magic link's can, and a long
  name with a non-empty value is kept as a name even when it is a token.
- Lines already stored are not rewritten; a stored URL with anything other than this
  shape stays on the device but is left out of downloads. A stored query or fragment
  that was a single token ending in `=` (`?dG9rZW4=`) has this shape and still leaves in
  a download. The diagnostics page's clear removes such lines.
