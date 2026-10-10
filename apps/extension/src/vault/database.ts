import { vaultFailure, type VaultErrorCode, type VaultResult } from "./record";

export const VAULT_DATABASE_NAME = "pateat.local-vault.v1";
/** Version 2 adds provider sessions beside the unchanged version 1 vault records. */
export const VAULT_DATABASE_VERSION = 2;
export const RECORDS_STORE = "records";
export const PROVIDER_SESSIONS_STORE = "providerSessions";
export type VaultStoreName = typeof RECORDS_STORE | typeof PROVIDER_SESSIONS_STORE;

export type VaultDatabaseOptions = {
  indexedDB?: IDBFactory;
  databaseName?: string;
  timeoutMs?: number;
};

/** One background-owned connection. Every opener upgrades through this single schema. */
export function createVaultDatabase(options: VaultDatabaseOptions = {}) {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const timeout = options.timeoutMs ?? 10_000;
  const name = options.databaseName ?? VAULT_DATABASE_NAME;
  let opening: Promise<IDBDatabase> | undefined;
  let database: IDBDatabase | undefined;
  let closed = false;
  const validTimeout = Number.isInteger(timeout) && timeout >= 1 && timeout <= 30_000;
  function open(): Promise<IDBDatabase> {
    if (closed || !factory || !validTimeout) return Promise.reject(new Error());
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      let ended = false;
      const request = factory.open(name, VAULT_DATABASE_VERSION);
      const timer = setTimeout(() => {
        // A blocked upgrade keeps waiting natively; this opener stops waiting and fails closed.
        ended = true;
        reject(new Error());
      }, timeout);
      request.onupgradeneeded = () => {
        const db = request.result;
        // Preserve existing version 1 records; only add missing stores.
        if (!db.objectStoreNames.contains(RECORDS_STORE)) db.createObjectStore(RECORDS_STORE);
        if (!db.objectStoreNames.contains(PROVIDER_SESSIONS_STORE))
          db.createObjectStore(PROVIDER_SESSIONS_STORE);
      };
      request.onerror = () => {
        clearTimeout(timer);
        ended = true;
        reject(new Error());
      };
      request.onsuccess = () => {
        clearTimeout(timer);
        const opened = request.result;
        if (ended || closed) {
          opened.close();
          reject(new Error());
          return;
        }
        database = opened;
        // A newer schema must never wait on this connection.
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
  return {
    open,
    timeout,
    close() {
      closed = true;
      database?.close();
      database = undefined;
    },
  };
}
export type VaultDatabase = ReturnType<typeof createVaultDatabase>;

export type TransactionWork<T> = (
  stores: (name: VaultStoreName) => IDBObjectStore,
  set: (result: VaultResult<T>) => void,
  abort: (code: VaultErrorCode) => void,
) => void;

/** Only transaction completion publishes a result; request success is not a commit. */
export function runVaultTransaction<T>(
  db: IDBDatabase,
  scope: VaultStoreName | VaultStoreName[],
  mode: IDBTransactionMode,
  timeout: number,
  work: TransactionWork<T>,
  signal?: AbortSignal,
): Promise<VaultResult<T>> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(vaultFailure("cancelled"));
      return;
    }
    const tx = db.transaction(scope, mode, { durability: "strict" });
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
        vaultFailure(tx.error?.name === "QuotaExceededError" ? "cache-quota-exceeded" : abortCode),
      );
    };
    tx.oncomplete = () => {
      finish(signal?.aborted ? vaultFailure("storage-uncertain") : result);
    };
    tx.onerror = () => {
      if (tx.error?.name === "QuotaExceededError") abortCode = "cache-quota-exceeded";
    };
    try {
      work(
        (name) => tx.objectStore(name),
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
