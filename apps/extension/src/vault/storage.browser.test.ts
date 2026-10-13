import { deleteDB } from "idb";
import { afterEach, describe, expect, it } from "vitest";
import { accountProfile } from "../../../../packages/bitwarden/src/__fixtures__/account";
import { activeEntry, disabledEntry } from "./__fixtures__/vault";
import { createVaultDatabase, RECORDS_STORE, runVaultTransaction } from "./database";
import { vaultFailure } from "./record";
import { createIndexedDbVaultStore } from "./storage";

// Runs in Chromium (vitest browser mode): the transactions here are native, so atomicity,
// rollback and commit ordering are the browser's, not a fake's.
const open: { close(): void; databaseName: string }[] = [];
afterEach(async () => {
  const finished = open.splice(0);
  for (const entry of finished) entry.close();
  await Promise.all(finished.map((entry) => deleteDB(entry.databaseName)));
});

function setup(options: { timeoutMs?: number } = {}) {
  const databaseName = `vault-storage-test-${crypto.randomUUID()}`;
  const create = () => {
    const store = createIndexedDbVaultStore({ profile: accountProfile, databaseName, ...options });
    open.push({ close: () => store.close(), databaseName });
    return store;
  };
  return { databaseName, create };
}

describe("vault store on native IndexedDB", () => {
  it("reads nothing, then writes, reads back and removes the record", async () => {
    const store = setup().create();
    expect(await store.read()).toEqual({ ok: true, data: null });
    const next = activeEntry();
    expect(await store.compareAndSwap(null, next)).toEqual({
      ok: true,
      data: { revision: next.revision },
    });
    expect(await store.read()).toEqual({ ok: true, data: next });
    expect(await store.remove()).toEqual({ ok: true, data: true });
    expect(await store.read()).toEqual({ ok: true, data: null });
  });

  it("replaces a record only from its current revision", async () => {
    const store = setup().create();
    const first = activeEntry();
    await store.compareAndSwap(null, first);
    const second = { ...first, revision: "40000000-0000-4000-8000-000000000002" };
    expect(await store.compareAndSwap("50000000-0000-4000-8000-000000000001", second)).toEqual({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(await store.compareAndSwap(null, second)).toEqual({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(await store.read()).toEqual({ ok: true, data: first });
    expect(await store.compareAndSwap(first.revision, second)).toEqual({
      ok: true,
      data: { revision: second.revision },
    });
    expect(await store.read()).toEqual({ ok: true, data: second });
  });

  it("lets one of two connections win a race for the same revision", async () => {
    const { create } = setup();
    const left = create();
    const right = create();
    const results = await Promise.all([
      left.compareAndSwap(null, activeEntry()),
      right.compareAndSwap(null, {
        ...activeEntry(),
        revision: "40000000-0000-4000-8000-000000000002",
      }),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: "storage-conflict" } },
    ]);
  });

  it("reports a corrupt record rather than treating it as empty", async () => {
    const { create, databaseName } = setup();
    const store = create();
    const database = createVaultDatabase({ databaseName });
    open.push({ close: () => database.close(), databaseName });
    await runVaultTransaction(
      await database.open(),
      RECORDS_STORE,
      "readwrite",
      database.timeout,
      async (stores, set) => {
        await stores(RECORDS_STORE).put(
          { state: "active", revision: "broken" },
          accountProfile.connectionId,
        );
        set({ ok: true, data: true });
      },
    );
    expect(await store.read()).toEqual({ ok: false, error: { code: "invalid-cache-record" } });
    expect(await store.compareAndSwap(null, activeEntry())).toEqual({
      ok: false,
      error: { code: "invalid-cache-record" },
    });
    expect(await store.remove()).toEqual({ ok: true, data: true });
    expect(await store.read()).toEqual({ ok: true, data: null });
  });

  it("keeps a disabled tombstone from being replaced by a stale expectation", async () => {
    const store = setup().create();
    const tombstone = disabledEntry(false);
    await store.compareAndSwap(null, tombstone);
    expect(await store.compareAndSwap(null, activeEntry())).toEqual({
      ok: false,
      error: { code: "storage-conflict" },
    });
    expect(await store.read()).toEqual({ ok: true, data: tombstone });
  });
});

describe("vault transactions on native IndexedDB", () => {
  async function connection() {
    const databaseName = `vault-transaction-test-${crypto.randomUUID()}`;
    const database = createVaultDatabase({ databaseName, timeoutMs: 1000 });
    open.push({ close: () => database.close(), databaseName });
    return { database, db: await database.open() };
  }
  const read = (db: Awaited<ReturnType<typeof connection>>["db"]) => db.get(RECORDS_STORE, "key");

  it("publishes a result only after the commit", async () => {
    const { database, db } = await connection();
    const result = await runVaultTransaction<string>(
      db,
      RECORDS_STORE,
      "readwrite",
      database.timeout,
      async (stores, set) => {
        await stores(RECORDS_STORE).put("value", "key");
        set({ ok: true, data: "done" });
      },
    );
    expect(result).toEqual({ ok: true, data: "done" });
    expect(await read(db)).toBe("value");
  });

  it("rolls back every write when the work aborts", async () => {
    const { database, db } = await connection();
    const result = await runVaultTransaction<string>(
      db,
      RECORDS_STORE,
      "readwrite",
      database.timeout,
      async (stores, set, abort) => {
        await stores(RECORDS_STORE).put("value", "key");
        set({ ok: true, data: "done" });
        abort("storage-conflict");
      },
    );
    expect(result).toEqual(vaultFailure("storage-conflict"));
    expect(await read(db)).toBeUndefined();
  });

  it("maps a failed request to a storage failure and rolls back", async () => {
    const { database, db } = await connection();
    const result = await runVaultTransaction<string>(
      db,
      RECORDS_STORE,
      "readwrite",
      database.timeout,
      async (stores) => {
        await stores(RECORDS_STORE).put("value", "key");
        // `add` onto an existing key fails the request and aborts the transaction.
        await stores(RECORDS_STORE).add("again", "key");
      },
    );
    expect(result).toEqual(vaultFailure("storage-failed"));
    expect(await read(db)).toBeUndefined();
  });

  it("maps work that throws to a storage failure and rolls back", async () => {
    const { database, db } = await connection();
    const result = await runVaultTransaction<string>(
      db,
      RECORDS_STORE,
      "readwrite",
      database.timeout,
      async (stores) => {
        await stores(RECORDS_STORE).put("value", "key");
        throw new Error("synthetic");
      },
    );
    expect(result).toEqual(vaultFailure("storage-failed"));
    expect(await read(db)).toBeUndefined();
  });

  it("cancels in-flight work without committing it", async () => {
    const { database, db } = await connection();
    const controller = new AbortController();
    const result = await runVaultTransaction<string>(
      db,
      RECORDS_STORE,
      "readwrite",
      database.timeout,
      async (stores, set) => {
        const pending = stores(RECORDS_STORE).put("value", "key");
        controller.abort();
        await pending.catch(() => undefined);
        set({ ok: true, data: "done" });
      },
      controller.signal,
    );
    expect(result).toEqual(vaultFailure("cancelled"));
    expect(await read(db)).toBeUndefined();
  });

  it("refuses to start for a signal that is already aborted", async () => {
    const { database, db } = await connection();
    const result = await runVaultTransaction<string>(
      db,
      RECORDS_STORE,
      "readwrite",
      database.timeout,
      async () => {
        throw new Error("must not run");
      },
      AbortSignal.abort(),
    );
    expect(result).toEqual(vaultFailure("cancelled"));
  });

  it("fails closed as uncertain at the deadline", async () => {
    const { db } = await connection();
    const result = await runVaultTransaction<string>(
      db,
      RECORDS_STORE,
      "readwrite",
      20,
      async (stores, set) => {
        // A request that outlives the deadline: the transaction stays open on a timer-free
        // chain of reads until the deadline aborts it.
        for (let turn = 0; turn < 1_000_000; turn += 1) {
          // oxlint-disable-next-line no-await-in-loop -- one request at a time keeps it open
          await stores(RECORDS_STORE).get("missing");
        }
        set({ ok: true, data: "late" });
      },
    );
    expect(result).toEqual(vaultFailure("storage-uncertain"));
  });
});
