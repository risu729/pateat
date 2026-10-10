import { browser } from "wxt/browser";
import type { ServiceStorage } from "./runtime";

const STORAGE_KEY = "pateat.sync-service.v1";

/** The service record holds a verifier or device credential: trusted contexts only. */
export function createBrowserServiceStorage(): ServiceStorage {
  let access: Promise<void> | undefined;
  function restrictAccess(): Promise<void> {
    // Fail closed on unsupported APIs or rejected access changes. Retry on a later request.
    access ??= browser.storage.local
      .setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
      .catch((error: unknown) => {
        access = undefined;
        throw error;
      });
    return access;
  }
  return {
    async read() {
      await restrictAccess();
      return (await browser.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    },
    async write(record) {
      await restrictAccess();
      await browser.storage.local.set({ [STORAGE_KEY]: record });
    },
    async clear() {
      await restrictAccess();
      await browser.storage.local.remove(STORAGE_KEY);
    },
  };
}
