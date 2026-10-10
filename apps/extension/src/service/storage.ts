import { browser } from "wxt/browser";
import type { ServiceStorage } from "./runtime";
import type { RecipeCacheStorage, RecipeScheduleStorage } from "./recipes";

/** One storage.local key readable only by trusted extension contexts. */
function trustedRecord<T>(key: string) {
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
    async read(): Promise<unknown> {
      await restrictAccess();
      return (await browser.storage.local.get(key))[key];
    },
    async write(record: T) {
      await restrictAccess();
      await browser.storage.local.set({ [key]: record });
    },
    async clear() {
      await restrictAccess();
      await browser.storage.local.remove(key);
    },
  };
}

/** The service record holds a verifier or device credential: trusted contexts only. */
export function createBrowserServiceStorage(): ServiceStorage {
  return trustedRecord("pateat.sync-service.v1");
}

/** Synced recipes are login policy; content scripts never read them directly. */
export function createBrowserRecipeCacheStorage(): RecipeCacheStorage {
  return trustedRecord("pateat.sync-recipes.v1");
}

/** When the next background recipe sync is due, kept across service worker restarts. */
export function createBrowserRecipeScheduleStorage(): RecipeScheduleStorage {
  return trustedRecord("pateat.sync-recipes-schedule.v1");
}
