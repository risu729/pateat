import { sameVaultEntry, vaultFailure, type VaultEntry, type VaultResult } from "./record";
import type { KeyRetention, LocalVaultSummary } from "./manager-types";
import type { SessionKey } from "./session-key";
import type { VaultSession } from "./manager-session";

export function vaultKeyOperations(context: VaultSession) {
  return {
    /** Expected revision is used only to compensate a cancelled first enrollment,
     * never to disable an unrelated newer accepted record. */
    async disableAutoUnlock(expectedRevision?: string): Promise<VaultResult<LocalVaultSummary>> {
      if (!context.profile) return vaultFailure("invalid-profile");
      if (context.disposed) return vaultFailure("crypto-locked");
      if (context.disabling) return vaultFailure("resource-limit");
      context.disabling = true;
      try {
        await context.fence();
        await context.sessionKey.clear();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          // Bounded CAS retry only for destructive disable, never stale candidate acceptance.
          // eslint-disable-next-line no-await-in-loop
          const stored = await context.options.store.read();
          if (!stored.ok) return stored;
          if (expectedRevision !== undefined && stored.data?.revision !== expectedRevision)
            return vaultFailure("storage-conflict");
          const next: VaultEntry = {
            schemaVersion: 1,
            revision: context.random(),
            profile: context.profile,
            state: "disabled",
            ...(stored.data?.accepted ? { accepted: stored.data.accepted } : {}),
          };
          // eslint-disable-next-line no-await-in-loop
          const write = await context.options.store.compareAndSwap(
            stored.data?.revision ?? null,
            next,
          );
          if (!write.ok) {
            if (write.error.code === "storage-conflict" && expectedRevision === undefined) continue;
            context.uncertain = write.error.code === "storage-uncertain";
            return write;
          }
          // eslint-disable-next-line no-await-in-loop
          const readback = await context.options.store.read();
          if (!readback.ok || !sameVaultEntry(readback.data, next)) {
            context.uncertain = true;
            return vaultFailure("storage-uncertain");
          }
          context.uncertain = false;
          return { ok: true, data: context.summary(next) };
        }
        return vaultFailure("storage-conflict");
      } catch {
        context.uncertain = true;
        return vaultFailure("storage-uncertain");
      } finally {
        context.disabling = false;
      }
    },
    /**
     * Locks the vault and keeps its sign-in (ADR 0075): the open session ends, this
     * session's key is dropped and a key on disk is removed from the record, which keeps
     * the encrypted context for an offline unlock. Answers the record's summary after the
     * lock, or null when there is no record.
     */
    async lockVault(): Promise<VaultResult<LocalVaultSummary | null>> {
      if (!context.profile) return vaultFailure("invalid-profile");
      if (context.disposed) return vaultFailure("crypto-locked");
      if (context.disabling) return vaultFailure("resource-limit");
      context.disabling = true;
      try {
        await context.fence();
        // Memory first: once this resolves, no unlock of this browser session is left.
        await context.sessionKey.clear();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          // eslint-disable-next-line no-await-in-loop
          const stored = await context.options.store.read();
          // A record that fails admission never unlocks again, so with the session key
          // gone nothing of it is open.
          if (!stored.ok && stored.error.code === "invalid-cache-record")
            return { ok: true, data: null };
          if (!stored.ok) return stored;
          if (stored.data?.state !== "active")
            return { ok: true, data: stored.data ? context.summary(stored.data) : null };
          const next: VaultEntry = {
            schemaVersion: 1,
            revision: context.random(),
            profile: context.profile,
            state: "locked",
            accepted: stored.data.accepted,
          };
          // eslint-disable-next-line no-await-in-loop
          const write = await context.options.store.compareAndSwap(stored.data.revision, next);
          if (!write.ok) {
            if (write.error.code === "storage-conflict") continue;
            context.uncertain = write.error.code === "storage-uncertain";
            return write;
          }
          // eslint-disable-next-line no-await-in-loop
          const readback = await context.options.store.read();
          if (!readback.ok || !sameVaultEntry(readback.data, next)) {
            context.uncertain = true;
            return vaultFailure("storage-uncertain");
          }
          context.uncertain = false;
          return { ok: true, data: context.summary(next) };
        }
        return vaultFailure("storage-conflict");
      } catch {
        context.uncertain = true;
        return vaultFailure("storage-uncertain");
      } finally {
        context.disabling = false;
      }
    },
    /**
     * Moves an unlocked vault's key to where `retention` now says, after the vault timeout
     * changed: from the record to this session's memory, or back. The open session keeps
     * serving the same snapshot. A locked vault stays locked.
     */
    async keepKey(retention: KeyRetention): Promise<VaultResult<true>> {
      if (!context.profile) return vaultFailure("invalid-profile");
      if (context.disposed || context.disabling) return vaultFailure("crypto-locked");
      if (context.busy) return vaultFailure("resource-limit");
      context.busy = true;
      const captured = context.epoch;
      let written: SessionKey | undefined;
      try {
        const stored = await context.options.store.read();
        // A record that fails admission holds no key anyone can use.
        if (!stored.ok && stored.error.code === "invalid-cache-record")
          return { ok: true, data: true };
        if (!stored.ok) return stored;
        const entry = stored.data;
        let next: VaultEntry;
        if (retention === "session" && entry?.state === "active") {
          next = {
            schemaVersion: 1,
            revision: context.random(),
            profile: context.profile,
            state: "locked",
            accepted: entry.accepted,
          };
          // A lock that started meanwhile already cleared memory; nothing may refill it.
          if (context.epoch !== captured) return vaultFailure("cancelled");
          written = { revision: next.revision, userKey: entry.userKey };
          await context.sessionKey.write(written);
        } else if (retention === "durable" && entry?.state === "locked") {
          const userKey = await context.keyFor(entry);
          if (!userKey) return { ok: true, data: true };
          next = {
            schemaVersion: 1,
            revision: context.random(),
            profile: context.profile,
            state: "active",
            accepted: entry.accepted,
            userKey,
          };
        } else return { ok: true, data: true };
        if (context.epoch !== captured) return vaultFailure("cancelled");
        context.writing = next.revision;
        const write = await context.options.store.compareAndSwap(entry.revision, next);
        if (!write.ok) {
          if (write.error.code === "storage-uncertain") {
            context.uncertain = true;
            await context.fence();
          }
          return write;
        }
        const readback = await context.options.store.read();
        if (!readback.ok || !sameVaultEntry(readback.data, next)) {
          context.uncertain = true;
          await context.fence();
          return vaultFailure("storage-uncertain");
        }
        // Same snapshot and record ID: only the revision the open session checks moves.
        if (context.live && context.live.summary.revision === entry.revision)
          context.live = { ...context.live, summary: context.summary(next) };
        if (retention === "durable") await context.sessionKey.clear().catch(() => undefined);
        return { ok: true, data: true };
      } catch {
        context.uncertain = true;
        await context.fence();
        return vaultFailure("storage-uncertain");
      } finally {
        context.writing = undefined;
        // A lock, log out or removal ran meanwhile: the key this move wrote must not
        // outlive it.
        if (written && context.epoch !== captured) {
          const left = await context.sessionKey.read().catch(() => undefined);
          if (left?.revision === written.revision && left.userKey === written.userKey)
            await context.sessionKey.clear().catch(() => undefined);
        }
        context.busy = false;
      }
    },
    /** Locks any open native session, then deletes this connection's durable record and
     * the unlock key retained in it. The manager stays usable for a later accept. */
    async remove(): Promise<VaultResult<true>> {
      if (!context.profile) return vaultFailure("invalid-profile");
      if (context.disposed) return vaultFailure("crypto-locked");
      if (context.disabling) return vaultFailure("resource-limit");
      context.disabling = true;
      try {
        await context.fence();
        await context.sessionKey.clear();
        const removed = await context.options.store.remove();
        context.uncertain = !removed.ok && removed.error.code === "storage-uncertain";
        return removed;
      } catch {
        context.uncertain = true;
        return vaultFailure("storage-uncertain");
      } finally {
        context.disabling = false;
      }
    },
  };
}
