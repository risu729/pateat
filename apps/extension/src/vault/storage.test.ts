import { afterEach, describe, expect, it, vi } from "vitest";
import { accountProfile } from "../../../../packages/bitwarden/src/__fixtures__/account";
import { activeEntry, disabledEntry } from "./__fixtures__/vault";
import { createIndexedDbVaultStore, type DurableVaultStore } from "./storage";

// Lifecycle-only fake. Atomic rollback/CAS across independent database connections
// is tested separately in actual Chromium; these tests control native callbacks.
function nativeCallbacks(options: { profile?: typeof accountProfile; timeoutMs?: number } = {}) {
  const requests: { result?: unknown; onsuccess?: (() => void) | null }[] = [];
  const objectStore = {
    get: vi.fn(() => {
      const request = {} as (typeof requests)[number];
      requests.push(request);
      return request;
    }),
    put: vi.fn(),
  };
  const tx = {
    oncomplete: undefined as (() => void) | undefined,
    onabort: undefined as (() => void) | undefined,
    onerror: undefined as (() => void) | undefined,
    error: null as DOMException | null,
    objectStore: vi.fn(() => objectStore),
    abort: vi.fn(),
  };
  const database = {
    transaction: vi.fn(() => tx),
    close: vi.fn(),
    objectStoreNames: { contains: () => true },
    createObjectStore: vi.fn(),
    onversionchange: undefined,
  };
  const opening = { result: database, onsuccess: undefined as (() => void) | undefined };
  const factory = { open: vi.fn(() => opening) };
  const store = createIndexedDbVaultStore({
    profile: options.profile ?? accountProfile,
    indexedDB: factory as unknown as IDBFactory,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  stores.push(store);
  const ready = async () => {
    await vi.waitFor(() => expect(opening.onsuccess).toBeTypeOf("function"));
    opening.onsuccess!();
    await vi.waitFor(() => expect(requests).toHaveLength(1));
  };
  const respond = (index: number, value: unknown) => {
    requests[index]!.result = value;
    requests[index]!.onsuccess!();
  };
  return { store, ready, respond, tx, objectStore, database, factory, requests };
}
const stores: DurableVaultStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  vi.restoreAllMocks();
});

describe("native transaction completion controls publication", () => {
  it("withholds CAS success after readback onsuccess until transaction oncomplete", async () => {
    const h = nativeCallbacks();
    const next = activeEntry();
    const pending = h.store.compareAndSwap(null, next);
    const settled = vi.fn();
    void pending.then(settled);
    await h.ready();
    h.respond(0, undefined);
    expect(h.objectStore.put).toHaveBeenCalledWith(next, accountProfile.connectionId);
    h.respond(1, structuredClone(next));
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    expect(h.database.transaction).toHaveBeenCalledWith("records", "readwrite", {
      durability: "strict",
    });
    h.tx.oncomplete!();
    expect(await pending).toEqual({ ok: true, data: { revision: next.revision } });
  });

  it("withholds a read result until its readonly transaction completes", async () => {
    const h = nativeCallbacks();
    const next = disabledEntry(false);
    const pending = h.store.read();
    const settled = vi.fn();
    void pending.then(settled);
    await h.ready();
    h.respond(0, next);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    h.tx.oncomplete!();
    expect(await pending).toEqual({ ok: true, data: next });
  });

  it.each([null, "50000000-0000-4000-8000-000000000001"])(
    "rejects stale expected revision %s before put when a disabled tombstone exists",
    async (expected) => {
      const h = nativeCallbacks();
      const pending = h.store.compareAndSwap(expected, activeEntry());
      await h.ready();
      h.respond(0, disabledEntry(false));
      expect(h.objectStore.put).not.toHaveBeenCalled();
      expect(h.tx.abort).toHaveBeenCalledOnce();
      h.tx.onabort!();
      expect(await pending).toEqual({ ok: false, error: { code: "storage-conflict" } });
    },
  );

  it("rejects changed readback key bytes even if its revision matches", async () => {
    const h = nativeCallbacks();
    const next = activeEntry();
    const pending = h.store.compareAndSwap(null, next);
    await h.ready();
    h.respond(0, undefined);
    h.respond(1, { ...next, userKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
    expect(h.tx.abort).toHaveBeenCalledOnce();
    h.tx.onabort!();
    expect(await pending).toEqual({ ok: false, error: { code: "storage-uncertain" } });
  });

  it("rejects malformed existing state rather than overwriting it as empty", async () => {
    const h = nativeCallbacks();
    const pending = h.store.compareAndSwap(null, activeEntry());
    await h.ready();
    h.respond(0, { state: "active", revision: "broken" });
    expect(h.objectStore.put).not.toHaveBeenCalled();
    h.tx.onabort!();
    expect(await pending).toEqual({ ok: false, error: { code: "invalid-cache-record" } });
  });

  it("returns quota failure for an aborted native transaction, not its earlier successful request", async () => {
    const h = nativeCallbacks();
    const next = activeEntry();
    const pending = h.store.compareAndSwap(null, next);
    await h.ready();
    h.respond(0, undefined);
    h.respond(1, next);
    h.tx.error = new DOMException("Synthetic quota", "QuotaExceededError");
    h.tx.onabort!();
    expect(await pending).toEqual({ ok: false, error: { code: "cache-quota-exceeded" } });
  });

  it("aborts cancelled in-flight work and never returns successful readback", async () => {
    const h = nativeCallbacks();
    const abort = new AbortController();
    const next = activeEntry();
    const pending = h.store.compareAndSwap(null, next, abort.signal);
    await h.ready();
    h.respond(0, undefined);
    h.respond(1, next);
    abort.abort();
    expect(h.tx.abort).toHaveBeenCalledOnce();
    h.tx.onabort!();
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
    h.respond(0, undefined);
    expect(h.objectStore.get).toHaveBeenCalledWith(accountProfile.connectionId);
    expect(h.objectStore.put).toHaveBeenCalledWith(next, accountProfile.connectionId);
    h.respond(1, next);
    h.tx.oncomplete!();
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
    h.respond(0, undefined);
    h.respond(1, next);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledOnce(), { timeout: 200, interval: 5 });
    expect(await pending).toEqual({ ok: false, error: { code: "storage-uncertain" } });
    h.tx.oncomplete!();
    await Promise.resolve();
    expect(settled).toHaveBeenCalledExactlyOnceWith({
      ok: false,
      error: { code: "storage-uncertain" },
    });
  });
});
