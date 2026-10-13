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

## Sources

- [IndexedDB transaction scheduling](https://w3c.github.io/IndexedDB/#transaction-scheduling).
- [IndexedDB transaction lifecycle and atomic commit](https://w3c.github.io/IndexedDB/#transaction-lifecycle).
- [SDK boundary and local key handling](0005-bitwarden-local-crypto.md).
