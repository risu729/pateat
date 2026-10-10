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

export type VaultCryptoHost = Pick<
  CryptoHost,
  | "open"
  | "verifyReceivedCiphers"
  | "exportUnlockMaterial"
  | "lock"
  | "listFields"
  | "resolveField"
  | "catalog"
  | "matchUris"
  | "passkeyCandidates"
  | "signPasskey"
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
export function createLocalVaultManager(options: {
  profile: BitwardenProfile;
  host: VaultCryptoHost;
  store: DurableVaultStore;
  randomId?: () => string;
  nowMs?: () => number;
  /** Synthetic probe only; no secrets or generic commands are exposed by checkpoints. */
  checkpoint?: (stage: VaultCheckpoint) => Promise<void>;
}) {
  const normalized = normalizeBitwardenProfile(options.profile);
  const profile = normalized.ok ? normalized.data : undefined;
  const random = options.randomId ?? (() => crypto.randomUUID());
  const now = options.nowMs ?? Date.now;
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
      if (
        read.data?.state !== "active" ||
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
      },
      signal?: AbortSignal,
    ): Promise<VaultResult<{ handle: LocalVaultHandle; summary: LocalVaultSummary }>> {
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
        if (capturedInput.autoUnlock === "preserve" && previous.data?.state !== "active")
          return vaultFailure("auto-unlock-disabled");
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
        const entry: VaultEntry = {
          schemaVersion: 1,
          revision: random(),
          profile,
          state: "active",
          accepted,
          userKey: material.data.userKey,
        };
        const ready = admitVaultEntry(entry, profile);
        if (!ready.ok) return ready;
        await options.checkpoint?.("before-write");
        if (!current(captured, op.signal)) return vaultFailure("cancelled");
        writeAttempted = true;
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
            }
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
        uncertain = false;
        const handle = handleFor(ready.data);
        // Retain metadata only; the host owns encrypted items and native keys.
        live = { handle, opened: candidate, summary: summary(ready.data) };
        if (staged === candidate) staged = undefined;
        candidate = undefined;
        return {
          ok: true,
          data: { handle: structuredClone(handle), summary: summary(ready.data) },
        };
      } catch {
        if (writeAttempted) {
          uncertain = true;
          await fence();
        }
        return vaultFailure(writeAttempted ? "storage-uncertain" : "storage-failed");
      } finally {
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
        if (stored.data.state !== "active") return vaultFailure("auto-unlock-disabled");
        const entry = stored.data;
        const opened = await verifiedOpen(
          entry.accepted.prepared,
          entry.accepted.snapshotId,
          { kind: "decrypted-key", userKey: entry.userKey },
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
    async lock() {
      await fence();
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
    /** Secret-free passkey metadata for one item of the live accepted snapshot. */
    async passkeyCandidates(handle: LocalVaultHandle, itemId: string, signal?: AbortSignal) {
      try {
        handle = structuredClone(handle);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (typeof itemId !== "string") return vaultFailure("invalid-request");
      if (!validHandle(handle) || !live) return vaultFailure("stale-vault-handle");
      const owner = live;
      const before = await checkDurable(owner);
      if (!before.ok || !validHandle(handle))
        return before.ok ? vaultFailure("stale-vault-handle") : before;
      const result = await options.host.passkeyCandidates(owner.opened.session, itemId, signal);
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
    async resolveField(
      handle: LocalVaultHandle,
      ref: LocalFieldReference,
      grant: { snapshotId: string; allowedFieldIds: readonly string[]; nowMs?: number },
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
