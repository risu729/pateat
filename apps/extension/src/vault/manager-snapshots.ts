import type { OpenedHostSession } from "../crypto/host";
import type { HostUnlock } from "../crypto/wire";
import type { PreparedBitwardenAccount } from "@pateat/bitwarden";
import { admitPreparedBitwardenAccount } from "@pateat/bitwarden";
import * as v from "valibot";
import {
  admitVaultEntry,
  sameVaultEntry,
  vaultFailure,
  type AcceptedVaultContext,
  type VaultEntry,
  type VaultResult,
} from "./record";
import type { LocalVaultHandle, LocalVaultSummary } from "./manager-types";
import type { SessionKey } from "./session-key";
import type { VaultSession } from "./manager-session";

const itemIdSchema = v.pipe(v.string(), v.uuid());

export function vaultSnapshotOperations(context: VaultSession) {
  return {
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
      if (!context.profile) return vaultFailure("invalid-profile");
      if (context.disposed || context.disabling) return vaultFailure("crypto-locked");
      if (context.busy) return vaultFailure("resource-limit");
      let capturedInput: typeof input;
      try {
        capturedInput = structuredClone(input);
      } catch {
        return vaultFailure("invalid-request");
      }
      if (capturedInput.autoUnlock !== "enable" && capturedInput.autoUnlock !== "preserve")
        return vaultFailure("invalid-request");
      const admitted = admitPreparedBitwardenAccount(capturedInput.prepared, context.profile);
      if (!admitted.ok) return admitted;
      const unlock = capturedInput.unlock;
      context.busy = true;
      const captured = context.epoch;
      const op = context.operation(signal);
      let candidate: OpenedHostSession | undefined;
      let writeAttempted = false;
      try {
        const previous = await context.options.store.read();
        if (!previous.ok) {
          await context.fence();
          return previous;
        }
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        if (capturedInput.autoUnlock === "preserve" && !(await context.keyFor(previous.data)))
          return vaultFailure(
            previous.data?.state === "locked" ? "vault-locked" : "auto-unlock-disabled",
          );
        const prepared = context.continuity(admitted.data, previous.data);
        if (!prepared.ok) return prepared;
        const snapshotId = context.random();
        const opened = await context.verifiedOpen(
          prepared.data,
          snapshotId,
          unlock,
          captured,
          op.signal,
        );
        if (!opened.ok) return opened;
        candidate = opened.data;
        const material = await context.options.host.exportUnlockMaterial(
          candidate.session,
          op.signal,
        );
        if (!material.ok) return material;
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        if (JSON.stringify(material.data.metadata) !== JSON.stringify(candidate.metadata))
          return vaultFailure("crypto-failed");
        const accepted: AcceptedVaultContext = {
          recordId: context.random(),
          snapshotId,
          userId: candidate.metadata.userId,
          accountVersion: candidate.metadata.accountVersion,
          minimumSecurityVersion: candidate.metadata.securityVersion,
          acceptedAt: context.now(),
          coverage: "received-envelope",
          prepared: {
            ...prepared.data,
            minimumSecurityVersion: candidate.metadata.securityVersion,
          },
        };
        const retention = await context.retentionOf();
        const entry: VaultEntry =
          retention === "durable"
            ? {
                schemaVersion: 1,
                revision: context.random(),
                profile: context.profile,
                state: "active",
                accepted,
                userKey: material.data.userKey,
              }
            : {
                schemaVersion: 1,
                revision: context.random(),
                profile: context.profile,
                state: "locked",
                accepted,
              };
        const ready = admitVaultEntry(entry, context.profile);
        if (!ready.ok) return ready;
        // Only item UUIDs can be compared; one other ID must not stop the rest.
        const compared = Array.isArray(capturedInput.compareCustomFields)
          ? [...new Set(capturedInput.compareCustomFields.filter((id) => v.is(itemIdSchema, id)))]
          : [];
        context.forgetEndedLive();
        const old = context.live;
        const comparison =
          compared.length &&
          !context.skipComparison &&
          old &&
          !context.uncertain &&
          previous.data?.accepted &&
          old.handle.recordId === previous.data.accepted.recordId &&
          old.handle.snapshotId === previous.data.accepted.snapshotId
            ? await context.sameCustomFields(old.opened, candidate, compared, op.signal)
            : { items: [], candidateEnded: false };
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        // A candidate the crypto host may have ended cannot serve logins; fail before the
        // write so the stored snapshot stays and later syncs retry without comparing.
        if (comparison.candidateEnded) {
          context.skipComparison = true;
          return vaultFailure("crypto-failed");
        }
        const sameFields = comparison.items;
        // This session's key for the record still stored, put back if the write fails.
        const priorKey =
          retention === "session"
            ? await context.sessionKey.read().catch(() => undefined)
            : undefined;
        await context.options.checkpoint?.("before-write");
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        // The key goes to memory before the record that needs it, so a write that lands is
        // never locked by a missing key; a key for a revision that never lands unlocks nothing.
        if (retention === "session")
          await context.sessionKey.write({
            revision: ready.data.revision,
            userKey: material.data.userKey,
          });
        writeAttempted = true;
        context.writing = ready.data.revision;
        const write = await context.options.store.compareAndSwap(
          previous.data?.revision ?? null,
          ready.data,
          op.signal,
        );
        if (!write.ok) {
          if (write.error.code === "storage-uncertain") {
            context.uncertain = true;
            await context.fence();
          } else {
            const read = await context.options.store.read();
            if (!read.ok || !sameVaultEntry(read.data, previous.data)) {
              context.uncertain = true;
              await context.fence();
            } else if (
              priorKey &&
              priorKey.revision === previous.data?.revision &&
              !context.disposed &&
              context.epoch === captured
            )
              // The old record stays, so the vault this session unlocked stays unlocked.
              await context.sessionKey.write(priorKey).catch(() => undefined);
          }
          return write;
        }
        await context.options.checkpoint?.("after-write");
        if (!context.current(captured, op.signal)) {
          context.uncertain = true;
          await context.fence();
          return vaultFailure("storage-uncertain");
        }
        const readback = await context.options.store.read();
        if (
          !readback.ok ||
          !sameVaultEntry(readback.data, ready.data) ||
          !context.current(captured, op.signal)
        ) {
          context.uncertain = true;
          await context.fence();
          return vaultFailure("storage-uncertain");
        }
        await context.lockLive();
        if (!context.current(captured, op.signal)) {
          context.uncertain = true;
          return vaultFailure("storage-uncertain");
        }
        // A key kept on disk again leaves none in memory.
        if (retention === "durable") await context.sessionKey.clear().catch(() => undefined);
        context.uncertain = false;
        context.skipComparison = false;
        const handle = context.handleFor(ready.data);
        // Retain metadata only; the host owns encrypted items and native keys.
        context.live = { handle, opened: candidate, summary: context.summary(ready.data) };
        if (context.staged === candidate) context.staged = undefined;
        candidate = undefined;
        return {
          ok: true,
          data: {
            handle: structuredClone(handle),
            summary: context.summary(ready.data),
            sameCustomFields: sameFields,
            ...(sameFields.length > 0 && previous.data?.accepted
              ? { comparedSnapshotId: previous.data.accepted.snapshotId }
              : {}),
          },
        };
      } catch {
        if (writeAttempted) {
          context.uncertain = true;
          await context.fence();
        }
        return vaultFailure(writeAttempted ? "storage-uncertain" : "storage-failed");
      } finally {
        context.writing = undefined;
        const remaining = candidate ?? context.staged;
        context.staged = undefined;
        if (remaining) await context.retire(remaining);
        op.cleanup();
        context.busy = false;
      }
    },
    async restore(
      signal?: AbortSignal,
    ): Promise<VaultResult<{ handle: LocalVaultHandle; summary: LocalVaultSummary }>> {
      if (!context.profile) return vaultFailure("invalid-profile");
      if (context.disposed || context.disabling) return vaultFailure("crypto-locked");
      if (context.busy) return vaultFailure("resource-limit");
      context.busy = true;
      // Capture our own retirement epoch before waiting for native cleanup. A
      // concurrent disable must not become the epoch of a newly resumed restore.
      const retirement = context.fence();
      const captured = context.epoch;
      const op = context.operation(signal);
      let candidate: OpenedHostSession | undefined;
      try {
        await retirement;
        if (!context.current(captured, op.signal) || context.disabling)
          return vaultFailure("cancelled");
        const stored = await context.options.store.read();
        if (!stored.ok) return stored;
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        if (!stored.data) return vaultFailure("cache-missing");
        if (stored.data.state === "disabled") return vaultFailure("auto-unlock-disabled");
        const entry = stored.data;
        const userKey = await context.keyFor(entry);
        if (!userKey) return vaultFailure("vault-locked");
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        const opened = await context.verifiedOpen(
          entry.accepted.prepared,
          entry.accepted.snapshotId,
          { kind: "decrypted-key", userKey },
          captured,
          op.signal,
        );
        if (!opened.ok) return opened;
        candidate = opened.data;
        const check = await context.options.store.read();
        if (
          !check.ok ||
          !sameVaultEntry(check.data, entry) ||
          !context.current(captured, op.signal)
        ) {
          context.uncertain = true;
          await context.fence();
          return vaultFailure("storage-uncertain");
        }
        await context.lockLive();
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        const handle = context.handleFor(entry);
        context.live = { handle, opened: candidate, summary: context.summary(entry) };
        if (context.staged === candidate) context.staged = undefined;
        candidate = undefined;
        context.uncertain = false;
        return {
          ok: true,
          data: { handle: structuredClone(handle), summary: context.summary(entry) },
        };
      } catch {
        return vaultFailure("storage-failed");
      } finally {
        const remaining = candidate ?? context.staged;
        context.staged = undefined;
        if (remaining) await context.retire(remaining);
        op.cleanup();
        context.busy = false;
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
      if (!context.profile) return vaultFailure("invalid-profile");
      if (context.disposed || context.disabling) return vaultFailure("crypto-locked");
      if (context.busy) return vaultFailure("resource-limit");
      if (typeof password !== "string" || !password) return vaultFailure("invalid-request");
      context.busy = true;
      const retirement = context.fence();
      const captured = context.epoch;
      const op = context.operation(signal);
      let candidate: OpenedHostSession | undefined;
      let written: SessionKey | undefined;
      try {
        await retirement;
        if (!context.current(captured, op.signal) || context.disabling)
          return vaultFailure("cancelled");
        const stored = await context.options.store.read();
        if (!stored.ok) return stored;
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        if (!stored.data) return vaultFailure("cache-missing");
        if (stored.data.state === "disabled") return vaultFailure("auto-unlock-disabled");
        const entry = stored.data;
        // Read before the key exists, so nothing awaits between the last check and its write.
        const retention = await context.retentionOf();
        const opened = await context.verifiedOpen(
          entry.accepted.prepared,
          entry.accepted.snapshotId,
          { kind: "password", password },
          captured,
          op.signal,
        );
        if (!opened.ok) return opened;
        candidate = opened.data;
        const material = await context.options.host.exportUnlockMaterial(
          candidate.session,
          op.signal,
        );
        if (!material.ok) return material;
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        if (JSON.stringify(material.data.metadata) !== JSON.stringify(candidate.metadata))
          return vaultFailure("crypto-failed");
        const next: VaultEntry =
          retention === "durable"
            ? entry.state === "active"
              ? entry
              : {
                  schemaVersion: 1,
                  revision: context.random(),
                  profile: context.profile,
                  state: "active",
                  accepted: entry.accepted,
                  userKey: material.data.userKey,
                }
            : entry.state === "locked"
              ? entry
              : {
                  schemaVersion: 1,
                  revision: context.random(),
                  profile: context.profile,
                  state: "locked",
                  accepted: entry.accepted,
                };
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        if (retention === "session") {
          written = { revision: next.revision, userKey: material.data.userKey };
          await context.sessionKey.write(written);
        }
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        if (next !== entry) {
          context.writing = next.revision;
          const write = await context.options.store.compareAndSwap(entry.revision, next, op.signal);
          if (!write.ok) {
            if (write.error.code === "storage-uncertain") {
              context.uncertain = true;
              await context.fence();
            }
            return write;
          }
        }
        const readback = await context.options.store.read();
        if (
          !readback.ok ||
          !sameVaultEntry(readback.data, next) ||
          !context.current(captured, op.signal)
        ) {
          context.uncertain = true;
          await context.fence();
          return vaultFailure("storage-uncertain");
        }
        if (retention === "durable") await context.sessionKey.clear().catch(() => undefined);
        await context.lockLive();
        if (!context.current(captured, op.signal)) return vaultFailure("cancelled");
        const handle = context.handleFor(next);
        context.live = { handle, opened: candidate, summary: context.summary(next) };
        if (context.staged === candidate) context.staged = undefined;
        candidate = undefined;
        context.uncertain = false;
        written = undefined;
        return {
          ok: true,
          data: { handle: structuredClone(handle), summary: context.summary(next) },
        };
      } catch {
        return vaultFailure("storage-failed");
      } finally {
        context.writing = undefined;
        // A lock, log out or removal ran meanwhile: the key this unlock wrote must not
        // outlive it.
        if (written && context.epoch !== captured) {
          const left = await context.sessionKey.read().catch(() => undefined);
          if (left?.revision === written.revision && left.userKey === written.userKey)
            await context.sessionKey.clear().catch(() => undefined);
        }
        const remaining = candidate ?? context.staged;
        context.staged = undefined;
        if (remaining) await context.retire(remaining);
        op.cleanup();
        context.busy = false;
      }
    },
  };
}
