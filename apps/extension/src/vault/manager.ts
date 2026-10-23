import * as v from "valibot";
import {
  admitPreparedBitwardenAccount,
  normalizeBitwardenProfile,
  type BitwardenProfile,
  type LocalFieldReference,
  type PreparedBitwardenAccount,
} from "@pateat/bitwarden";
import type { CryptoHost, OpenedHostSession } from "../crypto/host";
import type { PasskeySignRequest } from "../crypto/passkey";
import type { HostUnlock } from "../crypto/wire";
import {
  admitVaultEntry,
  sameVaultEntry,
  vaultFailure,
  type AcceptedVaultContext,
  type VaultEntry,
  type VaultResult,
} from "./record";
import type { DurableVaultStore } from "./storage";
import { memorySessionKeyStore, type SessionKey, type SessionKeyStore } from "./session-key";
import { newId } from "@pateat/contracts/ids";

export type VaultCryptoHost = Pick<
  CryptoHost,
  | "open"
  | "verifyReceivedCiphers"
  | "exportUnlockMaterial"
  | "lock"
  | "isOpen"
  | "listFields"
  | "resolveField"
  | "catalog"
  | "matchUris"
  | "customFieldDigests"
  | "findPasskeys"
  | "signPasskey"
  | "verifyMasterPassword"
>;
export type LocalVaultHandle = {
  managerGeneration: string;
  handleId: string;
  connectionId: string;
  userId: string;
  recordId: string;
  snapshotId: string;
};
export type LocalVaultSummary = {
  connectionId: string;
  revision: string;
  autoUnlock: "enabled" | "disabled";
  recordId?: string;
  snapshotId?: string;
  userId?: string;
  accountVersion?: "v1" | "v2";
  securityVersion?: 1 | 2;
  coverage?: "received-envelope";
};
export type VaultCheckpoint = "before-write" | "after-write";
/**
 * Where an unlocked vault's key is kept (ADR 0075): `durable` in the vault record, so the
 * vault unlocks by itself after a browser restart (ADR 0006), or `session` in this browser
 * session's memory only, while a vault timeout other than "Never" is set.
 */
export type KeyRetention = "durable" | "session";
const itemIdSchema = v.pipe(v.string(), v.uuid());
/** Crypto host failures after which the session may no longer exist. */
function sessionMayHaveEnded(code: string): boolean {
  return code === "timeout" || code === "crypto-locked" || code === "crypto-failed";
}
export function createLocalVaultManager(options: {
  profile: BitwardenProfile;
  host: VaultCryptoHost;
  store: DurableVaultStore;
  randomId?: () => string;
  nowMs?: () => number;
  /** Synthetic probe only; no secrets or generic commands are exposed by checkpoints. */
  checkpoint?: (stage: VaultCheckpoint) => Promise<void>;
  /** Read at each write of a key; absent keeps the key on disk. */
  retention?: () => Promise<KeyRetention>;
  /** The key of a vault unlocked in this browser session; absent keeps it in this object. */
  sessionKey?: SessionKeyStore;
}) {
  const normalized = normalizeBitwardenProfile(options.profile);
  const profile = normalized.ok ? normalized.data : undefined;
  const random = options.randomId ?? newId;
  const now = options.nowMs ?? Date.now;
  const sessionKey = options.sessionKey ?? memorySessionKeyStore();
  const retentionOf = async (): Promise<KeyRetention> =>
    (await options.retention?.()) === "session" ? "session" : "durable";
  const generation = random();
  let epoch = 0;
  let disposed = false;
  let busy = false;
  let disabling = false;
  let pending: AbortController | undefined;
  let live:
    | { handle: LocalVaultHandle; opened: OpenedHostSession; summary: LocalVaultSummary }
    | undefined;
  let staged: OpenedHostSession | undefined;
  // Join native cleanup even after its session has been removed from live/staged.
  // An overlapping disable must not acknowledge while an earlier lock is pending.
  const retirements = new Set<Promise<void>>();
  let uncertain = false;
  // Set when a comparison may have ended the candidate, so a failure that repeats cannot
  // block every sync: accepts skip the comparison and rely on review until one commits.
  let skipComparison = false;
  // The revision an accept is writing. Until that accept adopts it, a durable check that
  // finds it ends only the old handle's request; a fence there would cancel the accept.
  let writing: string | undefined;
  const summary = (entry: VaultEntry): LocalVaultSummary => ({
    connectionId: entry.profile.connectionId,
    revision: entry.revision,
    autoUnlock: entry.state === "active" ? "enabled" : "disabled",
    ...(entry.accepted
      ? {
          recordId: entry.accepted.recordId,
          snapshotId: entry.accepted.snapshotId,
          userId: entry.accepted.userId,
          accountVersion: entry.accepted.accountVersion,
          securityVersion: entry.accepted.minimumSecurityVersion,
          coverage: entry.accepted.coverage,
        }
      : {}),
  });
  /** The key that unlocks this record now: the stored one, or this session's for a locked
   * record of the same revision. */
  async function keyFor(entry: VaultEntry | null): Promise<string | undefined> {
    if (entry?.state === "active") return entry.userKey;
    if (entry?.state !== "locked") return undefined;
    const key = await sessionKey.read().catch(() => undefined);
    return key?.revision === entry.revision ? key.userKey : undefined;
  }
  function current(captured: number, signal?: AbortSignal) {
    return !disposed && epoch === captured && !signal?.aborted;
  }
  function retire(opened: OpenedHostSession): Promise<void> {
    let retirement: Promise<void>;
    try {
      retirement = options.host.lock(opened.session).then(
        () => undefined,
        () => undefined,
      );
    } catch {
      retirement = Promise.resolve();
    }
    retirements.add(retirement);
    void retirement.then(() => retirements.delete(retirement));
    return retirement;
  }
  async function lockLive() {
    const old = live;
    live = undefined;
    if (old) await retire(old.opened);
  }
  async function fence() {
    epoch += 1;
    pending?.abort();
    const candidate = staged;
    staged = undefined;
    void lockLive();
    if (candidate) void retire(candidate);
    await Promise.allSettled([...retirements]);
  }
  // A timeout, cancellation, Worker failure or lost offscreen document ends the live
  // session in the crypto host without a lock. Forget it so the next read restores one;
  // the host has already retired it, so there is nothing to lock.
  function forgetEndedLive() {
    if (live && !options.host.isOpen(live.opened.session)) live = undefined;
  }
  function handleFor(entry: VaultEntry): LocalVaultHandle {
    if (!entry.accepted) throw new Error();
    return {
      managerGeneration: generation,
      handleId: random(),
      connectionId: entry.profile.connectionId,
      userId: entry.accepted.userId,
      recordId: entry.accepted.recordId,
      snapshotId: entry.accepted.snapshotId,
    };
  }
  function validHandle(handle: LocalVaultHandle) {
    forgetEndedLive();
    return (
      !disposed &&
      !uncertain &&
      live &&
      Object.entries(live.handle).every(
        ([key, value]) => handle?.[key as keyof LocalVaultHandle] === value,
      )
    );
  }
  async function checkDurable(owner: NonNullable<typeof live>): Promise<VaultResult<true>> {
    try {
      const read = await options.store.read();
      if (live !== owner) return vaultFailure("stale-vault-handle");
      if (!read.ok) {
        uncertain = true;
        await fence();
        return vaultFailure("storage-uncertain");
      }
      if (writing !== undefined && read.data?.revision === writing)
        return vaultFailure("stale-vault-handle");
      if (
        (read.data?.state !== "active" && read.data?.state !== "locked") ||
        read.data.revision !== owner.summary.revision ||
        read.data.accepted.recordId !== owner.handle.recordId ||
        read.data.accepted.snapshotId !== owner.handle.snapshotId ||
        read.data.accepted.userId !== owner.handle.userId ||
        read.data.accepted.accountVersion !== owner.summary.accountVersion ||
        read.data.accepted.minimumSecurityVersion !== owner.summary.securityVersion
      ) {
        await fence();
        return vaultFailure("stale-vault-handle");
      }
      return { ok: true, data: true };
    } catch {
      uncertain = true;
      await fence();
      return vaultFailure("storage-uncertain");
    }
  }
  function continuity(
    prepared: PreparedBitwardenAccount,
    old: VaultEntry | null,
  ): VaultResult<PreparedBitwardenAccount> {
    const known = old?.accepted;
    if (!known) return { ok: true, data: prepared };
    if (
      known.userId !== prepared.binding.userId ||
      known.prepared.binding.email !== prepared.binding.email
    )
      return vaultFailure("account-mismatch");
    if (known.accountVersion === "v2" && prepared.binding.accountVersion !== "v2")
      return vaultFailure("security-downgrade");
    return {
      ok: true,
      data: {
        ...prepared,
        minimumSecurityVersion: Math.max(
          known.minimumSecurityVersion,
          prepared.minimumSecurityVersion,
        ) as 1 | 2,
      },
    };
  }
  async function verifiedOpen(
    prepared: PreparedBitwardenAccount,
    snapshotId: string,
    unlock: HostUnlock,
    captured: number,
    signal: AbortSignal,
  ): Promise<VaultResult<OpenedHostSession>> {
    const opened = await options.host.open(
      { connectionId: prepared.binding.profile.connectionId, prepared, snapshotId, unlock },
      signal,
    );
    if (!opened.ok) return opened;
    if (!current(captured, signal)) {
      await retire(opened.data);
      return vaultFailure("cancelled");
    }
    staged = opened.data;
    const checked = await options.host.verifyReceivedCiphers(opened.data.session, signal);
    if (
      !checked.ok ||
      checked.data.verifiedCipherCount !== prepared.ciphers.length ||
      !current(captured, signal)
    ) {
      if (staged === opened.data) staged = undefined;
      await retire(opened.data);
      return !checked.ok
        ? checked
        : vaultFailure(current(captured, signal) ? "crypto-failed" : "cancelled");
    }
    if (
      opened.data.metadata.userId !== prepared.binding.userId ||
      opened.data.metadata.accountVersion !== prepared.binding.accountVersion ||
      opened.data.metadata.securityVersion < prepared.minimumSecurityVersion
    ) {
      if (staged === opened.data) staged = undefined;
      await retire(opened.data);
      return vaultFailure("security-downgrade");
    }
    return opened;
  }
  /**
   * Items whose decrypted custom fields are equal in the old live and the candidate
   * session. Only equality leaves the crypto host; any failure yields no item.
   * `candidateEnded` reports a failure that may have ended the candidate session.
   */
  async function sameCustomFields(
    old: OpenedHostSession,
    next: OpenedHostSession,
    itemIds: string[],
    signal: AbortSignal,
  ): Promise<{ items: string[]; candidateEnded: boolean }> {
    // A request that throws leaves the session's state unknown, so it counts as ended.
    const failed = () => ({ ok: false as const, error: { code: "crypto-failed" as const } });
    const [before, after] = await Promise.all([
      // Cancelling the sync must not cancel, and so terminate, the live session.
      options.host.customFieldDigests(old.session, itemIds).catch(failed),
      options.host.customFieldDigests(next.session, itemIds, signal).catch(failed),
    ]);
    // A timed-out or failed request may have ended the session in the crypto host (a
    // refusal before dispatch does not always, so this can lock more than needed). Forget
    // the live session too, so a later failed write does not leave logins on a dead handle.
    if (!before.ok && sessionMayHaveEnded(before.error.code) && live?.opened === old)
      await lockLive();
    const candidateEnded = !after.ok && sessionMayHaveEnded(after.error.code);
    if (!before.ok || !after.ok) return { items: [], candidateEnded };
    return {
      items: itemIds.filter((id) => {
        const digest = before.data.digests[id];
        return typeof digest === "string" && digest === after.data.digests[id];
      }),
      candidateEnded: false,
    };
  }
  function operation(signal?: AbortSignal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    pending = controller;
    return {
      signal: controller.signal,
      cleanup() {
        signal?.removeEventListener("abort", abort);
        if (pending === controller) pending = undefined;
      },
    };
  }
  return {
    generation,
    async accept(
      input: {
        prepared: PreparedBitwardenAccount;
        unlock: HostUnlock;
        autoUnlock: "enable" | "preserve";
        /** Protected item IDs whose decrypted custom fields are compared with the live
         * snapshot's, when it is the one being replaced. */
        compareCustomFields?: string[];
      },
      signal?: AbortSignal,
    ): Promise<
      VaultResult<{
        handle: LocalVaultHandle;
        summary: LocalVaultSummary;
        /** Compared items whose custom fields are unchanged; empty when none were compared. */
        sameCustomFields: string[];
        /** The replaced snapshot those items were compared with. */
        comparedSnapshotId?: string;
      }>
    > {
      if (!profile) return vaultFailure("invalid-profile");
      if (disposed || disabling) return vaultFailure("crypto-locked");
      if (busy) return vaultFailure("resource-limit");
      let capturedInput: typeof input;
      try {
        capturedInput = structuredClone(input);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (capturedInput.autoUnlock !== "enable" && capturedInput.autoUnlock !== "preserve")
        return vaultFailure("invalid-request");
      const admitted = admitPreparedBitwardenAccount(capturedInput.prepared, profile);
      if (!admitted.ok) return admitted;
      const unlock = capturedInput.unlock;
      busy = true;
      const captured = epoch;
      const op = operation(signal);
      let candidate: OpenedHostSession | undefined;
      let writeAttempted = false;
      try {
        const previous = await options.store.read();
        if (!previous.ok) {
          await fence();
          return previous;
        }
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        if (capturedInput.autoUnlock === "preserve" && !(await keyFor(previous.data)))
          return vaultFailure(
            previous.data?.state === "locked" ? "vault-locked" : "auto-unlock-disabled",
          );
        const prepared = continuity(admitted.data, previous.data);
        if (!prepared.ok) return prepared;
        const snapshotId = random();
        const opened = await verifiedOpen(prepared.data, snapshotId, unlock, captured, op.signal);
        if (!opened.ok) return opened;
        candidate = opened.data;
        const material = await options.host.exportUnlockMaterial(candidate.session, op.signal);
        if (!material.ok) return material;
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        if (JSON.stringify(material.data.metadata) !== JSON.stringify(candidate.metadata))
          return vaultFailure("crypto-failed");
        const accepted: AcceptedVaultContext = {
          recordId: random(),
          snapshotId,
          userId: candidate.metadata.userId,
          accountVersion: candidate.metadata.accountVersion,
          minimumSecurityVersion: candidate.metadata.securityVersion,
          acceptedAt: now(),
          coverage: "received-envelope",
          prepared: {
            ...prepared.data,
            minimumSecurityVersion: candidate.metadata.securityVersion,
          },
        };
        const retention = await retentionOf();
        const entry: VaultEntry =
          retention === "durable"
            ? {
                schemaVersion: 1,
                revision: random(),
                profile,
                state: "active",
                accepted,
                userKey: material.data.userKey,
              }
            : { schemaVersion: 1, revision: random(), profile, state: "locked", accepted };
        const ready = admitVaultEntry(entry, profile);
        if (!ready.ok) return ready;
        // Only item UUIDs can be compared; one other ID must not stop the rest.
        const compared = Array.isArray(capturedInput.compareCustomFields)
          ? [...new Set(capturedInput.compareCustomFields.filter((id) => v.is(itemIdSchema, id)))]
          : [];
        forgetEndedLive();
        const old = live;
        const comparison =
          compared.length &&
          !skipComparison &&
          old &&
          !uncertain &&
          previous.data?.accepted &&
          old.handle.recordId === previous.data.accepted.recordId &&
          old.handle.snapshotId === previous.data.accepted.snapshotId
            ? await sameCustomFields(old.opened, candidate, compared, op.signal)
            : { items: [], candidateEnded: false };
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        // A candidate the crypto host may have ended cannot serve logins; fail before the
        // write so the stored snapshot stays and later syncs retry without comparing.
        if (comparison.candidateEnded) {
          skipComparison = true;
          return vaultFailure("crypto-failed");
        }
        const sameFields = comparison.items;
        // This session's key for the record still stored, put back if the write fails.
        const priorKey =
          retention === "session" ? await sessionKey.read().catch(() => undefined) : undefined;
        await options.checkpoint?.("before-write");
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        // The key goes to memory before the record that needs it, so a write that lands is
        // never locked by a missing key; a key for a revision that never lands unlocks nothing.
        if (retention === "session")
          await sessionKey.write({ revision: ready.data.revision, userKey: material.data.userKey });
        writeAttempted = true;
        writing = ready.data.revision;
        const write = await options.store.compareAndSwap(
          previous.data?.revision ?? null,
          ready.data,
          op.signal,
        );
        if (!write.ok) {
          if (write.error.code === "storage-uncertain") {
            uncertain = true;
            await fence();
          } else {
            const read = await options.store.read();
            if (!read.ok || !sameVaultEntry(read.data, previous.data)) {
              uncertain = true;
              await fence();
            } else if (
              priorKey &&
              priorKey.revision === previous.data?.revision &&
              !disposed &&
              epoch === captured
            )
              // The old record stays, so the vault this session unlocked stays unlocked.
              await sessionKey.write(priorKey).catch(() => undefined);
          }
          return write;
        }
        await options.checkpoint?.("after-write");
        if (!current(captured, op.signal)) {
          uncertain = true;
          await fence();
          return vaultFailure("storage-uncertain");
        }
        const readback = await options.store.read();
        if (
          !readback.ok ||
          !sameVaultEntry(readback.data, ready.data) ||
          !current(captured, op.signal)
        ) {
          uncertain = true;
          await fence();
          return vaultFailure("storage-uncertain");
        }
        await lockLive();
        if (!current(captured, op.signal)) {
          uncertain = true;
          return vaultFailure("storage-uncertain");
        }
        // A key kept on disk again leaves none in memory.
        if (retention === "durable") await sessionKey.clear().catch(() => undefined);
        uncertain = false;
        skipComparison = false;
        const handle = handleFor(ready.data);
        // Retain metadata only; the host owns encrypted items and native keys.
        live = { handle, opened: candidate, summary: summary(ready.data) };
        if (staged === candidate) staged = undefined;
        candidate = undefined;
        return {
          ok: true,
          data: {
            handle: structuredClone(handle),
            summary: summary(ready.data),
            sameCustomFields: sameFields,
            ...(sameFields.length > 0 && previous.data?.accepted
              ? { comparedSnapshotId: previous.data.accepted.snapshotId }
              : {}),
          },
        };
      } catch {
        if (writeAttempted) {
          uncertain = true;
          await fence();
        }
        return vaultFailure(writeAttempted ? "storage-uncertain" : "storage-failed");
      } finally {
        writing = undefined;
        const remaining = candidate ?? staged;
        staged = undefined;
        if (remaining) await retire(remaining);
        op.cleanup();
        busy = false;
      }
    },
    async restore(
      signal?: AbortSignal,
    ): Promise<VaultResult<{ handle: LocalVaultHandle; summary: LocalVaultSummary }>> {
      if (!profile) return vaultFailure("invalid-profile");
      if (disposed || disabling) return vaultFailure("crypto-locked");
      if (busy) return vaultFailure("resource-limit");
      busy = true;
      // Capture our own retirement epoch before waiting for native cleanup. A
      // concurrent disable must not become the epoch of a newly resumed restore.
      const retirement = fence();
      const captured = epoch;
      const op = operation(signal);
      let candidate: OpenedHostSession | undefined;
      try {
        await retirement;
        if (!current(captured, op.signal) || disabling) return vaultFailure("cancelled");
        const stored = await options.store.read();
        if (!stored.ok) return stored;
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        if (!stored.data) return vaultFailure("cache-missing");
        if (stored.data.state === "disabled") return vaultFailure("auto-unlock-disabled");
        const entry = stored.data;
        const userKey = await keyFor(entry);
        if (!userKey) return vaultFailure("vault-locked");
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        const opened = await verifiedOpen(
          entry.accepted.prepared,
          entry.accepted.snapshotId,
          { kind: "decrypted-key", userKey },
          captured,
          op.signal,
        );
        if (!opened.ok) return opened;
        candidate = opened.data;
        const check = await options.store.read();
        if (!check.ok || !sameVaultEntry(check.data, entry) || !current(captured, op.signal)) {
          uncertain = true;
          await fence();
          return vaultFailure("storage-uncertain");
        }
        await lockLive();
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        const handle = handleFor(entry);
        live = { handle, opened: candidate, summary: summary(entry) };
        if (staged === candidate) staged = undefined;
        candidate = undefined;
        uncertain = false;
        return { ok: true, data: { handle: structuredClone(handle), summary: summary(entry) } };
      } catch {
        return vaultFailure("storage-failed");
      } finally {
        const remaining = candidate ?? staged;
        staged = undefined;
        if (remaining) await retire(remaining);
        op.cleanup();
        busy = false;
      }
    },
    /** Expected revision is used only to compensate a cancelled first enrollment,
     * never to disable an unrelated newer accepted record. */
    async disableAutoUnlock(expectedRevision?: string): Promise<VaultResult<LocalVaultSummary>> {
      if (!profile) return vaultFailure("invalid-profile");
      if (disposed) return vaultFailure("crypto-locked");
      if (disabling) return vaultFailure("resource-limit");
      disabling = true;
      try {
        await fence();
        await sessionKey.clear();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          // Bounded CAS retry only for destructive disable, never stale candidate acceptance.
          // eslint-disable-next-line no-await-in-loop
          const stored = await options.store.read();
          if (!stored.ok) return stored;
          if (expectedRevision !== undefined && stored.data?.revision !== expectedRevision)
            return vaultFailure("storage-conflict");
          const next: VaultEntry = {
            schemaVersion: 1,
            revision: random(),
            profile,
            state: "disabled",
            ...(stored.data?.accepted ? { accepted: stored.data.accepted } : {}),
          };
          // eslint-disable-next-line no-await-in-loop
          const write = await options.store.compareAndSwap(stored.data?.revision ?? null, next);
          if (!write.ok) {
            if (write.error.code === "storage-conflict" && expectedRevision === undefined) continue;
            uncertain = write.error.code === "storage-uncertain";
            return write;
          }
          // eslint-disable-next-line no-await-in-loop
          const readback = await options.store.read();
          if (!readback.ok || !sameVaultEntry(readback.data, next)) {
            uncertain = true;
            return vaultFailure("storage-uncertain");
          }
          uncertain = false;
          return { ok: true, data: summary(next) };
        }
        return vaultFailure("storage-conflict");
      } catch {
        uncertain = true;
        return vaultFailure("storage-uncertain");
      } finally {
        disabling = false;
      }
    },
    /**
     * Unlocks a locked vault offline with its master password (ADR 0075): the stored
     * encrypted context is opened with a key derived from its own KDF settings, and the
     * user key goes where `retention` says. No server is asked and the password is kept
     * nowhere. A wrong password fails as the crypto host's open does.
     */
    async unlock(
      password: string,
      signal?: AbortSignal,
    ): Promise<VaultResult<{ handle: LocalVaultHandle; summary: LocalVaultSummary }>> {
      if (!profile) return vaultFailure("invalid-profile");
      if (disposed || disabling) return vaultFailure("crypto-locked");
      if (busy) return vaultFailure("resource-limit");
      if (typeof password !== "string" || !password) return vaultFailure("invalid-request");
      busy = true;
      const retirement = fence();
      const captured = epoch;
      const op = operation(signal);
      let candidate: OpenedHostSession | undefined;
      let written: SessionKey | undefined;
      try {
        await retirement;
        if (!current(captured, op.signal) || disabling) return vaultFailure("cancelled");
        const stored = await options.store.read();
        if (!stored.ok) return stored;
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        if (!stored.data) return vaultFailure("cache-missing");
        if (stored.data.state === "disabled") return vaultFailure("auto-unlock-disabled");
        const entry = stored.data;
        // Read before the key exists, so nothing awaits between the last check and its write.
        const retention = await retentionOf();
        const opened = await verifiedOpen(
          entry.accepted.prepared,
          entry.accepted.snapshotId,
          { kind: "password", password },
          captured,
          op.signal,
        );
        if (!opened.ok) return opened;
        candidate = opened.data;
        const material = await options.host.exportUnlockMaterial(candidate.session, op.signal);
        if (!material.ok) return material;
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        if (JSON.stringify(material.data.metadata) !== JSON.stringify(candidate.metadata))
          return vaultFailure("crypto-failed");
        const next: VaultEntry =
          retention === "durable"
            ? entry.state === "active"
              ? entry
              : {
                  schemaVersion: 1,
                  revision: random(),
                  profile,
                  state: "active",
                  accepted: entry.accepted,
                  userKey: material.data.userKey,
                }
            : entry.state === "locked"
              ? entry
              : {
                  schemaVersion: 1,
                  revision: random(),
                  profile,
                  state: "locked",
                  accepted: entry.accepted,
                };
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        if (retention === "session") {
          written = { revision: next.revision, userKey: material.data.userKey };
          await sessionKey.write(written);
        }
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        if (next !== entry) {
          writing = next.revision;
          const write = await options.store.compareAndSwap(entry.revision, next, op.signal);
          if (!write.ok) {
            if (write.error.code === "storage-uncertain") {
              uncertain = true;
              await fence();
            }
            return write;
          }
        }
        const readback = await options.store.read();
        if (!readback.ok || !sameVaultEntry(readback.data, next) || !current(captured, op.signal)) {
          uncertain = true;
          await fence();
          return vaultFailure("storage-uncertain");
        }
        if (retention === "durable") await sessionKey.clear().catch(() => undefined);
        await lockLive();
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        const handle = handleFor(next);
        live = { handle, opened: candidate, summary: summary(next) };
        if (staged === candidate) staged = undefined;
        candidate = undefined;
        uncertain = false;
        written = undefined;
        return { ok: true, data: { handle: structuredClone(handle), summary: summary(next) } };
      } catch {
        return vaultFailure("storage-failed");
      } finally {
        writing = undefined;
        // A lock, log out or removal ran meanwhile: the key this unlock wrote must not
        // outlive it.
        if (written && epoch !== captured) {
          const left = await sessionKey.read().catch(() => undefined);
          if (left?.revision === written.revision && left.userKey === written.userKey)
            await sessionKey.clear().catch(() => undefined);
        }
        const remaining = candidate ?? staged;
        staged = undefined;
        if (remaining) await retire(remaining);
        op.cleanup();
        busy = false;
      }
    },
    /**
     * Locks the vault and keeps its sign-in (ADR 0075): the open session ends, this
     * session's key is dropped and a key on disk is removed from the record, which keeps
     * the encrypted context for an offline unlock. Answers the record's summary after the
     * lock, or null when there is no record.
     */
    async lockVault(): Promise<VaultResult<LocalVaultSummary | null>> {
      if (!profile) return vaultFailure("invalid-profile");
      if (disposed) return vaultFailure("crypto-locked");
      if (disabling) return vaultFailure("resource-limit");
      disabling = true;
      try {
        await fence();
        // Memory first: once this resolves, no unlock of this browser session is left.
        await sessionKey.clear();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop
          const stored = await options.store.read();
          // A record that fails admission never unlocks again, so with the session key
          // gone nothing of it is open.
          if (!stored.ok && stored.error.code === "invalid-cache-record")
            return { ok: true, data: null };
          if (!stored.ok) return stored;
          if (stored.data?.state !== "active")
            return { ok: true, data: stored.data ? summary(stored.data) : null };
          const next: VaultEntry = {
            schemaVersion: 1,
            revision: random(),
            profile,
            state: "locked",
            accepted: stored.data.accepted,
          };
          // eslint-disable-next-line no-await-in-loop
          const write = await options.store.compareAndSwap(stored.data.revision, next);
          if (!write.ok) {
            if (write.error.code === "storage-conflict") continue;
            uncertain = write.error.code === "storage-uncertain";
            return write;
          }
          // eslint-disable-next-line no-await-in-loop
          const readback = await options.store.read();
          if (!readback.ok || !sameVaultEntry(readback.data, next)) {
            uncertain = true;
            return vaultFailure("storage-uncertain");
          }
          uncertain = false;
          return { ok: true, data: summary(next) };
        }
        return vaultFailure("storage-conflict");
      } catch {
        uncertain = true;
        return vaultFailure("storage-uncertain");
      } finally {
        disabling = false;
      }
    },
    /**
     * Moves an unlocked vault's key to where `retention` now says, after the vault timeout
     * changed: from the record to this session's memory, or back. The open session keeps
     * serving the same snapshot. A locked vault stays locked.
     */
    async keepKey(retention: KeyRetention): Promise<VaultResult<true>> {
      if (!profile) return vaultFailure("invalid-profile");
      if (disposed || disabling) return vaultFailure("crypto-locked");
      if (busy) return vaultFailure("resource-limit");
      busy = true;
      const captured = epoch;
      let written: SessionKey | undefined;
      try {
        const stored = await options.store.read();
        // A record that fails admission holds no key anyone can use.
        if (!stored.ok && stored.error.code === "invalid-cache-record")
          return { ok: true, data: true };
        if (!stored.ok) return stored;
        const entry = stored.data;
        let next: VaultEntry;
        if (retention === "session" && entry?.state === "active") {
          next = {
            schemaVersion: 1,
            revision: random(),
            profile,
            state: "locked",
            accepted: entry.accepted,
          };
          // A lock that started meanwhile already cleared memory; nothing may refill it.
          if (epoch !== captured) return vaultFailure("cancelled");
          written = { revision: next.revision, userKey: entry.userKey };
          await sessionKey.write(written);
        } else if (retention === "durable" && entry?.state === "locked") {
          const userKey = await keyFor(entry);
          if (!userKey) return { ok: true, data: true };
          next = {
            schemaVersion: 1,
            revision: random(),
            profile,
            state: "active",
            accepted: entry.accepted,
            userKey,
          };
        } else return { ok: true, data: true };
        if (epoch !== captured) return vaultFailure("cancelled");
        writing = next.revision;
        const write = await options.store.compareAndSwap(entry.revision, next);
        if (!write.ok) {
          if (write.error.code === "storage-uncertain") {
            uncertain = true;
            await fence();
          }
          return write;
        }
        const readback = await options.store.read();
        if (!readback.ok || !sameVaultEntry(readback.data, next)) {
          uncertain = true;
          await fence();
          return vaultFailure("storage-uncertain");
        }
        // Same snapshot and record ID: only the revision the open session checks moves.
        if (live && live.summary.revision === entry.revision)
          live = { ...live, summary: summary(next) };
        if (retention === "durable") await sessionKey.clear().catch(() => undefined);
        return { ok: true, data: true };
      } catch {
        uncertain = true;
        await fence();
        return vaultFailure("storage-uncertain");
      } finally {
        writing = undefined;
        // A lock, log out or removal ran meanwhile: the key this move wrote must not
        // outlive it.
        if (written && epoch !== captured) {
          const left = await sessionKey.read().catch(() => undefined);
          if (left?.revision === written.revision && left.userKey === written.userKey)
            await sessionKey.clear().catch(() => undefined);
        }
        busy = false;
      }
    },
    /** The key that unlocks this record now, for a sync that opens the next snapshot. */
    keyFor,
    async lock() {
      await fence();
    },
    /** Locks any open native session, then deletes this connection's durable record and
     * the unlock key retained in it. The manager stays usable for a later accept. */
    async remove(): Promise<VaultResult<true>> {
      if (!profile) return vaultFailure("invalid-profile");
      if (disposed) return vaultFailure("crypto-locked");
      if (disabling) return vaultFailure("resource-limit");
      disabling = true;
      try {
        await fence();
        await sessionKey.clear();
        const removed = await options.store.remove();
        uncertain = !removed.ok && removed.error.code === "storage-uncertain";
        return removed;
      } catch {
        uncertain = true;
        return vaultFailure("storage-uncertain");
      } finally {
        disabling = false;
      }
    },
    async listFields(handle: LocalVaultHandle, itemId: string, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (!validHandle(handle) || !live) return vaultFailure("stale-vault-handle");
      const currentLive = live;
      const before = await checkDurable(currentLive);
      if (!before.ok || !validHandle(handle))
        return before.ok ? vaultFailure("stale-vault-handle") : before;
      const result = await options.host.listFields(currentLive.opened.session, itemId, signal);
      const after = await checkDurable(currentLive);
      if (!after.ok) return after;
      return validHandle(handle) && live === currentLive
        ? result
        : vaultFailure("stale-vault-handle");
    },
    async catalog(handle: LocalVaultHandle, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (!validHandle(handle) || !live) return vaultFailure("stale-vault-handle");
      const owner = live;
      const before = await checkDurable(owner);
      if (!before.ok || !validHandle(handle))
        return before.ok ? vaultFailure("stale-vault-handle") : before;
      const result = await options.host.catalog(owner.opened.session, signal);
      const after = await checkDurable(owner);
      if (!after.ok) return after;
      return validHandle(handle) && live === owner ? result : vaultFailure("stale-vault-handle");
    },
    /** Candidate signal for the live accepted snapshot only; it grants no field release. */
    async matchUris(handle: LocalVaultHandle, targetUrl: string, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (typeof targetUrl !== "string") return vaultFailure("invalid-uri-input");
      if (!validHandle(handle) || !live) return vaultFailure("stale-vault-handle");
      const owner = live;
      const before = await checkDurable(owner);
      if (!before.ok || !validHandle(handle))
        return before.ok ? vaultFailure("stale-vault-handle") : before;
      const result = await options.host.matchUris(owner.opened.session, targetUrl, signal);
      const after = await checkDurable(owner);
      if (!after.ok) return after;
      return validHandle(handle) && live === owner ? result : vaultFailure("stale-vault-handle");
    },
    /** Secret-free metadata for the live accepted snapshot's passkeys with this RP ID. */
    async findPasskeys(handle: LocalVaultHandle, rpId: string, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (typeof rpId !== "string") return vaultFailure("invalid-request");
      if (!validHandle(handle) || !live) return vaultFailure("stale-vault-handle");
      const owner = live;
      const before = await checkDurable(owner);
      if (!before.ok || !validHandle(handle))
        return before.ok ? vaultFailure("stale-vault-handle") : before;
      const result = await options.host.findPasskeys(owner.opened.session, rpId, signal);
      const after = await checkDurable(owner);
      if (!after.ok) return after;
      return validHandle(handle) && live === owner ? result : vaultFailure("stale-vault-handle");
    },
    /** One assertion signature from the live snapshot's stored key for that item. */
    async signPasskey(
      handle: LocalVaultHandle,
      input: { itemId: string } & PasskeySignRequest,
      signal?: AbortSignal,
    ) {
      try {
        handle = structuredClone(handle);
        input = structuredClone(input);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (typeof input !== "object" || input === null) return vaultFailure("invalid-request");
      if (!validHandle(handle) || !live) return vaultFailure("stale-vault-handle");
      const owner = live;
      const before = await checkDurable(owner);
      if (!before.ok || !validHandle(handle))
        return before.ok ? vaultFailure("stale-vault-handle") : before;
      const result = await options.host.signPasskey(owner.opened.session, input, signal);
      const after = await checkDurable(owner);
      if (!after.ok) return after;
      return validHandle(handle) && live === owner ? result : vaultFailure("stale-vault-handle");
    },
    /**
     * Whether `password` is the master password of the live session's account, checked
     * offline against the accepted record's unlock data, as before a re-prompt item is used.
     */
    async verifyMasterPassword(handle: LocalVaultHandle, password: string, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (typeof password !== "string" || !password) return vaultFailure("invalid-request");
      if (!validHandle(handle) || !live) return vaultFailure("stale-vault-handle");
      const owner = live;
      const before = await checkDurable(owner);
      if (!before.ok || !validHandle(handle))
        return before.ok ? vaultFailure("stale-vault-handle") : before;
      const result = await options.host.verifyMasterPassword(
        owner.opened.session,
        password,
        signal,
      );
      const after = await checkDurable(owner);
      if (!after.ok) return after;
      return validHandle(handle) && live === owner ? result : vaultFailure("stale-vault-handle");
    },
    async resolveField(
      handle: LocalVaultHandle,
      ref: LocalFieldReference,
      grant: {
        snapshotId: string;
        allowedFieldIds: readonly string[];
        nowMs?: number;
        code?: true;
      },
      signal?: AbortSignal,
    ) {
      try {
        handle = structuredClone(handle);
        ref = structuredClone(ref);
        grant = structuredClone(grant);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (!validHandle(handle) || !live) return vaultFailure("stale-vault-handle");
      if (grant.snapshotId !== live.handle.snapshotId) return vaultFailure("stale-field-reference");
      const currentLive = live;
      const before = await checkDurable(currentLive);
      if (!before.ok || !validHandle(handle))
        return before.ok ? vaultFailure("stale-vault-handle") : before;
      const { snapshotId: _snapshotId, ...fields } = grant;
      const result = await options.host.resolveField(
        currentLive.opened.session,
        ref,
        fields,
        signal,
      );
      const after = await checkDurable(currentLive);
      if (!after.ok) return after;
      return validHandle(handle) && live === currentLive
        ? result
        : vaultFailure("stale-vault-handle");
    },
    status() {
      forgetEndedLive();
      return {
        generation,
        epoch,
        busy,
        ready: !!live && !uncertain,
        storageUncertain: uncertain,
        ...(live
          ? { handle: structuredClone(live.handle), summary: structuredClone(live.summary) }
          : {}),
      };
    },
    async dispose() {
      disposed = true;
      await fence();
      options.store.close();
    },
  };
}
export type LocalVaultManager = ReturnType<typeof createLocalVaultManager>;
