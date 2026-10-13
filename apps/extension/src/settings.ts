import {
  createSettingsStore,
  DUMMY_VAULT_CATALOG,
  type SettingsStorage,
  type VaultCatalog,
  type SettingsSnapshot,
} from "@pateat/contracts";
import { restrictLocalStorage, trustedRecord } from "./storage";

/** The `storage.local` key of the worker-owned settings snapshot. */
export const SETTINGS_STORAGE_KEY = "pateat.local-settings.v1";

/** Metadata providers expose no secrets here; future operations own separate capability checks. */
export interface MetadataProvider {
  readonly catalog: VaultCatalog | ((snapshot: SettingsSnapshot) => Promise<VaultCatalog>);
  readonly initialCatalog?: VaultCatalog;
}

export const dummyMetadataProvider: MetadataProvider = { catalog: DUMMY_VAULT_CATALOG };

export function createLocalSettingsRuntime(provider: MetadataProvider = dummyMetadataProvider) {
  // Restrict even an empty store on worker startup, before options are opened.
  void restrictLocalStorage().catch(() => undefined);
  const storage: SettingsStorage = trustedRecord(SETTINGS_STORAGE_KEY);
  return createSettingsStore(storage, provider.catalog, provider.initialCatalog);
}
