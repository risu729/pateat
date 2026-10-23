# ADR 0075: Lock, log out and the vault timeout

Status: accepted by the owner on 2026-10-23. On a card at 12:43 UTC the owner chose to
match the official Bitwarden extension: the timeout action is **Lock** (the default) or
**Log out**, Lock keeps the sign-in and the encrypted cache and drops only the decrypted
key, and unlocking is offline with the master password. On a card at 12:44 UTC the owner
chose the official timeout choices without "Immediately" (1, 5, 15 and 30 minutes, 1 and
4 hours, On system idle, On system lock, On browser restart, Never and a custom number
of minutes) and approved the `idle` permission they need. The owner also chose that the
timeout is set per device and that a timeout's lock is logged and shown on the
diagnostics page. The other details below were chosen by an agent and are marked so.
Amends [ADR 0006](0006-atomic-local-vault-cache.md) and
[ADR 0025](0025-automatic-vault-sync.md).

Date: 2026-10-23

## Context

ADR 0006 keeps each vault's decrypted user key in IndexedDB next to the encrypted cache,
so the vault unlocks by itself after a browser restart, as the owner required. The only
way to stop that was **Turn off automatic unlock**, which removed the key and forgot the
sync sign-in; using the vault again then needed a full sign-in with the server,
two-step code included. The official extension instead locks the vault after a timeout
the person picks, keeps the sign-in, and unlocks offline with the master password.

## Decision

### States of a vault on this device

A vault record has three states:

- **Active**: the user key is on disk, as before. Only the timeout **Never** keeps a
  vault active.
- **Locked** (new): the accepted encrypted context, identity and security floors stay,
  and the user key is not on disk. While the vault is unlocked in this browser session,
  its key is held in `chrome.storage.session` under
  `pateat.vault-key.v1.<connection id>`, tied to the record's revision, so a key never
  unlocks a record another writer has replaced. `storage.session` lives in memory only;
  Chrome clears it when the browser restarts and when the extension is reloaded or
  updated, and content scripts cannot read it by default.
- **Logged out**: the existing disabled record. The key is gone and the sync sign-in is
  forgotten. **Turn off automatic unlock** is renamed **Log out**; it does what it did.

A vault is unlocked when it is active, or locked with a session key for its current
revision. Every other locked vault answers `vault-locked`: fields, passkeys and sync
wait, and the settings page, the connection list and the diagnostics page show
"Locked". A locked vault is skipped by the automatic sync of ADR 0025 until it is
unlocked (agent's choice: a sync needs the key to verify what it downloads).

### Unlock and lock

**Unlock** asks for the master password on the settings page. It opens the saved
encrypted context with the stored KDF parameters through the same SDK master-password
unlock a sign-in uses, without the server, checks that the opened account is the
accepted one, and keeps the key where the timeout setting keeps it. A wrong password
says "Invalid master password." and changes nothing; the crypto host answers every
failed open the same way, so a rare crypto failure reads as a wrong password too. A
logged-out vault cannot be
unlocked; it needs **Sign in again**.

**Lock** removes the key from the session and, for an active vault, moves the record to
locked. A password sign-in always unlocks the vault it signs in to (agent's choice: the
"Enable automatic unlock on this device" checkbox is removed, since the timeout now
decides how long the key stays).

### The vault timeout

The setting is one record per device, `pateat.vault-timeout.v1` in
`chrome.storage.local`, written by the settings page and never synced. It holds the
timeout (a number of minutes from 1 to 525,600, `system-idle`, `system-lock`, `restart`
or `never`) and the action (`lock` or `log-out`). The settings page offers the presets
and a custom number of minutes (agent's choice of the one-year cap). An absent record is
**Never** with **Lock**, so existing installs keep unlocking after a restart as ADR 0006
required (agent's choice; the official extension's default is On browser restart). A
record that does not parse acts as **On browser restart** with **Lock**, so a damaged
setting never keeps a vault open longer than asked.

Only **Never** keeps the key on disk. Every other timeout keeps it in
`storage.session`, so a browser restart always locks. Changing the setting moves each
unlocked vault's key at once, and the minutes start again from the change; a key that
could not move (another vault operation was running) is moved again at the next check
and within a minute.

The timeout acts on every vault on the device:

- **Minutes**: after that many minutes without use. Use is a field filled, a passkey
  signed, an unlock or a sign-in (agent's choice; the extension has no vault view of its
  own to count activity in). The last use is in
  `storage.session` (`pateat.vault-activity.v1`), and an alarm
  (`pateat.vault-timeout`) wakes the service worker when the time is up. The service
  worker also checks before each vault read, at start and on the alarm, so a stopped
  worker cannot let a vault outlive its timeout. A clock set back counts as the time
  having passed.
- **On system lock**: when Chrome's idle state becomes `locked`.
- **On system idle**: when the idle state becomes `idle` (no input for 5 minutes, the
  official extension's detection interval) or `locked` (agent's choice: a locked screen
  is idle too).
- **On browser restart**: a missing activity record at start means the browser
  restarted or the extension was reloaded. The keys in memory are gone already; with
  **Log out** the sign-ins are forgotten too.

When the action fails for a vault, the others still run and the failure is logged. The
vault that failed is refused (it reads as unavailable) and closed again at every check,
before each vault read and on an alarm a minute later, until that works or the person
unlocks or signs in to it. A vault record that no longer parses counts as closed once
its key in memory is gone, so it never holds the other vaults back; Pateat can no
longer read it, though its stored bytes stay until Delete connection removes them. A
retry leaves alone a vault the person is unlocking or signing in to, and a vault still
owed a close is not synced. The timeout's work
runs one step at a time, so a use, an idle event or a changed setting never undoes
another's record. After it acted, nothing is timed until a vault is used, unlocked or
signed in to again. Nothing is logged when no vault was open.

### Diagnostics

Each timeout action is logged as `vault.timeout` with its trigger (`minutes`,
`system-idle`, `system-lock` or `restart`), action and outcome (`done` or `failed`). The
status shows the device's setting as "Vault timeout", and a connection's state can be
`locked`.

### Permission

The `idle` permission is added for On system idle and On system lock. Chrome shows no
install warning for it.

## Alternatives and consequences

Keeping the key on disk while locked, encrypted with a key held in memory, was not
needed: `storage.session` already holds the key only in memory and is cleared on
restart. Keeping the old "Enable automatic unlock" checkbox next to the timeout would
have given two settings for one question.

A locked vault no longer fills or signs passkeys until the person unlocks it on the
settings page; the popup says how many vaults are locked and links there. With any
timeout but Never, every browser restart needs the master password, as in the official
extension. Never keeps ADR 0006's risk of a usable key on disk, and the settings page
says so.

## Sources

Official code at
[`8246ae9`](https://github.com/bitwarden/clients/tree/8246ae9c9a484a0a69f8b27203034555fb872523):

- The options the browser extension offers
  ([browser-session-timeout-type.service.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/key-management/session-timeout/services/browser-session-timeout-type.service.ts#L13-L34)).
- Its default, On browser restart
  ([main.background.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/background/main.background.ts#L889)).
- Its idle detection interval and On system lock handling
  ([idle.background.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/browser/src/background/idle.background.ts#L15-L82)).
- Minutes counted from the last activity
  ([vault-timeout.service.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/key-management/vault-timeout/services/vault-timeout.service.ts#L84-L126)).
- [`chrome.storage.session`](https://developer.chrome.com/docs/extensions/reference/api/storage#property-session)
  and [`chrome.idle`](https://developer.chrome.com/docs/extensions/reference/api/idle).
