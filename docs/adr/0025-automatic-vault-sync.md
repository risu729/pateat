# ADR 0025: Automatic Bitwarden vault sync

Status: accepted by the owner on 2026-10-11 (12:10 UTC, option B with a five-minute
alarm). Amends [ADR 0008](0008-durable-provider-sessions.md), which synced only on an
explicit Sync action. The check after a page with a recipe finds no matching item and
the custom-field comparison that keeps unchanged protected items usable, both listed as
later work at acceptance, are implemented as
[After no item matches](#after-no-item-matches) and
[Protected items after a sync](#protected-items-after-a-sync) describe. The settings
page's reason for a save that met a revision conflict, also later work at acceptance, is
implemented as [Settings saves after a sync](#settings-saves-after-a-sync) describes;
its details were chosen by an agent and are not confirmed by the owner. Amended on
2026-10-12 by [ADR 0034](0034-answer-page-passkey-requests.md): a conditional passkey
request waiting for a login is not a request being handled; the hold covers it only
while it reads the vault and signs.

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
minute (every ten seconds after a page finds no matching item, see
[below](#after-no-item-matches)), on any of:

- a `login.document.ready` announcement, which every HTTP(S) page and frame sends
  ([ADR 0050](0050-http-pages-for-http-items.md));
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

The settings page's Bitwarden card shows "Vault synced" with the local time the vault
was last known to match the server (requested by the owner on 2026-10-13): when the open
snapshot was accepted, or when the last check that found the revision unchanged was
sent, whichever is later. That check time is recorded only once the check has answered,
so a check in flight or cut off does not advance it and a later failed check does not
take it back. The diagnostics page instead gives the open snapshot's age and the last
check with its outcome.

### Not interrupting a login

- A page that may start a login (an announcement carrying a start path) waits up to five
  seconds for a check already in progress, then continues with the snapshot it has.
- While a login attempt is active, a check does not replace the vault. It skips `/sync`
  when it can tell beforehand, or drops the response afterwards, and records
  `deferred`; a deferred check is due again after ten seconds instead of a minute. An
  attempt whose result settled as unknown is active only while one of its pages is
  checked or judged ([ADR 0027](0027-per-account-login-routes.md)).
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

### After no item matches

A page with a recipe whose first step is ready may find no matching vault item, as when
the item or its URI was added on another device after the last sync. Two refusals count,
and only for a fresh attempt, not a resumed one or the page after an account switch:
without a saved default, no eligible item's URI rules match the page (`default-not-set`
with live URI matching), and a saved default's item no longer matches the page
(`item-origin-mismatch`). The reported reasons stay the same.

- The refusal asks for a check of each connection last checked at least ten seconds ago,
  counted from the same stored check time as every other check. A 429 back-off, a
  deleted account, offline and the deferral for a login in progress apply unchanged.
  The request is asked for while the page still holds replacements off, and is kept in
  the worker's memory only; a request made during a check runs one more pass after it.
- When an automatic check of any connection applies a new snapshot within ten seconds of
  the refusal, with the replacement begun after it (so not one the page may already have
  seen), the background sends `login.reconnect` only to the refused tab, frame and
  document, and only while that document is still the refused one; one that announced
  again, was replaced or went away gets nothing. The document announces again, and its
  login starts if an item now matches. Otherwise, and after a manual **Sync**, nothing
  more happens until the page announces again.
- A worker restart loses the request. Its startup reconnect asks tabs on sites with a
  saved default or an attempt record to announce again; a page refused without a saved
  default asks again the next time it announces.
- Other refusals ask for no check: several matches, rules that could not be evaluated, a
  locked or unavailable vault, an account not connected here, live URI matching not
  available, a page without a recipe or whose first step is not ready, a busy tab, the
  choice after a logout, and the probe build's synthetic origin.

### Protected items after a sync

Bitwarden re-encrypts the whole item on every save, so editing only the password or a
URI on another device changes the encrypted custom-field evidence that
[ADR 0023](0023-synced-vault-policy.md) compares, and the item would wait for review.
When a sync replaces a snapshot that is still open, `accept()` therefore also asks both
sessions, after verifying the new one and before writing it, for a digest of each
protected item's decrypted custom fields (name, value, type and linked source, in
order). An item whose two digests are equal is treated as unchanged: its custom-field
exclusions move to the new snapshot without review. An unknown or undecryptable item,
a closed old session or any failed request counts as different. Only a failure that may
have ended the new session (a timeout, a locked or failed crypto host) fails the sync,
before the write, so the stored old snapshot stays. Later automatic checks and **Sync**
then skip the comparison, counting every item as different, until a sync commits, so a
failure that repeats cannot block every sync.

Each digest is HMAC-SHA-256 under a random 32-byte key that the offscreen document
creates once and adds to every request it forwards to a Worker, replacing any key the
background sent. The background compares the digests and keeps only the item IDs that
matched. No value leaves the crypto host, and a digest seen in a log, storage or a
memory dump without the offscreen document cannot be tested offline against guesses of
a short value such as a PIN. This does not protect against a compromised background,
which could open its own session with guessed values and compare digests; such a
background already holds the unlock key ([ADR 0006](0006-atomic-local-vault-cache.md)).
The comparison counts only when it was made against the snapshot being replaced, and a
digest request that may have ended the old session also drops it from the manager. A
device without the old snapshot open still relies on review.

### Settings saves after a sync

Adopting a synced snapshot writes the field policy and so a new settings revision, and
the settings page learns of it only when it saves: the page expects the revision it
loaded, and the save fails as a revision conflict. The page used to say "Settings
changed in another window" whatever wrote the revision. Each settings revision now
records its cause in the snapshot's `changes` list, which keeps the latest 16 revisions
and no setting value:

| Cause | Written by |
| --- | --- |
| `settings-save` | A save from a settings page or the toolbar popup |
| `vault-added` | A new connection's policy entry |
| `vault-sync` | A snapshot adopted after a password sign-in or **Sync** |
| `automatic-vault-sync` | A snapshot adopted by an automatic check |
| `field-review` | A custom-field review ([ADR 0023](0023-synced-vault-policy.md)) |
| `service-sync` | Settings merged from the Pateat service |
| `account-choice` | An account chosen outside the settings page, saved as the site's default ([ADR 0021](0021-account-choice-outside-settings.md)) |

The store writes the entry itself, so a background mutation cannot drop or rewrite it. A
`revision-conflict` answer lists the distinct causes of the revisions after the expected
one, oldest first, with `unknown` first when some of them are older than the list keeps
or the store is behind the expected revision. The settings page names each cause in its
status line, as in "Saved settings changed before this save: a Bitwarden vault was
synced automatically.", and still keeps the draft and asks for a reload. The toolbar
popup already reloads after a conflict and is unchanged.

### Differences from the official extension

| Topic | Official extension | Pateat |
| --- | --- | --- |
| Immediate updates | SignalR notifications (`wss://notifications.bitwarden.com/hub`), with per-item fetches | None. Later work (option C): it needs a SignalR client library choice and the notification host in `providerPermissionOrigins()` |
| Periodic check | Five-minute alarm, syncing only when the last sync is over six hours old | Five-minute alarm and page events, each at most once a minute, always asking the revision date |
| Token renewal | Before every `/sync` | Only near the access token's expiry |
| No matching item | No sync | A check at most every ten seconds on sites with a recipe, then a reconnect of the refused document only |
| Startup | A check 500 ms after the worker starts | The first page event or alarm |
| Failed renewal | Retried at the next trigger | The same, since ADR 0008's restore after a failure without rejection |

## Load on Bitwarden

Per connection and hour of browser use: at most 60 revision-date requests (up to six a
minute while a check is deferred for an active login or a request still being handled,
such as an open passkey prompt, or while pages with a recipe find no matching item) and
about one token renewal; `/sync` only when the vault changed. Bitwarden cloud allows 200
`GET` requests a minute and 10 token requests a minute per IP
([API](https://github.com/bitwarden/server/blob/5e68c1e65dd5ea476c3a00283b2a2ba575574c1d/src/Api/appsettings.json),
[Identity](https://github.com/bitwarden/server/blob/5e68c1e65dd5ea476c3a00283b2a2ba575574c1d/src/Identity/appsettings.json)),
so even five connections stay far below it. Self-hosted and Vaultwarden limits depend
on the installation.

## Later work

- Record the evidence of items found equal as reviewed in the synced record of
  [ADR 0023](0023-synced-vault-policy.md), once that record is implemented.
- Show items awaiting review on the toolbar icon.

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
