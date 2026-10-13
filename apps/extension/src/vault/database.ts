import { openDB, type IDBPDatabase, type IDBPObjectStore } from "idb";
import { vaultFailure, type VaultErrorCode, type VaultResult } from "./record";

export const VAULT_DATABASE_NAME = "pateat.local-vault.v1";
/** The only schema: vault records and provider sessions. */
export const VAULT_DATABASE_VERSION = 2;
export const RECORDS_STORE = "records";
export const PROVIDER_SESSIONS_STORE = "providerSessions";
export type VaultStoreName = typeof RECORDS_STORE | typeof PROVIDER_SESSIONS_STORE;

export type VaultDatabaseOptions = {
  databaseName?: string;
  timeoutMs?: number;
};

/** The stores are untyped: every reader admits what it reads. */
export type VaultConnection = IDBPDatabase;

/** One lazily opened connection per caller (each vault and session store owns one).
 * Every opener upgrades through this single schema and yields to a newer version. */
export function createVaultDatabase(options: VaultDatabaseOptions = {}) {
  const timeout = options.timeoutMs ?? 10_000;
  const name = options.databaseName ?? VAULT_DATABASE_NAME;
  let opening: Promise<VaultConnection> | undefined;
  let database: VaultConnection | undefined;
  let closed = false;
  const validTimeout = Number.isInteger(timeout) && timeout >= 1 && timeout <= 30_000;
  function open(): Promise<VaultConnection> {
    if (closed || globalThis.indexedDB === undefined || !validTimeout) {
      return Promise.reject(new Error());
    }
    opening ??= new Promise<VaultConnection>((resolve, reject) => {
      let ended = false;
      const timer = setTimeout(() => {
        // A blocked upgrade keeps waiting natively; this opener stops waiting and fails closed.
        ended = true;
        reject(new Error());
      }, timeout);
      const connect = async () => {
        let opened: VaultConnection;
        try {
          opened = await openDB(name, VAULT_DATABASE_VERSION, {
            upgrade(db) {
              db.createObjectStore(RECORDS_STORE);
              db.createObjectStore(PROVIDER_SESSIONS_STORE);
            },
          });
        } catch {
          clearTimeout(timer);
          ended = true;
          reject(new Error());
          return;
        }
        clearTimeout(timer);
        if (ended || closed) {
          opened.close();
          reject(new Error());
          return;
        }
        database = opened;
        // A newer schema must never wait on this connection.
        opened.addEventListener("versionchange", () => {
          opened.close();
          if (database === opened) {
            database = undefined;
            opening = undefined;
          }
        });
        resolve(opened);
      };
      void connect();
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

/** Typed for writing; a readonly transaction rejects a write when it is attempted. */
export type VaultStore = IDBPObjectStore<
  unknown,
  VaultStoreName[] | VaultStoreName,
  VaultStoreName,
  "readwrite"
>;

/** The work awaits only requests of its own transaction: any other await would let the
 * transaction auto-commit before the work is done. */
export type TransactionWork<T> = (
  stores: (name: VaultStoreName) => VaultStore,
  set: (result: VaultResult<T>) => void,
  abort: (code: VaultErrorCode) => void,
) => Promise<void>;

/** Only transaction completion publishes a result; request success is not a commit. */
export async function runVaultTransaction<T>(
  db: VaultConnection,
  scope: VaultStoreName | VaultStoreName[],
  mode: IDBTransactionMode,
  timeout: number,
  work: TransactionWork<T>,
  signal?: AbortSignal,
): Promise<VaultResult<T>> {
  if (signal?.aborted) return vaultFailure("cancelled");
  const tx = db.transaction(scope, mode, { durability: "strict" });
  let result: VaultResult<T> = vaultFailure("storage-uncertain");
  // The first reason wins: later aborts only follow from it.
  let abortCode: VaultErrorCode | undefined;
  const abort = (code: VaultErrorCode) => {
    abortCode ??= code;
    try {
      tx.abort();
    } catch {
      result = vaultFailure("storage-uncertain");
    }
  };
  const cancelled = () => abort("cancelled");
  signal?.addEventListener("abort", cancelled, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<VaultResult<T>>((resolve) => {
    timer = setTimeout(() => {
      abort("storage-uncertain");
      resolve(vaultFailure("storage-uncertain"));
    }, timeout);
  });
  const run = async () => {
    try {
      await work(
        (name) => tx.objectStore(name) as VaultStore,
        (value) => {
          result = value;
        },
        abort,
      );
    } catch {
      abort("storage-failed");
    }
  };
  // `tx.done` rejects at a failed request's error event, before the transaction records why it
  // aborted; the abort event follows once `tx.error` is set.
  const aborted = new Promise<void>((resolve) => {
    tx.addEventListener("abort", () => resolve(), { once: true });
  });
  const completed = (async (): Promise<VaultResult<T>> => {
    try {
      await Promise.all([run(), tx.done]);
      return signal?.aborted ? vaultFailure("storage-uncertain") : result;
    } catch {
      await aborted;
      return vaultFailure(
        tx.error?.name === "QuotaExceededError"
          ? "cache-quota-exceeded"
          : (abortCode ?? "storage-failed"),
      );
    }
  })();
  try {
    return await Promise.race([completed, deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", cancelled);
  }
}
