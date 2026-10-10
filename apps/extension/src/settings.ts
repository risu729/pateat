import {
  createSettingsStore,
  DUMMY_VAULT_CATALOG,
  type SettingsStorage,
  type VaultCatalog,
  type SettingsSnapshot,
} from "@pateat/contracts";
import { browser } from "wxt/browser";

const STORAGE_KEY = "pateat.local-settings.v1";

/** Metadata providers expose no secrets here; future operations own separate capability checks. */
export interface MetadataProvider {
  readonly catalog: VaultCatalog | ((snapshot: SettingsSnapshot) => Promise<VaultCatalog>);
  readonly initialCatalog?: VaultCatalog;
}

export const dummyMetadataProvider: MetadataProvider = { catalog: DUMMY_VAULT_CATALOG };

export function createLocalSettingsRuntime(provider: MetadataProvider = dummyMetadataProvider) {
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
  // Restrict even an empty store on worker startup, before options are opened.
  void restrictAccess().catch(() => undefined);
  const storage: SettingsStorage = {
    async read() {
      await restrictAccess();
      const stored = await browser.storage.local.get(STORAGE_KEY);
      return stored[STORAGE_KEY];
    },
    async write(snapshot) {
      await restrictAccess();
      await browser.storage.local.set({ [STORAGE_KEY]: snapshot });
    },
  };
  return createSettingsStore(storage, provider.catalog, provider.initialCatalog);
}
