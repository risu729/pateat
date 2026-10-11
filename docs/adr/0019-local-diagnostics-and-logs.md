# ADR 0019: Local diagnostics page and logs

Status: accepted by the owner on 2026-10-11. The diagnostics page and the logs are
implemented; the Bitwarden server version is not yet.

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
  service response bodies, and URL paths, queries or fragments.
- Pseudonymized with HMAC-SHA-256 under a random per-device key: item IDs
  (`item:3f9a0c1e`) and connection IDs (`bitwarden:5c1e9a`).
- Origins are logged in full only when the origin is in the recipe cache, site defaults,
  bindings or excluded sites; any other origin is logged as `origin:7d2b91aa`, so the
  log does not become a browsing history.
- Copy and download replace origins, passkey RP IDs and recipe IDs with `site-1` and
  `recipe-1` within one export unless the user opts in. Self-hosted Bitwarden and Pateat
  service host names are never shown. The unlock KDF is never exported.
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

## Consequences

- Bug reports carry the exact build revision and environment without secrets.
- Logs survive browser restarts but stay on the device and disappear with the extension.
- A pseudonym cannot be traced across a log clear or another device.
- Delivery is split into the diagnostics page, the logs and the Bitwarden server
  version, each in its own PR.
