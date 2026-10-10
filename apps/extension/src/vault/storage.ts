import { normalizeBitwardenProfile, type BitwardenProfile } from "@pateat/bitwarden";
import {
  admitVaultEntry,
  sameVaultEntry,
  vaultFailure,
  type VaultEntry,
  type VaultResult,
  type VaultErrorCode,
} from "./record";
import { createVaultDatabase, RECORDS_STORE, runVaultTransaction } from "./database";

export interface DurableVaultStore {
  read(): Promise<VaultResult<VaultEntry | null>>;
  compareAndSwap(
    expectedRevision: string | null,
    next: VaultEntry,
    signal?: AbortSignal,
  ): Promise<VaultResult<{ revision: string }>>;
  close(): void;
}
/** Background-owned native IndexedDB. No content/page message API exposes this store. */
export function createIndexedDbVaultStore(options: {
  profile: BitwardenProfile;
  indexedDB?: IDBFactory;
  databaseName?: string;
  timeoutMs?: number;
}): DurableVaultStore {
  const normalized = normalizeBitwardenProfile(structuredClone(options.profile));
  const profile = normalized.ok ? normalized.data : undefined;
  const database = createVaultDatabase(options);
  const open = () => (profile ? database.open() : Promise.reject(new Error()));
  function transaction<T>(
    db: IDBDatabase,
    mode: IDBTransactionMode,
    work: (
      store: IDBObjectStore,
      set: (result: VaultResult<T>) => void,
      abort: (code: VaultErrorCode) => void,
    ) => void,
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
          (store, set, abort) => {
            const request = store.get(profile.connectionId);
            request.onsuccess = () => {
              if (request.result === undefined) {
                set({ ok: true, data: null });
                return;
              }
              const admitted = admitVaultEntry(request.result, profile);
              if (!admitted.ok) {
                abort(admitted.error.code);
                return;
              }
              set(admitted);
            };
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
          (store, set, abort) => {
            const current = store.get(profile.connectionId);
            current.onsuccess = () => {
              const old =
                current.result === undefined
                  ? { ok: true as const, data: null }
                  : admitVaultEntry(current.result, profile);
              if (!old.ok) {
                abort(old.error.code);
                return;
              }
              if ((old.data?.revision ?? null) !== expectedRevision) {
                abort("storage-conflict");
                return;
              }
              store.put(admitted.data, profile.connectionId);
              const readback = store.get(profile.connectionId);
              readback.onsuccess = () => {
                if (!sameVaultEntry(readback.result, admitted.data)) {
                  abort("storage-uncertain");
                  return;
                }
                set({ ok: true, data: { revision: admitted.data.revision } });
              };
            };
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
