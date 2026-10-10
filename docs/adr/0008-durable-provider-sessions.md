# ADR 0008: Persist provider sync sessions beside the vault cache

Status: accepted and implemented in the provider-session PR. Native browser acceptance
uses synthetic providers; real-account refresh behavior is unverified.

Date: 2026-10-10

## Decision

Persist the Bitwarden access and refresh tokens needed for an explicit sync in a
separate `providerSessions` store of the existing native IndexedDB database, upgraded
from version 1 to 2 in place. The upgrade is one-way: an older build opening the
version 2 database fails with `VersionError`. The vault record of
[ADR 0006](0006-atomic-local-vault-cache.md) still never contains a token. A session
also keeps the binding (user ID and email) and the narrow encrypted account fields
the mapper needs, because refresh responses omit them.

Before a refresh request, commit a token-free claim by compare-and-swap; only the
writer whose claim committed sends the request. Keep the previous refresh token only
in that worker's memory. A restart or an unknown network outcome leaves the claim,
which then requires password sign-in; a claim is never replayed. Once the claim has
committed, closing the options page does not abort the request or the rotation commit;
only the transport timeout bounds them. Commit a rotated token before syncing and keep
the captured token when the response omits it. A session is usable only until 60
seconds before the earlier of its receipt time plus `expires_in` and the access
token's `exp` claim. Claim and retain writes compare the session revision and the
current active vault record revision in one transaction, so a session is never
pinned to an older cache; rotation commits and deletes compare only the session
revision.

Local forget, permission loss for that provider, a rejected refresh or access token,
and a stored context that no longer matches the account clear only the sync session.
A rejection during sync deletes only the session revision that sync used, so a newer
session from a password sign-in stays. A stored session that fails admission is never
reused, but forget deletes it and a password sign-in replaces it. Forget never
cancels a password setup in progress; it reports the connection as busy.
Offline unlock and the connection configuration remain. Disabling automatic unlock
also forgets the session, since sync requires the retained key. Startup only reads
state; provider HTTP happens on an explicit Sync action.

## Alternatives and consequences

Keeping tokens in memory, as before, required password sign-in after every service
worker restart. `chrome.storage.local` lacks the cross-record transaction used to
guard sessions with the cache revision. No library is added.

This retains a refresh token on the device, in the same extension-origin storage
already accepted for the unlock key; it is not an OS keystore. No verified
server-wide revocation endpoint is known, so forgetting is local and is not
presented as a server logout. Client-side claims prevent duplicate refreshes from
this extension; they do not make the server operation exactly-once.

## Sources

- [Server refresh-token reuse and lifetime](https://github.com/bitwarden/server/blob/9ee4e0ebf502fd1c8bf5c1bbcbc2942c3b66bbcc/src/Identity/IdentityServer/ApiClient.cs#L18-L35)
- [Client retention of an absent refresh token](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/auth/services/token.service.ts#L190-L198)
- [Refresh response model](https://github.com/bitwarden/clients/blob/8246ae9c9a484a0a69f8b27203034555fb872523/libs/common/src/auth/models/response/refresh-token.response.ts)
- [Refreshed membership claims](https://github.com/bitwarden/server/blob/9ee4e0ebf502fd1c8bf5c1bbcbc2942c3b66bbcc/test/Identity.IntegrationTest/Grants/RefreshTokenGrantTests.cs#L69-L106)
