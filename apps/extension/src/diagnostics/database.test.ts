import { deleteDB, openDB } from "idb";
import { describe, expect, it, vi } from "vitest";
import {
  DIAGNOSTICS_DATABASE_VERSION,
  ENTRIES_STORE,
  META_STORE,
  openDiagnosticsDatabase,
} from "./database";

// Runs in Chromium (vitest browser mode) for IndexedDB.
const uniqueName = () => `diagnostics-database-test-${crypto.randomUUID()}`;

describe("diagnostics database", () => {
  it("creates the stores and indexes", async () => {
    const name = uniqueName();
    const database = await openDiagnosticsDatabase(name);
    try {
      expect([...database.objectStoreNames].toSorted()).toEqual([ENTRIES_STORE, META_STORE]);
      const transaction = database.transaction(ENTRIES_STORE, "readonly");
      expect([...transaction.store.indexNames].toSorted()).toEqual(["level-time", "time"]);
      await transaction.done;
    } finally {
      database.close();
      await deleteDB(name);
    }
  });

  it("rejects an open that another connection blocks, and closes it once it opens", async () => {
    const name = uniqueName();
    // An older schema held open without yielding to the upgrade.
    const holder = await openDB(name, DIAGNOSTICS_DATABASE_VERSION - 1);
    try {
      await expect(openDiagnosticsDatabase(name)).rejects.toThrow("storage-failed");
    } finally {
      holder.close();
    }
    // The upgrade proceeds once the holder is gone. Deleting the database waits for every
    // connection to close, so it resolves only if the late connection was closed.
    await deleteDB(name);
  });

  it("closes for a newer schema and reports it", async () => {
    const name = uniqueName();
    const onClosed = vi.fn();
    const database = await openDiagnosticsDatabase(name, onClosed);
    const newer = await openDB(name, DIAGNOSTICS_DATABASE_VERSION + 1);
    try {
      expect(onClosed).toHaveBeenCalledOnce();
      expect(() => database.transaction(META_STORE, "readonly")).toThrow();
    } finally {
      newer.close();
      await deleteDB(name);
    }
  });
});
