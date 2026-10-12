import type { BitwardenProfile, BitwardenTransport, PasswordTokenOutcome } from "@pateat/bitwarden";
import { vaultFailure, type VaultErrorCode, type VaultResult } from "../vault/record";
import {
  authenticatedFrom,
  narrowEncryptedAccount,
  tokenSubject,
  type ProviderSessionEntry,
} from "./session-record";
import type { ProviderSessionStore } from "./session-store";
import { newId } from "@pateat/contracts/ids";

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
/** No response, a rate limit or a server error: the provider did not reject the token. */
const retryable = (error: { code: string; status?: number }) =>
  error.code === "network" ||
  error.code === "timeout" ||
  (error.code === "http-error" &&
    error.status !== undefined &&
    (error.status === 429 || error.status >= 500));

/** How one refresh request ended, for the local log. No token or account value. */
export type RefreshReport = {
  connectionId: string;
  outcome: "refreshed" | "restored" | "rejected" | "account-mismatch" | "failed" | "not-sent";
  /**
   * The transport or store error code when the outcome is not `refreshed`; for `not-sent`,
   * why no refresh request went out (ADR 0019).
   */
  cause?: string;
  /** The HTTP status of an `http-error`. */
  status?: number;
};

export function createProviderSessions(deps: {
  storeFor(profile: BitwardenProfile): ProviderSessionStore;
  nowMs?: () => number;
  randomId?: () => string;
  report?: (event: RefreshReport) => void;
}) {
  const now = deps.nowMs ?? Date.now;
  const random = deps.randomId ?? newId;
  const report = (event: RefreshReport) => {
    try {
      deps.report?.(event);
    } catch {
      // Logging never changes a refresh.
    }
  };
  /** Usable only before both the response lifetime and the token's own `exp`, if present. */
  const usable = (entry: Extract<ProviderSessionEntry, { state: "active" }>) => {
    const lifetime = entry.receivedAt + entry.expiresIn * 1000;
    const exp = tokenSubject(entry.accessToken).exp;
    return (
      now() + EXPIRY_MARGIN_MS < (exp === undefined ? lifetime : Math.min(lifetime, exp * 1000))
    );
  };
  /** Claims this worker is refreshing now. A claim not listed was left by a stopped worker. */
  const held = new Set<string>();
  function stateOf(entry: ProviderSessionEntry | null): ProviderSessionState {
    if (!entry) return "none";
    if (entry.state === "refreshing")
      return entry.refreshToken ? "refresh-required" : "reauthentication-required";
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
    ): Promise<VaultResult<string>> {
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
      return written.ok ? { ok: true, data: next.revision } : written;
    },
    /**
     * Return a usable authorization for one explicit sync, refreshing it at most once.
     * The refresh claim is committed before HTTP and keeps the refresh token it sends. A
     * network failure, timeout, 429 or 5xx puts the session back with that token, which
     * the provider reuses. A claim left by a worker that stopped mid-request is resumed
     * with its token by the next acquire. Any other failure drops the token from the
     * claim, which then requires password sign-in.
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
      // No usable session was refreshed and no refresh is sent: why, for the log.
      const notSent = <T>(cause: string, result: T): T => {
        report({ connectionId: profile.connectionId, outcome: "not-sent", cause });
        return result;
      };
      const current = await store.read();
      if (!current.ok) return notSent(current.error.code, current);
      const entry = current.data;
      if (!entry)
        return notSent("no-session", {
          ok: false,
          error: { code: "setup-reauthentication-required" },
        });
      if (entry.state === "refreshing") {
        // Another acquire in this worker owns the claim; a claim nobody holds is resumed.
        if (held.has(entry.claimId))
          return notSent("claimed", { ok: false, error: { code: "cancelled" } });
      } else if (usable(entry))
        return {
          ok: true,
          data: { authenticated: authenticatedFrom(entry), revision: entry.revision },
        };
      const captured = entry.refreshToken;
      if (!captured)
        return notSent("no-refresh-token", {
          ok: false,
          error: { code: "setup-reauthentication-required" },
        });
      if (!(await context.permitted()))
        return notSent("provider-permission-required", {
          ok: false,
          error: { code: "provider-permission-required" },
        });
      if (context.signal.aborted)
        return notSent("cancelled", { ok: false, error: { code: "cancelled" } });
      const claim: ProviderSessionEntry = {
        schemaVersion: 1,
        revision: random(),
        profile: entry.profile,
        binding: entry.binding,
        encryptedAccount: entry.encryptedAccount,
        state: "refreshing",
        claimId: random(),
        claimedAt: now(),
        refreshToken: captured,
      };
      // Held before the write, so no other acquire in this worker can resume it meanwhile.
      held.add(claim.claimId);
      const claimed = await store.compareAndSwap(entry.revision, claim, {
        cacheRevision: context.cacheRevision,
      });
      // Only the writer whose claim committed may send the refresh request.
      if (!claimed.ok) {
        held.delete(claim.claimId);
        return notSent(claimed.error.code, claimed);
      }
      const refresh = async (): Promise<
        VaultResult<Acquired> | { ok: false; error: { code: SessionFailure } }
      > => {
        const refreshed = await context.transport.refreshToken({
          connectionId: profile.connectionId,
          refreshToken: captured,
        });
        const receivedAt = now();
        const connectionId = profile.connectionId;
        if (!refreshed.ok) {
          const failure = refreshed.error as { code: string; status?: number };
          // The provider never invalidates a presented refresh token, so after a failure that
          // carries no rejection the captured one is still valid: put it back so a later sync can retry without a
          // password. The restore compares only the claim, so a forget in between still wins.
          // A resumed claim has no session to go back to, so it becomes a new claim nobody
          // holds. A failure that is not retryable keeps the claim without its token, which
          // requires password sign-in.
          const restored = retryable(failure)
            ? (
                await store.compareAndSwap(
                  claim.revision,
                  entry.state === "active"
                    ? { ...entry, revision: random() }
                    : { ...claim, revision: random(), claimId: random() },
                )
              ).ok
            : false;
          // A restore that could not be written leaves the claim with its token to resume.
          if (!retryable(failure)) {
            const { refreshToken: _dropped, ...final } = claim;
            await store.compareAndSwap(claim.revision, { ...final, revision: random() });
          }
          report({
            connectionId,
            outcome: restored ? "restored" : "failed",
            cause: failure.code,
            ...(failure.status === undefined ? {} : { status: failure.status }),
          });
          return refreshed;
        }
        if (refreshed.data.kind !== "authenticated") {
          report({ connectionId, outcome: "rejected", cause: refreshed.data.reason });
          await store.compareAndSwap(claim.revision, null);
          return { ok: false, error: { code: "setup-reauthentication-required" } };
        }
        const tokens = refreshed.data.tokens;
        // Bitwarden access tokens carry an email claim; a missing claim is a mismatch.
        const subject = tokenSubject(tokens.accessToken);
        if (subject.sub !== entry.binding.userId || subject.email !== entry.binding.email) {
          report({ connectionId, outcome: "account-mismatch" });
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
        report(
          committed.ok
            ? { connectionId, outcome: "refreshed" }
            : { connectionId, outcome: "failed", cause: committed.error.code },
        );
        if (!committed.ok) return committed;
        return context.signal.aborted
          ? { ok: false, error: { code: "cancelled" } }
          : {
              ok: true,
              data: { authenticated: authenticatedFrom(active), revision: active.revision },
            };
      };
      try {
        return await refresh();
      } finally {
        held.delete(claim.claimId);
      }
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
