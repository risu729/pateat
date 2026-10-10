import { normalizeBitwardenProfile, type BitwardenProfile } from "@pateat/bitwarden";
import {
  admitVaultEntry,
  sameVaultEntry,
  vaultFailure,
  type VaultEntry,
  type VaultResult,
  type VaultErrorCode,
} from "./record";

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
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const normalized = normalizeBitwardenProfile(structuredClone(options.profile));
  const profile = normalized.ok ? normalized.data : undefined;
  const timeout = options.timeoutMs ?? 10_000;
  const name = options.databaseName ?? "pateat.local-vault.v1";
  let opening: Promise<IDBDatabase> | undefined;
  let database: IDBDatabase | undefined;
  let closed = false;
  function open() {
    if (
      closed ||
      !profile ||
      !factory ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > 30_000
    )
      return Promise.reject(new Error());
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      let ended = false;
      const request = factory.open(name, 1);
      const timer = setTimeout(() => {
        ended = true;
        reject(new Error());
      }, timeout);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("records"))
          request.result.createObjectStore("records");
      };
      request.onerror = () => {
        clearTimeout(timer);
        ended = true;
        reject(new Error());
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        if (ended || closed) {
          request.result.close();
          reject(new Error());
          return;
        }
        const opened = request.result;
        database = opened;
        opened.onversionchange = () => {
          opened.close();
          if (database === opened) {
            database = undefined;
            opening = undefined;
          }
        };
        resolve(opened);
      };
    }).catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  }
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
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve(vaultFailure("cancelled"));
        return;
      }
      const tx = db.transaction("records", mode, { durability: "strict" });
      let result: VaultResult<T> = vaultFailure("storage-uncertain");
      let abortCode: VaultErrorCode = "storage-failed";
      let ended = false;
      const abort = (code: VaultErrorCode) => {
        abortCode = code;
        try {
          tx.abort();
        } catch {
          result = vaultFailure("storage-uncertain");
        }
      };
      const cancelled = () => abort("cancelled");
      signal?.addEventListener("abort", cancelled, { once: true });
      const timer = setTimeout(() => {
        abort("storage-uncertain");
        finish(vaultFailure("storage-uncertain"));
      }, timeout);
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancelled);
      };
      const finish = (value: VaultResult<T>) => {
        if (ended) return;
        ended = true;
        cleanup();
        resolve(value);
      };
      tx.onabort = () => {
        finish(
          vaultFailure(
            tx.error?.name === "QuotaExceededError" ? "cache-quota-exceeded" : abortCode,
          ),
        );
      };
      // Request success is not a commit. Only transaction completion publishes a result.
      tx.oncomplete = () => {
        finish(signal?.aborted ? vaultFailure("storage-uncertain") : result);
      };
      tx.onerror = () => {
        if (tx.error?.name === "QuotaExceededError") abortCode = "cache-quota-exceeded";
      };
      try {
        work(
          tx.objectStore("records"),
          (value) => {
            result = value;
          },
          abort,
        );
      } catch {
        abort("storage-failed");
      }
    });
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
      closed = true;
      database?.close();
      database = undefined;
    },
  };
}
