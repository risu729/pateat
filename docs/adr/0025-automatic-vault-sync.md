# ADR 0025: Automatic Bitwarden vault sync

Status: accepted by the owner on 2026-10-11 (12:10 UTC, option B with a five-minute
alarm). Amends [ADR 0008](0008-durable-provider-sessions.md), which synced only on an
explicit Sync action. The trigger after a site with a recipe finds no matching item and
the custom-field comparison that keeps unchanged protected items usable are not
implemented yet.

Date: 2026-10-11

## Context

Pateat fetched the vault only when a connection was created, after a password sign-in
and from the settings page's **Sync** button. An item added on another device stayed
invisible to logins until someone opened the settings page. The owner allowed automatic
sync on 2026-10-11 (12:02 UTC): it only reads the vault, so the official extension's
frequency, or a higher one within Bitwarden's limits, is acceptable.

A full sync is not free for a login in progress. `manager.accept()` always creates a new
snapshot ID and adopting the policy bumps the settings revision, so a login that spans
a replacement stops with `POLICY_CHANGED`, and a passkey assertion fails with
`stale-vault-handle` and is handed to the browser.

The official browser extension (read at
[bitwarden/clients `df96418`](https://github.com/bitwarden/clients/tree/df9641824436b65207f393d35b8d07225129797b))
asks `GET {api}/accounts/revision-date` before each non-forced sync and calls `/sync`
only when the value is newer than its last sync. Organization item changes bump the
revision of every user who can see them.

## Decision

### When to check

Each connection with automatic unlock (an active vault record), a sync session that is
`active` or `refresh-required`, and `enabled` in settings is checked at most once a
minute, on any of:

- a `login.document.ready` announcement, which every HTTPS page and frame sends;
- a `passkey.get` request;
- the `pateat.vault-sync` alarm, every five minutes (`chrome.alarms`, re-created on each
  service worker start if missing). The `alarms` permission adds no install warning.

Browser startup does not check by itself, since the network is often not up yet; the
first page or alarm does (Chrome fires an alarm missed while the browser was closed
soon after it starts). Checks run one connection at a time, and one check runs at a
time however many pages open together. Nothing is sent while `navigator.onLine` is
`false`.

### What a check does

1. Renew the access token only when it is within 60 seconds of expiry (ADR 0008).
2. `GET {api}/accounts/revision-date`.
3. Run the full `GET {api}/sync`, `accept()` and policy adoption only when the value
   differs from the one recorded after the last applied sync. "Differs", not "is newer",
   so a server restore or clock change cannot strand the cache.

| Response | Handling |
| --- | --- |
| A non-negative number | Compared as above |
| `null` or HTTP 204 (ASP.NET's empty `long?`) | Full sync |
| A negative number | Recorded as `account-deleted`; no further automatic checks until a manual sync or sign-in succeeds; local data stays |
| HTTP 401 | The session that was used is discarded, as for `/sync`, and the settings page asks to sign in again |
| HTTP 429 | No check for 15 minutes, as for the Pateat service |
| Network failure, timeout, 5xx | Recorded as `failed`; the next trigger after the one-minute limit retries |

Connection setup, password sign-in and the **Sync** button also read the revision date
and record it after a successful sync, so the next automatic check does not repeat their
work. The **Sync** button still always runs the full sync, like the official
`fullSync(true)`, and waits for an automatic check in progress instead of reporting the
connection as busy. A password sign-in cancels an automatic check and waits for it to
stop, and no check starts while either runs. Forget, removal, disabling and permission
removal cancel it and delete its stored revision.

The record is `pateat.vault-sync-schedule.v1` in `chrome.storage.local`, holding no
secret: per connection the local time of the last check, its outcome, the server
revision of the last applied sync, the local time a run of deferrals began and, after a
429, the local time before which no check is sent. The check time is written before the
request, so a restart does not resend it at once; a check time in the future counts as
due. The diagnostics page shows the last check, its outcome and, after a 429, when the
next check may be sent.

### Not interrupting a login

- A page that may start a login (an announcement carrying a start path) waits up to five
  seconds for a check already in progress, then continues with the snapshot it has.
- While a login attempt is active, a check does not replace the vault. It skips `/sync`
  when it can tell beforehand, or drops the response afterwards, and records
  `deferred`; a deferred check is due again after ten seconds instead of a minute.
- Before replacing, a check waits up to two seconds for page announcements and passkey
  requests being handled to finish; if they have not, it defers the same way. Each
  announcement is handled in the order the frame sent it, so one that waited on a
  check is dropped as stale once a later one from the same frame arrives.
- After two minutes of deferrals the replacement applies even though a login is still
  active, because an abandoned attempt also counts as active. Such a login stops with
  `POLICY_CHANGED`, as it would today.
- The replacement (accept and policy adoption) holds every new page announcement and
  passkey request until it finishes, without a time limit. The hold is taken with no
  await after the last check that nothing is starting.

### Differences from the official extension

| Topic | Official extension | Pateat |
| --- | --- | --- |
| Immediate updates | SignalR notifications (`wss://notifications.bitwarden.com/hub`), with per-item fetches | None. Later work (option C): it needs a SignalR client library choice and the notification host in `providerPermissionOrigins()` |
| Periodic check | Five-minute alarm, syncing only when the last sync is over six hours old | Five-minute alarm and page events, each at most once a minute, always asking the revision date |
| Token renewal | Before every `/sync` | Only near the access token's expiry |
| No matching item | No sync | Planned: a check at most every ten seconds on sites with a recipe |
| Startup | A check 500 ms after the worker starts | The first page event or alarm |
| Failed renewal | Retried at the next trigger | The same, since ADR 0008's restore after a failure without rejection |

## Load on Bitwarden

Per connection and hour of browser use: at most 60 revision-date requests (up to six a
minute while a check is deferred for an active login or a request still being handled,
such as an open passkey prompt) and about one token renewal; `/sync` only when the vault
changed. Bitwarden cloud allows 200 `GET` requests a minute and 10 token requests a
minute per IP
([API](https://github.com/bitwarden/server/blob/5e68c1e65dd5ea476c3a00283b2a2ba575574c1d/src/Api/appsettings.json),
[Identity](https://github.com/bitwarden/server/blob/5e68c1e65dd5ea476c3a00283b2a2ba575574c1d/src/Identity/appsettings.json)),
so even five connections stay far below it. Self-hosted and Vaultwarden limits depend
on the installation.

## Later work

- After a site with a recipe finds no matching item, check at most every ten seconds and
  send `login.reconnect` only to the refused document within ten seconds.
- Compare the decrypted custom fields of protected items between the old and new
  snapshot inside the crypto host. When they are equal, the item stays usable without
  a new review; only "equal" or "different" leaves the crypto host. This complements
  the synced custom-field review records proposed for ADR 0023.
- Show items awaiting review on the toolbar icon, and tell the settings page why its
  save met a revision conflict after an automatic sync.

## Alternatives and consequences

Page events alone (option A) were enough for logins, which only happen on pages, but
the owner chose the alarm as well: the vault is more often current before a page opens,
fewer logins wait or defer, and the refresh token's 30-day sliding lifetime keeps
extending on days without page visits. The cost is that the worker wakes every five
minutes while the browser runs, which also runs the Pateat service's due recipe and
settings sync, and Bitwarden sees requests while the browser is idle, as it does from
the official extension.

Notifications over SignalR (option C) would match the official extension's speed but
need a new library and keep the worker awake; they stay later work.

## Sources

- [Official revision-date check](https://github.com/bitwarden/clients/blob/df9641824436b65207f393d35b8d07225129797b/libs/common/src/platform/sync/default-sync.service.ts)
- [Official alarm](https://github.com/bitwarden/clients/blob/df9641824436b65207f393d35b8d07225129797b/apps/browser/src/background/main.background.ts)
- [`chrome.alarms`](https://developer.chrome.com/docs/extensions/reference/api/alarms)
