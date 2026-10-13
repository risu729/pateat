import { browser } from "wxt/browser";
import { storage, type WxtStorageItem } from "wxt/utils/storage";

let access: Promise<void> | undefined;

/**
 * Restricts `storage.local` to trusted extension contexts. Every Pateat read and write of
 * it waits for this, and items are defined only after it. Fails closed on unsupported APIs
 * or a rejected change, and is retried on a later call.
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
 * A WXT storage item in `storage.local`, defined on first use after the access level is
 * restricted. Callers validate what `read` returns.
 */
export function trustedRecord<T>(key: string): TrustedRecord<T> {
  let item: WxtStorageItem<T | null, {}> | undefined;
  const ready = async () => {
    await restrictLocalStorage();
    return (item ??= storage.defineItem<T>(`local:${key}`));
  };
  return {
    async read() {
      return (await (await ready()).getValue()) ?? undefined;
    },
    async write(value) {
      await (await ready()).setValue(value);
    },
    async clear() {
      await (await ready()).removeValue();
    },
  };
}
