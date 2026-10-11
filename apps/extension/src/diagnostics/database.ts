// The per-device diagnostics database (ADR 0019): `meta` holds the pseudonym key, the
// previous build revision and the debug-logging deadline; `entries` holds the log.
export const DIAGNOSTICS_DATABASE_NAME = "pateat.diagnostics.v1";
export const DIAGNOSTICS_DATABASE_VERSION = 2;
export const META_STORE = "meta";
export const ENTRIES_STORE = "entries";
/** Entries by time, for age-based pruning and export order. */
export const TIME_INDEX = "time";
/** Entries by `[level, time]`, for per-level counts and oldest-first deletes. */
export const LEVEL_INDEX = "level-time";

export function request<T>(open: () => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const pending = open();
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(new Error("storage-failed"));
  });
}

/** Resolves when the transaction commits; an abort rejects without going unhandled. */
export function completion(transaction: IDBTransaction): Promise<void> {
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(new Error("storage-failed"));
    transaction.onerror = () => reject(new Error("storage-failed"));
  });
  done.catch(() => undefined);
  return done;
}

export function openDiagnosticsDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(name, DIAGNOSTICS_DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      const database = opening.result;
      if (!database.objectStoreNames.contains(META_STORE)) database.createObjectStore(META_STORE);
      if (!database.objectStoreNames.contains(ENTRIES_STORE)) {
        const entries = database.createObjectStore(ENTRIES_STORE, { autoIncrement: true });
        entries.createIndex(TIME_INDEX, "time");
        entries.createIndex(LEVEL_INDEX, ["level", "time"]);
      }
    };
    opening.onsuccess = () => {
      const database = opening.result;
      // A newer schema must never wait on this connection.
      database.onversionchange = () => database.close();
      resolve(database);
    };
    opening.onerror = () => reject(new Error("storage-failed"));
    opening.onblocked = () => reject(new Error("storage-failed"));
  });
}
