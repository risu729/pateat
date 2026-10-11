// Stable per-device pseudonyms for identifiers shown in diagnostics (ADR 0019). The HMAC
// key never leaves this device's IndexedDB and is not extractable.
export const DIAGNOSTICS_DATABASE_NAME = "pateat.diagnostics.v1";
/** The only schema: one `meta` store for the pseudonym key. */
export const DIAGNOSTICS_DATABASE_VERSION = 1;
const META_STORE = "meta";
const KEY_ID = "pseudonym-key";

function request<T>(open: () => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const pending = open();
    pending.onsuccess = () => resolve(pending.result);
    pending.onerror = () => reject(new Error("storage-failed"));
  });
}

function openDatabase(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const opening = factory.open(name, DIAGNOSTICS_DATABASE_VERSION);
    opening.onupgradeneeded = () => {
      opening.result.createObjectStore(META_STORE);
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

function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
}

/** Reads the stored key, or stores a new one; a concurrent first use keeps the first write. */
async function storedKey(factory: IDBFactory, name: string): Promise<CryptoKey> {
  // Generated before the transaction: an await on WebCrypto would let it auto-commit.
  const candidate = await generateKey();
  const database = await openDatabase(factory, name);
  try {
    const transaction = database.transaction(META_STORE, "readwrite");
    const store = transaction.objectStore(META_STORE);
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(new Error("storage-failed"));
    });
    // A failed read below rejects first; the abort that follows must not go unhandled.
    done.catch(() => undefined);
    const existing = await request(() => store.get(KEY_ID));
    const key = existing instanceof CryptoKey ? existing : candidate;
    if (key === candidate) store.put(candidate, KEY_ID);
    await done;
    return key;
  } finally {
    database.close();
  }
}

export type Pseudonyms = (kind: string, value: string, hexLength: number) => Promise<string>;

/**
 * HMAC-SHA-256 of `kind` and `value`, as the first `hexLength` hex digits. If storage is
 * unavailable, a key for this worker's lifetime keeps the page working; its pseudonyms then
 * differ from the next worker's.
 */
export function createPseudonyms(
  options: { indexedDB?: IDBFactory; databaseName?: string } = {},
): Pseudonyms {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  const name = options.databaseName ?? DIAGNOSTICS_DATABASE_NAME;
  let key: Promise<CryptoKey> | undefined;
  return async (kind, value, hexLength) => {
    key ??= storedKey(factory, name).catch(() => generateKey());
    const mac = await crypto.subtle.sign(
      "HMAC",
      await key,
      new TextEncoder().encode(`${kind}\u0000${value}`),
    );
    return [...new Uint8Array(mac)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, hexLength);
  };
}
