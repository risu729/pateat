import * as v from "valibot";
import { decodeBase64 } from "@pateat/bitwarden";
import { storage } from "wxt/utils/storage";

/**
 * The user key of a vault unlocked in this browser session while a vault timeout other
 * than "Never" is set (ADR 0075). `storage.session` lives in memory only: Chrome drops it
 * when the browser restarts and when the extension is reloaded or updated, and by default
 * only extension pages and the service worker can read it, never content scripts.
 */
export type SessionKey = { revision: string; userKey: string };
export interface SessionKeyStore {
  read(): Promise<SessionKey | undefined>;
  write(value: SessionKey): Promise<void>;
  clear(): Promise<void>;
}

const sessionKeySchema = v.strictObject({
  /** The vault record revision this key unlocks; any other revision is locked. */
  revision: v.pipe(v.string(), v.uuid()),
  userKey: v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(1_048_576),
    v.check((value) => decodeBase64(value) !== undefined),
  ),
});

/** A stored value that does not parse is no key: the vault stays locked. */
export function admitSessionKey(value: unknown): SessionKey | undefined {
  const parsed = v.safeParse(sessionKeySchema, value);
  return parsed.success ? parsed.output : undefined;
}

export function sessionKeyStorageKey(connectionId: string) {
  return `session:pateat.vault-key.v1.${connectionId}` as const;
}

export function createSessionKeyStore(connectionId: string): SessionKeyStore {
  const key = sessionKeyStorageKey(connectionId);
  return {
    async read() {
      return admitSessionKey(await storage.getItem(key));
    },
    async write(value) {
      await storage.setItem(key, value);
    },
    async clear() {
      await storage.removeItem(key);
    },
  };
}

/** A store that keeps nothing, for managers that only ever keep the key on disk. */
export function memorySessionKeyStore(): SessionKeyStore {
  let value: SessionKey | undefined;
  return {
    read: async () => (value ? { ...value } : undefined),
    write: async (next) => {
      value = { ...next };
    },
    clear: async () => {
      value = undefined;
    },
  };
}
