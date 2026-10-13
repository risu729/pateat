import { openDB, type DBSchema, type IDBPDatabase } from "idb";

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

/** Values are validated where they are read, so the schema types them as `unknown`. */
export interface DiagnosticsSchema extends DBSchema {
  meta: { key: string; value: unknown };
  entries: {
    key: number;
    value: unknown;
    indexes: { time: number; "level-time": [string, number] };
  };
}
export type DiagnosticsDatabase = IDBPDatabase<DiagnosticsSchema>;

/**
 * Opens the database. `onClosed` runs when the connection ends without the caller asking:
 * a newer schema made it close, or the browser dropped it. An open that another connection
 * blocks rejects instead of waiting, and its connection is closed if it opens later.
 */
export function openDiagnosticsDatabase(
  name: string,
  onClosed?: () => void,
): Promise<DiagnosticsDatabase> {
  return new Promise((resolve, reject) => {
    let rejected = false;
    const connect = async () => {
      let database: DiagnosticsDatabase;
      try {
        database = await openDB<DiagnosticsSchema>(name, DIAGNOSTICS_DATABASE_VERSION, {
          upgrade(upgrading) {
            upgrading.createObjectStore(META_STORE);
            const entries = upgrading.createObjectStore(ENTRIES_STORE, { autoIncrement: true });
            entries.createIndex(TIME_INDEX, "time");
            entries.createIndex(LEVEL_INDEX, ["level", "time"]);
          },
          // idb reports a blocked open but keeps waiting for it; this opener fails closed.
          blocked() {
            rejected = true;
            reject(new Error("storage-failed"));
          },
        });
      } catch (error) {
        reject(error);
        return;
      }
      if (rejected) {
        database.close();
        return;
      }
      // A newer schema must never wait on this connection.
      database.addEventListener("versionchange", () => {
        database.close();
        onClosed?.();
      });
      database.addEventListener("close", () => onClosed?.());
      resolve(database);
    };
    void connect();
  });
}
