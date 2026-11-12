import { normalizeBitwardenProfile, type PreparedBitwardenAccount } from "@pateat/bitwarden";
import { newId } from "@pateat/contracts/ids";
import type { OpenedHostSession } from "../crypto/host";
import type { HostUnlock } from "../crypto/wire";
import { vaultFailure, type VaultEntry, type VaultResult } from "./record";
import { memorySessionKeyStore } from "./session-key";
import type {
  KeyRetention,
  LocalVaultHandle,
  LocalVaultSummary,
  LocalVaultManagerOptions,
} from "./manager-types";

/** Crypto host failures after which the session may no longer exist. */
function sessionMayHaveEnded(code: string): boolean {
  return code === "timeout" || code === "crypto-locked" || code === "crypto-failed";
}
export function createVaultSession(options: LocalVaultManagerOptions) {
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
  /** Run against one live session only while its durable authority still holds. */
  async function withLiveVault<T>(
    handle: LocalVaultHandle,
    invoke: (session: OpenedHostSession["session"]) => Promise<VaultResult<T>>,
  ): Promise<VaultResult<T>> {
    if (!validHandle(handle) || !live) return vaultFailure("stale-vault-handle");
    const owner = live;
    const before = await checkDurable(owner);
    if (!before.ok || !validHandle(handle))
      return before.ok ? vaultFailure("stale-vault-handle") : before;
    const result = await invoke(owner.opened.session);
    const after = await checkDurable(owner);
    if (!after.ok) return after;
    return validHandle(handle) && live === owner ? result : vaultFailure("stale-vault-handle");
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
    // Every received item is either verified or named unusable, once (ADR 0006).
    const received = new Set(prepared.ciphers.map((cipher) => String(cipher.id).toLowerCase()));
    const unusable = checked.ok
      ? checked.data.unusableItems.map((item) => item.itemId.toLowerCase())
      : [];
    // A partly readable item is a verified one, named once and never also unusable.
    const partial = checked.ok
      ? checked.data.partialItems.map((item) => item.itemId.toLowerCase())
      : [];
    if (
      !checked.ok ||
      checked.data.verifiedCipherCount + unusable.length !== prepared.ciphers.length ||
      new Set(unusable).size !== unusable.length ||
      !unusable.every((itemId) => received.has(itemId)) ||
      new Set(partial).size !== partial.length ||
      !partial.every((itemId) => received.has(itemId) && !unusable.includes(itemId)) ||
      !current(captured, signal)
    ) {
      if (staged === opened.data) staged = undefined;
      await retire(opened.data);
      if (!checked.ok) return checked;
      return current(captured, signal)
        ? { ok: false, error: { code: "crypto-failed", check: "cipher-count" } }
        : vaultFailure("cancelled");
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
    // Items the mapper left out before decryption are listed with the ones decryption
    // refused; an item type Pateat does not read is not something to fix in Bitwarden.
    opened.data.unusableItems = [
      ...prepared.unavailableItems.flatMap(({ itemId, reason }) =>
        reason === "unsupported-cipher-type" ? [] : [{ itemId, check: reason }],
      ),
      ...checked.data.unusableItems,
    ];
    opened.data.partialItems = checked.data.partialItems;
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
  // These accessors read and update the original bindings across asynchronous operations.
  return {
    options,
    profile,
    random: () => random(),
    now: () => now(),
    sessionKey,
    retentionOf,
    generation,
    summary,
    keyFor,
    current,
    retire,
    lockLive,
    fence,
    forgetEndedLive,
    handleFor,
    validHandle,
    checkDurable,
    withLiveVault,
    continuity,
    verifiedOpen,
    sameCustomFields,
    operation,
    get epoch() {
      return epoch;
    },
    get disposed() {
      return disposed;
    },
    get busy() {
      return busy;
    },
    set busy(value: typeof busy) {
      busy = value;
    },
    get disabling() {
      return disabling;
    },
    set disabling(value: typeof disabling) {
      disabling = value;
    },
    get live() {
      return live;
    },
    set live(value: typeof live) {
      live = value;
    },
    get staged() {
      return staged;
    },
    set staged(value: typeof staged) {
      staged = value;
    },
    get uncertain() {
      return uncertain;
    },
    set uncertain(value: typeof uncertain) {
      uncertain = value;
    },
    get skipComparison() {
      return skipComparison;
    },
    set skipComparison(value: typeof skipComparison) {
      skipComparison = value;
    },
    get writing() {
      return writing;
    },
    set writing(value: typeof writing) {
      writing = value;
    },
    async lock() {
      await fence();
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
          ? {
              handle: structuredClone(live.handle),
              summary: structuredClone(live.summary),
              unusableItems: structuredClone(live.opened.unusableItems ?? []),
              partialItems: structuredClone(live.opened.partialItems ?? []),
            }
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
export type VaultSession = ReturnType<typeof createVaultSession>;
