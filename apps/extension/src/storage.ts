import { browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";

let access: Promise<void> | undefined;

/**
 * Restricts `storage.local` to trusted extension contexts. Every trusted record waits for
 * this before it reads or writes. Fails closed on unsupported APIs or a
 * rejected change, and is retried on a later call.
 */
export function restrictLocalStorage(): Promise<void> {
  access ??= browser.storage.local
    .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
    .catch((error: unknown) => {
      access = undefined;
      throw error;
    });
  return access;
}

/** One `storage.local` record readable only by trusted extension contexts. */
export interface TrustedRecord<T> {
  /** The stored value, unvalidated; undefined when absent. */
  read(): Promise<unknown>;
  write(value: T): Promise<void>;
  clear(): Promise<void>;
}

/**
 * A `storage.local` record read and written through WXT storage once the access level is
 * restricted. Callers validate what `read` returns. Records use `getItem` rather than
 * `defineItem`, whose definition reads the value once without a catch.
 */
export function trustedRecord<T>(key: string): TrustedRecord<T> {
  const local = `local:${key}` as const;
  return {
    async read() {
      await restrictLocalStorage();
      return (await storage.getItem<T>(local)) ?? undefined;
    },
    async write(value) {
      await restrictLocalStorage();
      await storage.setItem(local, value);
    },
    async clear() {
      await restrictLocalStorage();
      await storage.removeItem(local);
    },
  };
}

/** One `storage.session` value; WXT reads a missing value as null and removes on null. */
export function sessionValue(key: `session:${string}`): {
  getValue(): Promise<unknown>;
  setValue(value: unknown): Promise<void>;
} {
  return {
    getValue: () => storage.getItem(key),
    setValue: (value) => storage.setItem(key, value),
  };
}
