import type { BitwardenProfile, BitwardenTransport, PasswordTokenOutcome } from "@pateat/bitwarden";
import { vaultFailure, type VaultErrorCode, type VaultResult } from "../vault/record";
import {
  authenticatedFrom,
  narrowEncryptedAccount,
  tokenSubject,
  type ProviderSessionEntry,
} from "./session-record";
import type { ProviderSessionStore } from "./session-store";

type Authenticated = Extract<PasswordTokenOutcome, { kind: "authenticated" }>;
export type ProviderSessionState =
  | "none"
  | "active"
  | "refresh-required"
  | "reauthentication-required";
export type SessionFailure =
  | "setup-reauthentication-required"
  | "provider-permission-required"
  | "account-mismatch"
  | "cancelled";

/** Refresh before the access token's own expiry so sync never starts with a stale token. */
const EXPIRY_MARGIN_MS = 60_000;
/** A stored record that fails admission is never reused, but forget and retain may replace it. */
const UNADMITTABLE = new Set<VaultErrorCode>([
  "invalid-cache-record",
  "account-mismatch",
  "invalid-profile",
]);
type Acquired = { authenticated: Authenticated; revision: string };

export function createProviderSessions(deps: {
  storeFor(profile: BitwardenProfile): ProviderSessionStore;
  nowMs?: () => number;
  randomId?: () => string;
}) {
  const now = deps.nowMs ?? Date.now;
  const random = deps.randomId ?? (() => crypto.randomUUID());
  /** Usable only before both the response lifetime and the token's own `exp`, if present. */
  const usable = (entry: Extract<ProviderSessionEntry, { state: "active" }>) => {
    const lifetime = entry.receivedAt + entry.expiresIn * 1000;
    const exp = tokenSubject(entry.accessToken).exp;
    return (
      now() + EXPIRY_MARGIN_MS < (exp === undefined ? lifetime : Math.min(lifetime, exp * 1000))
    );
  };
  function stateOf(entry: ProviderSessionEntry | null): ProviderSessionState {
    if (!entry) return "none";
    if (entry.state === "refreshing") return "reauthentication-required";
    if (usable(entry)) return "active";
    return entry.refreshToken ? "refresh-required" : "reauthentication-required";
  }
  async function forget(profile: BitwardenProfile): Promise<VaultResult<true>> {
    const store = deps.storeFor(profile);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // Bounded retry only for destructive forget; a corrupt record is deleted, never reused.
      // eslint-disable-next-line no-await-in-loop
      const current = await store.read();
      if (!current.ok && !UNADMITTABLE.has(current.error.code)) return current;
      const revision = current.ok ? (current.data?.revision ?? null) : null;
      if (current.ok && !current.data) return { ok: true, data: true };
      // eslint-disable-next-line no-await-in-loop
      const removed = await store.compareAndSwap(revision, null);
      if (removed.ok) return { ok: true, data: true };
      if (removed.error.code !== "storage-conflict") return removed;
    }
    return vaultFailure("storage-conflict");
  }
  return {
    async status(profile: BitwardenProfile): Promise<ProviderSessionState | "unavailable"> {
      const current = await deps.storeFor(profile).read();
      return current.ok ? stateOf(current.data) : "unavailable";
    },
    /** Persist a password-authenticated session against the cache it was accepted with. */
    async retain(
      profile: BitwardenProfile,
      authenticated: Authenticated,
      binding: { userId: string; email: string },
      cacheRevision: string,
      /** When the token response was received, not when setup finished. */
      receivedAt: number,
    ): Promise<VaultResult<true>> {
      const encryptedAccount = narrowEncryptedAccount(authenticated.encryptedAccount);
      if (!encryptedAccount) return vaultFailure("invalid-response");
      const store = deps.storeFor(profile);
      const current = await store.read();
      if (!current.ok && !UNADMITTABLE.has(current.error.code)) return current;
      const next: ProviderSessionEntry = {
        schemaVersion: 1,
        revision: random(),
        profile,
        binding: { userId: binding.userId.toLowerCase(), email: binding.email.toLowerCase() },
        encryptedAccount,
        state: "active",
        accessToken: authenticated.tokens.accessToken,
        ...(authenticated.tokens.refreshToken
          ? { refreshToken: authenticated.tokens.refreshToken }
          : {}),
        receivedAt,
        expiresIn: authenticated.tokens.expiresIn,
      };
      const written = await store.compareAndSwap(
        current.ok ? (current.data?.revision ?? null) : null,
        next,
        { cacheRevision },
      );
      return written.ok ? { ok: true, data: true } : written;
    },
    /**
     * Return a usable authorization for one explicit sync, refreshing it at most once.
     * The refresh claim is committed before HTTP, holds no token, and is never replayed:
     * a restart or unknown outcome leaves it in place and requires password sign-in.
     * The caller signal only bounds the pre-claim checks; once claimed, the request and
     * rotation commit run to completion (bounded by the transport timeout) so closing the
     * options page cannot strand a rotated token. Forget still wins by the claim revision.
     * The returned revision identifies the exact session used, for a later bound discard.
     */
    async acquire(
      profile: BitwardenProfile,
      context: {
        cacheRevision: string;
        transport: BitwardenTransport;
        permitted(): Promise<boolean>;
        signal: AbortSignal;
      },
    ): Promise<VaultResult<Acquired> | { ok: false; error: { code: SessionFailure } }> {
      const store = deps.storeFor(profile);
      const current = await store.read();
      if (!current.ok) return current;
      const entry = current.data;
      if (!entry || entry.state !== "active")
        return { ok: false, error: { code: "setup-reauthentication-required" } };
      if (usable(entry))
        return {
          ok: true,
          data: { authenticated: authenticatedFrom(entry), revision: entry.revision },
        };
      const captured = entry.refreshToken;
      if (!captured) return { ok: false, error: { code: "setup-reauthentication-required" } };
      if (!(await context.permitted()))
        return { ok: false, error: { code: "provider-permission-required" } };
      if (context.signal.aborted) return { ok: false, error: { code: "cancelled" } };
      const claim: ProviderSessionEntry = {
        schemaVersion: 1,
        revision: random(),
        profile: entry.profile,
        binding: entry.binding,
        encryptedAccount: entry.encryptedAccount,
        state: "refreshing",
        claimId: random(),
        claimedAt: now(),
      };
      const claimed = await store.compareAndSwap(entry.revision, claim, {
        cacheRevision: context.cacheRevision,
      });
      // Only the writer whose claim committed may send the refresh request.
      if (!claimed.ok) return claimed;
      const refreshed = await context.transport.refreshToken({
        connectionId: profile.connectionId,
        refreshToken: captured,
      });
      const receivedAt = now();
      if (!refreshed.ok) return refreshed;
      if (refreshed.data.kind !== "authenticated") {
        await store.compareAndSwap(claim.revision, null);
        return { ok: false, error: { code: "setup-reauthentication-required" } };
      }
      const tokens = refreshed.data.tokens;
      // Bitwarden access tokens carry an email claim; a missing claim is a mismatch.
      const subject = tokenSubject(tokens.accessToken);
      if (subject.sub !== entry.binding.userId || subject.email !== entry.binding.email) {
        await store.compareAndSwap(claim.revision, null);
        return { ok: false, error: { code: "account-mismatch" } };
      }
      const active: ProviderSessionEntry = {
        schemaVersion: 1,
        revision: random(),
        profile: entry.profile,
        binding: entry.binding,
        encryptedAccount: entry.encryptedAccount,
        state: "active",
        accessToken: tokens.accessToken,
        // An omitted or null refresh token keeps the captured one, as the official client does.
        refreshToken: tokens.refreshToken ?? captured,
        receivedAt,
        expiresIn: tokens.expiresIn,
      };
      // Commit rotation before any sync so a later sync failure cannot restore the old token.
      // The commit compares only the claim: a forget in between removes it and wins.
      const committed = await store.compareAndSwap(claim.revision, active);
      if (!committed.ok) return committed;
      return context.signal.aborted
        ? { ok: false, error: { code: "cancelled" } }
        : {
            ok: true,
            data: { authenticated: authenticatedFrom(active), revision: active.revision },
          };
    },
    forget,
    /** Delete exactly the session that was used; a newer one (conflict) is left in place. */
    async discard(profile: BitwardenProfile, revision: string): Promise<VaultResult<true>> {
      const removed = await deps.storeFor(profile).compareAndSwap(revision, null);
      return removed.ok || removed.error.code === "storage-conflict"
        ? { ok: true, data: true }
        : removed;
    },
  };
}
export type ProviderSessions = ReturnType<typeof createProviderSessions>;
