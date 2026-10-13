import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { accountProfile } from "../../../../packages/bitwarden/src/__fixtures__/account";
import { activeEntry, disabledEntry } from "./__fixtures__/vault";
import { createIndexedDbVaultStore, type DurableVaultStore } from "./storage";

// idb recognizes IndexedDB objects with `instanceof` against these globals, which Node lacks.
// The fakes below extend EventTarget, as the native objects do, and are declared once because
// idb keeps the classes it first sees.
class FakeRequest extends EventTarget {
  result: unknown;
  error: DOMException | null = null;
}
class FakeTransaction extends EventTarget {
  error: DOMException | null = null;
  objectStore = vi.fn();
  abort = vi.fn();
  /** Delivers a native transaction event: `complete` or `abort`. */
  fire(type: "complete" | "abort") {
    this.dispatchEvent(new Event(type));
  }
}
class FakeDatabase extends EventTarget {
  transaction = vi.fn();
  close = vi.fn();
}
class FakeObjectStore {
  get = vi.fn();
  put = vi.fn();
  delete = vi.fn();
  count = vi.fn();
}
vi.stubGlobal("IDBRequest", FakeRequest);
vi.stubGlobal("IDBTransaction", FakeTransaction);
vi.stubGlobal("IDBDatabase", FakeDatabase);
vi.stubGlobal("IDBObjectStore", FakeObjectStore);
vi.stubGlobal("IDBIndex", class FakeIndex extends EventTarget {});
vi.stubGlobal("IDBCursor", class FakeCursor extends EventTarget {});
afterAll(() => {
  vi.unstubAllGlobals();
});

/** Lets promise continuations that follow a native callback run. */
async function settle() {
  let turns = Promise.resolve();
  for (let turn = 0; turn < 20; turn += 1) turns = turns.then(() => undefined);
  await turns;
}

// Lifecycle-only fake. Atomic rollback/CAS across independent database connections
// is tested separately in actual Chromium; these tests control native callbacks.
function nativeCallbacks(options: { profile?: typeof accountProfile; timeoutMs?: number } = {}) {
  const requests: FakeRequest[] = [];
  const pendingRequest = () => {
    const request = new FakeRequest();
    requests.push(request);
    return request;
  };
  const objectStore = new FakeObjectStore();
  objectStore.get.mockImplementation(pendingRequest);
  objectStore.count.mockImplementation(pendingRequest);
  const tx = new FakeTransaction();
  tx.objectStore.mockReturnValue(objectStore);
  const database = new FakeDatabase();
  database.transaction.mockReturnValue(tx);
  const opening = new FakeRequest();
  opening.result = database;
  const factory = { open: vi.fn(() => opening) };
  vi.stubGlobal("indexedDB", factory);
  const store = createIndexedDbVaultStore({
    profile: options.profile ?? accountProfile,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  stores.push(store);
  const ready = async () => {
    await vi.waitFor(() => expect(factory.open).toHaveBeenCalled());
    opening.dispatchEvent(new Event("success"));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
  };
  const respond = async (index: number, value: unknown) => {
    requests[index]!.result = value;
    requests[index]!.dispatchEvent(new Event("success"));
    await settle();
  };
  return { store, ready, respond, tx, objectStore, database, factory, requests };
}
const stores: DurableVaultStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

describe("connection record deletion", () => {
  it("deletes the record without admitting it and publishes only after readback and commit", async () => {
    const h = nativeCallbacks();
    const pending = h.store.remove();
    const settled = vi.fn();
    void pending.then(settled);
    await h.ready();
    expect(h.objectStore.delete).toHaveBeenCalledWith(accountProfile.connectionId);
    expect(h.objectStore.get).not.toHaveBeenCalled();
    await h.respond(0, 0);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(h.database.transaction).toHaveBeenCalledWith("records", "readwrite", {
      durability: "strict",
    });
    h.tx.fire("complete");
    expect(await pending).toEqual({ ok: true, data: true });
  });
  it("reports uncertainty when the record is still present after deletion", async () => {
    const h = nativeCallbacks();
    const pending = h.store.remove();
    await h.ready();
    await h.respond(0, 1);
    expect(h.tx.abort).toHaveBeenCalled();
    h.tx.fire("abort");
    expect(await pending).toEqual({ ok: false, error: { code: "storage-uncertain" } });
  });
  it("rejects an invalid profile before opening IndexedDB", async () => {
    const h = nativeCallbacks({
      profile: { ...accountProfile, connectionId: "" } as unknown as typeof accountProfile,
    });
    expect(await h.store.remove()).toEqual({ ok: false, error: { code: "invalid-profile" } });
    expect(h.factory.open).not.toHaveBeenCalled();
  });
});

describe("native transaction completion controls publication", () => {
  it("withholds CAS success after readback onsuccess until transaction oncomplete", async () => {
    const h = nativeCallbacks();
    const next = activeEntry();
    const pending = h.store.compareAndSwap(null, next);
    const settled = vi.fn();
    void pending.then(settled);
    await h.ready();
    await h.respond(0, undefined);
    expect(h.objectStore.put).toHaveBeenCalledWith(next, accountProfile.connectionId);
    await h.respond(1, structuredClone(next));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(h.database.transaction).toHaveBeenCalledWith("records", "readwrite", {
      durability: "strict",
    });
    h.tx.fire("complete");
    expect(await pending).toEqual({ ok: true, data: { revision: next.revision } });
  });

  it("withholds a read result until its readonly transaction completes", async () => {
    const h = nativeCallbacks();
    const next = disabledEntry(false);
    const pending = h.store.read();
    const settled = vi.fn();
    void pending.then(settled);
    await h.ready();
    await h.respond(0, next);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    h.tx.fire("complete");
    expect(await pending).toEqual({ ok: true, data: next });
  });

  it.each([null, "50000000-0000-4000-8000-000000000001"])(
    "rejects stale expected revision %s before put when a disabled tombstone exists",
    async (expected) => {
      const h = nativeCallbacks();
      const pending = h.store.compareAndSwap(expected, activeEntry());
      await h.ready();
      await h.respond(0, disabledEntry(false));
      expect(h.objectStore.put).not.toHaveBeenCalled();
      expect(h.tx.abort).toHaveBeenCalledOnce();
      h.tx.fire("abort");
      expect(await pending).toEqual({ ok: false, error: { code: "storage-conflict" } });
    },
  );

  it("rejects changed readback key bytes even if its revision matches", async () => {
    const h = nativeCallbacks();
    const next = activeEntry();
    const pending = h.store.compareAndSwap(null, next);
    await h.ready();
    await h.respond(0, undefined);
    await h.respond(1, { ...next, userKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    expect(h.tx.abort).toHaveBeenCalledOnce();
    h.tx.fire("abort");
    expect(await pending).toEqual({ ok: false, error: { code: "storage-uncertain" } });
  });

  it("rejects malformed existing state rather than overwriting it as empty", async () => {
    const h = nativeCallbacks();
    const pending = h.store.compareAndSwap(null, activeEntry());
    await h.ready();
    await h.respond(0, { state: "active", revision: "broken" });
    expect(h.objectStore.put).not.toHaveBeenCalled();
    h.tx.fire("abort");
    expect(await pending).toEqual({ ok: false, error: { code: "invalid-cache-record" } });
  });

  it("returns quota failure for an aborted native transaction, not its earlier successful request", async () => {
    const h = nativeCallbacks();
    const next = activeEntry();
    const pending = h.store.compareAndSwap(null, next);
    await h.ready();
    await h.respond(0, undefined);
    await h.respond(1, next);
    h.tx.error = new DOMException("Synthetic quota", "QuotaExceededError");
    h.tx.fire("abort");
    expect(await pending).toEqual({ ok: false, error: { code: "cache-quota-exceeded" } });
  });

  it("aborts cancelled in-flight work and never returns successful readback", async () => {
    const h = nativeCallbacks();
    const abort = new AbortController();
    const next = activeEntry();
    const pending = h.store.compareAndSwap(null, next, abort.signal);
    await h.ready();
    await h.respond(0, undefined);
    await h.respond(1, next);
    abort.abort();
    expect(h.tx.abort).toHaveBeenCalledOnce();
    h.tx.fire("abort");
    expect(await pending).toEqual({ ok: false, error: { code: "cancelled" } });
  });

  it("rejects a malformed candidate before opening IndexedDB", async () => {
    const h = nativeCallbacks();
    const bad = { ...disabledEntry(false), userKey: "unexpected" };
    expect(await h.store.compareAndSwap(null, bad)).toEqual({
      ok: false,
      error: { code: "invalid-cache-record" },
    });
    expect(h.factory.open).not.toHaveBeenCalled();
  });

  it("captures the canonical profile before a caller can retarget a pending open", async () => {
    const profile = structuredClone(accountProfile);
    const h = nativeCallbacks({ profile });
    const next = activeEntry();
    const pending = h.store.compareAndSwap(null, next);
    Object.assign(profile, {
      connectionId: "changed-connection",
      environment: { kind: "cloud", region: "eu" },
    });
    await h.ready();
    await h.respond(0, undefined);
    expect(h.objectStore.get).toHaveBeenCalledWith(accountProfile.connectionId);
    expect(h.objectStore.put).toHaveBeenCalledWith(next, accountProfile.connectionId);
    await h.respond(1, next);
    h.tx.fire("complete");
    expect(await pending).toEqual({ ok: true, data: { revision: next.revision } });
  });

  it("returns uncertainty promptly when deadline abort throws, ignoring late completion", async () => {
    const h = nativeCallbacks({ timeoutMs: 20 });
    h.tx.abort.mockImplementation(() => {
      throw new DOMException("Synthetic committed transaction", "InvalidStateError");
    });
    const next = activeEntry();
    const pending = h.store.compareAndSwap(null, next);
    const settled = vi.fn();
    void pending.then(settled);
    await h.ready();
    await h.respond(0, undefined);
    await h.respond(1, next);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 200, interval: 5 });
    expect(await pending).toEqual({ ok: false, error: { code: "storage-uncertain" } });
    h.tx.fire("complete");
    await Promise.resolve();
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      ok: false,
      error: { code: "storage-uncertain" },
    });
  });
});
