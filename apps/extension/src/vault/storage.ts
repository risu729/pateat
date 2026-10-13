import { normalizeBitwardenProfile, type BitwardenProfile } from "@pateat/bitwarden";
import {
  admitVaultEntry,
  sameVaultEntry,
  vaultFailure,
  type VaultEntry,
  type VaultResult,
  type VaultErrorCode,
} from "./record";
import {
  createVaultDatabase,
  RECORDS_STORE,
  runVaultTransaction,
  type VaultConnection,
  type VaultStore,
} from "./database";

export interface DurableVaultStore {
  read(): Promise<VaultResult<VaultEntry | null>>;
  compareAndSwap(
    expectedRevision: string | null,
    next: VaultEntry,
    signal?: AbortSignal,
  ): Promise<VaultResult<{ revision: string }>>;
  /** Deletes this connection's record, including its retained unlock key, whatever its state. */
  remove(signal?: AbortSignal): Promise<VaultResult<true>>;
  close(): void;
}
/** Background-owned native IndexedDB. No content/page message API exposes this store. */
export function createIndexedDbVaultStore(options: {
  profile: BitwardenProfile;
  databaseName?: string;
  timeoutMs?: number;
}): DurableVaultStore {
  const normalized = normalizeBitwardenProfile(structuredClone(options.profile));
  const profile = normalized.ok ? normalized.data : undefined;
  const database = createVaultDatabase(options);
  const open = () => (profile ? database.open() : Promise.reject(new Error()));
  function transaction<T>(
    db: VaultConnection,
    mode: IDBTransactionMode,
    work: (
      store: VaultStore,
      set: (result: VaultResult<T>) => void,
      abort: (code: VaultErrorCode) => void,
    ) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<VaultResult<T>> {
    return runVaultTransaction<T>(
      db,
      RECORDS_STORE,
      mode,
      database.timeout,
      (stores, set, abort) => work(stores(RECORDS_STORE), set, abort),
      signal,
    );
  }
  return {
    async read() {
      if (!profile) return vaultFailure("invalid-profile");
      try {
        return await transaction<VaultEntry | null>(
          await open(),
          "readonly",
          async (store, set, abort) => {
            const stored: unknown = await store.get(profile.connectionId);
            if (stored === undefined) {
              set({ ok: true, data: null });
              return;
            }
            const admitted = admitVaultEntry(stored, profile);
            if (!admitted.ok) {
              abort(admitted.error.code);
              return;
            }
            set(admitted);
          },
        );
      } catch {
        return vaultFailure("storage-failed");
      }
    },
    async compareAndSwap(expectedRevision, next, signal) {
      if (!profile) return vaultFailure("invalid-profile");
      const admitted = admitVaultEntry(next, profile);
      if (!admitted.ok) return admitted;
      if (admitted.data.revision === expectedRevision) return vaultFailure("invalid-cache-record");
      try {
        return await transaction<{ revision: string }>(
          await open(),
          "readwrite",
          async (store, set, abort) => {
            const current: unknown = await store.get(profile.connectionId);
            const old =
              current === undefined
                ? { ok: true as const, data: null }
                : admitVaultEntry(current, profile);
            if (!old.ok) {
              abort(old.error.code);
              return;
            }
            if ((old.data?.revision ?? null) !== expectedRevision) {
              abort("storage-conflict");
              return;
            }
            // Both requests are queued before either is awaited; the read-back sees the write.
            const [, readback] = await Promise.all([
              store.put(admitted.data, profile.connectionId),
              store.get(profile.connectionId),
            ]);
            if (!sameVaultEntry(readback, admitted.data)) {
              abort("storage-uncertain");
              return;
            }
            set({ ok: true, data: { revision: admitted.data.revision } });
          },
          signal,
        );
      } catch {
        return vaultFailure("storage-failed");
      }
    },
    async remove(signal) {
      if (!profile) return vaultFailure("invalid-profile");
      try {
        return await transaction<true>(
          await open(),
          "readwrite",
          async (store, set, abort) => {
            // A corrupt record is deleted too; deletion never needs to admit it.
            const [, remaining] = await Promise.all([
              store.delete(profile.connectionId),
              store.count(profile.connectionId),
            ]);
            if (remaining !== 0) {
              abort("storage-uncertain");
              return;
            }
            set({ ok: true, data: true });
          },
          signal,
        );
      } catch {
        return vaultFailure("storage-failed");
      }
    },
    close() {
      database.close();
    },
  };
}
