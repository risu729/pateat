// Stable per-device pseudonyms for identifiers shown in diagnostics (ADR 0019). The HMAC
// key never leaves this device's IndexedDB and is not extractable.
import { DIAGNOSTICS_DATABASE_NAME, META_STORE, openDiagnosticsDatabase } from "./database";

const KEY_ID = "pseudonym-key";

function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256", length: 256 }, false, ["sign"]);
}

/** Reads the stored key, or stores a new one; a concurrent first use keeps the first write. */
async function storedKey(name: string): Promise<CryptoKey> {
  // Generated before the transaction: an await on WebCrypto would let it auto-commit.
  const candidate = await generateKey();
  const database = await openDiagnosticsDatabase(name);
  try {
    const transaction = database.transaction(META_STORE, "readwrite");
    const [key] = await Promise.all([
      (async () => {
        const existing = await transaction.store.get(KEY_ID);
        if (existing instanceof CryptoKey) return existing;
        await transaction.store.put(candidate, KEY_ID);
        return candidate;
      })(),
      transaction.done,
    ]);
    return key;
  } finally {
    database.close();
  }
}

/** Replaces the stored key, so earlier pseudonyms cannot be linked to later ones. */
async function replaceKey(name: string): Promise<CryptoKey> {
  const key = await generateKey();
  const database = await openDiagnosticsDatabase(name);
  try {
    await database.put(META_STORE, key, KEY_ID);
    return key;
  } finally {
    database.close();
  }
}

export type Pseudonyms = ((kind: string, value: string, hexLength: number) => Promise<string>) & {
  /** Starts a new key; clearing the logs uses it. Rejects if the new key was not stored. */
  rotate(): Promise<void>;
};

/**
 * HMAC-SHA-256 of `kind` and `value`, as the first `hexLength` hex digits. If storage is
 * unavailable, a key for this worker's lifetime keeps the page working; its pseudonyms then
 * differ from the next worker's.
 */
export function createPseudonyms(options: { databaseName?: string } = {}): Pseudonyms {
  const name = options.databaseName ?? DIAGNOSTICS_DATABASE_NAME;
  let key: Promise<CryptoKey> | undefined;
  const pseudonym = async (kind: string, value: string, hexLength: number) => {
    key ??= storedKey(name).catch(() => generateKey());
    const mac = await crypto.subtle.sign(
      "HMAC",
      await key,
      new TextEncoder().encode(`${kind}\u0000${value}`),
    );
    return new Uint8Array(mac).toHex().slice(0, hexLength);
  };
  return Object.assign(pseudonym, {
    async rotate() {
      const replaced = replaceKey(name);
      key = replaced.catch(() => generateKey());
      // The caller learns that the old stored key could not be replaced.
      await replaced;
    },
  });
}
