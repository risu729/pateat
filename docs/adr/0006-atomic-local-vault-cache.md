# ADR 0006: Commit local vault state with atomic revision checks

Status: accepted and implemented in
[PR #19](https://github.com/risu729/pateat/pull/19). Native browser acceptance uses
synthetic accounts; production connection integration remains separate.

Date: 2026-10-10

## Decision

Use browser-native IndexedDB for the extension's local encrypted vault cache and
retained unlock key. This adds no library, service, permission or native helper.
Existing policy settings remain in restricted `chrome.storage.local`.

Store one strict, versioned record per canonical connection. Each mutation has a
fresh revision UUID. Within one read-write transaction, read and compare the
expected revision, write the replacement and check its exact stored value. Report
success only after the transaction completes. Perform SDK verification before
opening this transaction; do not keep a transaction alive across cryptographic
work. Request strict durability, while making no guarantee against operating
system rollback or local profile compromise.

Retain the encrypted account context, verified identity and security-version
floor when disabling automatic unlock, but remove the retained key. Disabling
during first enrollment writes an empty disabled record so an older operation
expecting an absent record cannot restore a key. A refresh must preserve disabled
state; retaining a key again requires explicit enable intent. In-memory
invalidation takes effect immediately, even if durable disable fails. Concurrent
cleanup joins retirements already in progress before acknowledging disable.

Accept only complete supported data within the received envelope. Verify the
account, organization keys and every supported received cipher through the SDK
before persisting a candidate. Discard decrypted cipher views after verification.
Read the retained user key from the already verified SDK state through a narrow
session operation; do not retain a master password, authorization hash, provider
token or page grant. Unsupported items remain unavailable and never borrow
credentials from an older record.

Treat uncertain commit outcomes as unavailable: retire candidate and previous
live sessions until a fresh read and SDK verification establish usable state.
Revision conflicts reject stale candidates. A known unchanged durable record
does not by itself authorize using a stale in-memory session after another writer
has changed the record. Field listing and resolution recheck the active durable
revision and accepted identity before dispatch and after the SDK response. A
changed or unreadable record retires the live session and withholds the result.
The record an accept of the same manager is writing is not another writer's: it
withholds the result only, and that accept retires the old session when it
adopts the record or fails after writing it, so a request in flight cannot cancel
the sync merely by reading the new record.

## Alternatives and consequences

A single `chrome.storage.local` entry would keep related fields together, but
does not provide an expected-revision transaction. An in-memory queue cannot
prove ordering between an already dispatched write and a replacement service
worker's disable operation. IndexedDB supplies the required atomic comparison
and serialized read-write transactions without introducing a database library.

This storage intentionally retains a usable decryption key under the owner's
approved automatic-unlock requirement. Extension-origin storage is not an OS
keystore. It does not isolate data from other trusted extension code or a
compromised local profile. Provider authentication and remote revocation remain
separate from local unlock and local disable.

Restoring the same immutable accepted record preserves its snapshot identity,
with fresh process/session references. Replacing accepted data creates a new
snapshot. Live settings integration must reconcile field exclusions before
releasing credentials from that replacement; this decision does not waive that
gate.

## Amendment: idb for IndexedDB access

On 2026-10-13 the owner chose `idb` to replace the hand-written request and transaction
wrappers, for this cache, the provider-session store and the diagnostics database
([ADR 0019](0019-local-diagnostics-and-logs.md)). This changes the "no library"
statement above and in [ADR 0008](0008-durable-provider-sessions.md) for IndexedDB
access only; it is not a change of storage. The transaction rules stand: one read-write
transaction reads, compares the revision, writes and reads back; its work awaits only
its own requests, since any other await lets it auto-commit; success is reported only
after `complete`; and strict durability and the deadline, cancellation and quota
mappings are kept. See [dependency policy](../development.md#dependency-policy).

## Amendment: lock and the vault timeout

On 2026-10-23 the owner chose the official extension's Lock, Log out and vault timeout
([ADR 0075](0075-vault-lock-and-timeout.md)). The retained key above is kept on disk
only while the timeout is **Never**, the default. With any other timeout the record is
`locked`: it keeps the encrypted context, identity and security floors without the key,
and the key of a vault unlocked in this browser session is held in memory
(`chrome.storage.session`), so a browser restart locks it. Unlock opens the saved
context offline with the master password. "Disabling automatic unlock" is now
**Log out**, with the same effect, and a password sign-in always retains the key as the
timeout says; "explicit enable intent" above is that sign-in.

## Amendment: one unreadable item does not fail the vault

On 2026-11-11 the owner decided that an item Pateat cannot read must not stop the rest
of the vault, after a vault stopped syncing for two days because an item failed strict
decryption: make only that item unusable, and broadly use whatever can be used, even
when only some fields can be read. This replaces "Accept only complete supported data"
for items that strict decryption refuses:

- The crypto Worker still decrypts every received item strictly when it opens a
  snapshot (after a sync, a browser restart or an unlock). An item it refuses with a
  decryption check (`BITWARDEN_DECRYPT_CHECKS`, or an item type it cannot read) is
  removed from that session and answered as unusable with its ID, check and server
  revision date. Any other failure, such as a locked session, still fails the open. A
  fault in the SDK partway through reads like every later item failing, so once an item
  is refused an item that verified must still decrypt, and a snapshot none of whose
  items verify fails whole; either keeps the open vault.
- The vault manager accepts the snapshot when the verified items and the unusable ones
  add up to the received items, each unusable ID is one of them and none repeats.
  Otherwise the open fails with `cipher-count`, as before.
- The stored record is unchanged: the unusable items are found again on each open, so
  an item fixed in Bitwarden is used after the next sync, and no older copy of an
  unusable item is ever used.
- Logins, passkeys and field reviews do not see an unusable item; a site's settings
  that name it find no field, which does not lock the session.
- The settings page lists up to 100 of them under their connection by ID and check,
  each linking to the item in the web vault (`/#/vault?itemId=…`), since their names
  cannot be read.

A partly readable item is used without the fields that do not decrypt; see
[Partly readable items](#partly-readable-items-2026-11-11).

### Items the account mapper cannot admit (2026-11-11)

The account mapper also leaves out one item instead of failing the sync, recording it
in the stored record's `unavailableItems` with a reason, beside the item types Pateat
does not read:

- `unknown-organization`: the item names an organization whose key the sync did not
  send (no membership, a disabled organization or no key). That organization's
  collections are still checked like any other, then left out with it, as the official
  clients list only organizations whose key they hold.
- `malformed-item`: the item's shape does not admit, for example a field of the wrong
  type, a stored Data copy that is not JSON or contradicts the response, or an
  attachment of another object type.
- `unsupported-item`: the server withheld part of the item (`partialData`), or sent a
  form Pateat does not read: a claimed sealed form, flat legacy Data without a name or
  with a sealed form's key, or a ciphertext type that is not authenticated.

Items are told apart only by ID, so an item without a valid ID, or two with the same
ID, still fails the sync, as does anything wrong outside the items. The vault manager
lists these items with the ones decryption refused, the reason as the check; an item
type Pateat does not read is not listed, since nothing in Bitwarden fixes it.

An organization key that is received but does not open with the account's private key
is treated the same way when the crypto Worker opens the account: that organization's
collections are left out and strict decryption refuses each of its items with the
check `organization-key`, so they are listed as unusable. Pateat never opens such an
item with another key. The open still fails (`session-open`) when the account's own
keys do not open, when its private key is not an RSA key, when no received
organization key opens (the account's private key is then the likelier fault, and the
two cannot be told apart without its public key), and when an organization key opens
but the SDK then refuses it. The crypto Worker does not count these refusals as a
possible SDK fault, since they are made before any SDK call, so a vault whose only
items are such an organization's opens empty with them listed.

### Partly readable items (2026-11-11)

When strict decryption refuses an item with `sdk-decrypt` or `attachment`, the crypto
Worker asks the session to repair it before calling it unusable. Each encrypted value is decrypted
alone with strict SDK decryption, as the name of an otherwise empty secure note that
carries the item's own `key` and `organizationId`, so the item key never leaves the
SDK and each value is checked under exactly the keys the whole item would use.
Bitwarden ciphertexts are not bound to their field, so this accepts nothing that
decrypting the whole item would refuse.

- A value that does not decrypt is left empty: the notes, a login's username,
  password or TOTP key, a card's or identity's values, a custom field's name or value.
  A URI is left out whole when it or its checksum does not decrypt, as the SDK does,
  and so is a password-history entry. Attachments, which Pateat does not use, are left
  out together. Passkeys stay: only passkey operations decrypt them, and each refuses
  an item with an unreadable one, as before.
- The item is not repaired, and stays unusable, when its name does not decrypt (no
  other value may stand in for it), when it is a sealed blob (one ciphertext), when
  nothing was left out, or when the rest still does not decrypt. An item key that does
  not decrypt makes every value fail, so such an item stays unusable too.
- The session then uses the repaired copy in memory; the stored record is unchanged
  and the repair is made again on each open. A field left empty is not offered: it is
  missing from the item's fields and from a fill, never read as an empty value, and an
  item with an unreadable custom field never compares as unchanged in a review.
- The settings page lists up to 100 such items by ID, each with the paths of the
  values that were not read (such as `login.password` or `fields.2.value`), linking to
  the item in the web vault.

## Sources

- [IndexedDB transaction scheduling](https://w3c.github.io/IndexedDB/#transaction-scheduling).
- [IndexedDB transaction lifecycle and atomic commit](https://w3c.github.io/IndexedDB/#transaction-lifecycle).
- [SDK boundary and local key handling](0005-bitwarden-local-crypto.md).
- The web vault opens an item from its `itemId` query parameter
  ([vault.component.ts](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/apps/web/src/app/vault/individual-vault/vault.component.ts#L1762-L1764)).
