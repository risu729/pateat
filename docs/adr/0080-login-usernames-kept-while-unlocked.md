# ADR 0080: The crypto Worker keeps login usernames while a vault is unlocked

Status: accepted by the owner on 2026-10-25 (08:22 UTC, decision card
「ポップアップのユーザー名を、ロック解除中は crypto Worker に持たせますか？」, option
「crypto Worker に持たせる」), after the owner asked at 2026-10-24 22:43 UTC whether the
popup's accounts could be found before it opens
(「これポップアップ開く前から計算しておけないの？」) and agreed at 2026-10-25 03:01 UTC
to keep the matched usernames in memory (「そうですね、それで」). The proposal the owner
read is `designs/popup-account-prefetch-proposal-ja.md` in the project files. Amends
[ADR 0021](0021-account-choice-outside-settings.md) (the popup caches no usernames) and
the owner's decision of 2026-10-23 recorded in
[Decrypted items in memory](../bitwarden-differences.md#decrypted-items-in-memory).

Date: 2026-10-25

## Context

The toolbar popup names each matching account by its login username, so same-named
items can be told apart (ADR 0021). `settings.site-accounts` found the matches, then
read each matched item's username through the connection runtime's field resolution:
one `settings.get` before and one after the reads, two IndexedDB record checks, and one
SDK decryption per item. In cloud Chromium with 300 Vaultwarden items, 9 of them for
`https://x.com/`, the decryptions took about 16 ms and the settings reads and checks
around them about 200 ms of the request's roughly 410 ms. Each `settings.get` builds
the whole catalog, and every `settings.get` waits in the settings store's one queue, so
sending the popup's requests at the same time would not have shortened it.

The crypto Worker already keeps, while the vault is unlocked, the value-free catalog and
every live login item's URI rules, captured when it verifies the snapshot. On
2026-10-23 the owner chose that every field listing or resolution decrypts its one item
and disposes it, over keeping a copy narrowed to the allowed fields.

## Decision

1. When the crypto Worker verifies a snapshot, it keeps each live login item's
   `login.username` (type 1, neither deleted nor archived, up to 1,024 characters)
   beside that item's URI rules, from the decryption the verification already does. It
   keeps no other field. The usernames go with the URI rules: a new verification
   replaces them, and a lock, a vault timeout, a log out, a disabled or removed
   connection and a closed session drop them with the Worker's session.
2. A new Worker operation, `login-usernames`, answers by item ID with the kept username
   or `null`, for at most 2,000 distinct IDs of the open snapshot (more matches are
   asked in several requests). IDs match case-insensitively. The crypto host
   accepts an answer only with exactly the requested IDs, and otherwise locks the
   session as it does for any reply of another shape.
3. `settings.site-accounts` asks for the usernames of the matched items only. It asks
   for an item only when, under the saved settings, the item is eligible, its
   `login.username` is an eligible field, it is not quarantined, and the draft does not
   exclude that field; the bundled demo vaults are never asked. The answer is used only
   when the vault's open snapshot is the one the catalog named, and is dropped when the
   device was paired meanwhile and waits for its first settings sync
   ([ADR 0023](0023-synced-vault-policy.md)).
4. The search reads the settings once, at its start. When a username was listed, it
   reads the settings revision again afterwards; when the revision changed, the search
   runs again, at most three times in all. If the revision still changed, or cannot be
   read, the matches are answered without usernames.
5. Listing usernames is not a use of the vault for the vault timeout of
   [ADR 0075](0075-vault-lock-and-timeout.md): opening the popup does not keep a vault
   unlocked. (Before this change the popup's field reads counted as use.)
6. The usernames stay in the crypto Worker's memory. They are never written to
   `chrome.storage`, IndexedDB or the service, and the service worker keeps them only
   while it answers the request.

## Alternatives

- Reading the matched usernames when a page loads, so they wait for the popup (the
  first proposal): it would read for every page load, use the crypto Worker the login
  needs, count each read as a use for the vault timeout, and miss most popups, since the
  badge count runs once per origin, settings revision and snapshot. Rejected in the
  proposal.
- Keeping the list in `chrome.storage.session`, so a restarted service worker still has
  it: it would write usernames outside the Worker's memory. Not proposed.
- Sending the popup's requests together: the settings queue serializes them, so it gains
  only a message round trip. Dropped.

## Consequences

- Measured in cloud Chromium with the 300-item vault above, `settings.site-accounts`
  takes about 220 ms instead of about 410 ms, and the popup names the accounts about
  570 ms after it opens instead of about 720 ms. The popup's own `settings.get` and its
  other requests every second still take the rest.
- While a vault is unlocked, its crypto Worker holds every live login's username in
  memory, not only those of the matched items. The official extension holds every
  decrypted item while unlocked
  ([bitwarden-differences.md](../bitwarden-differences.md#decrypted-items-in-memory)).
- A setting saved between the search's start and its answer is caught by the revision
  check, a snapshot change by the snapshot check in 3, and a pairing by the
  settings-sync check in 3. A quarantine changes only with a settings revision or a
  snapshot.
- The connection runtime's batched field resolution from
  [#1050](https://github.com/risu729/pateat/pull/1050) is no longer used by the popup;
  `resolveField` still runs through it.
