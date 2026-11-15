import { ssoManagerOperations } from "./sso";
import type { LocalVaultManagerOptions } from "./manager-types";
import { createVaultSession } from "./manager-session";
import { vaultSnapshotOperations } from "./manager-snapshots";
import { vaultKeyOperations } from "./manager-keys";
import { vaultCapabilities } from "./manager-capabilities";

export type { VaultCryptoHost } from "./crypto-host";
export function createLocalVaultManager(options: LocalVaultManagerOptions) {
  const context = createVaultSession(options);
  const snapshots = vaultSnapshotOperations(context);
  const keys = vaultKeyOperations(context);
  const capabilities = vaultCapabilities(context);
  return {
    generation: context.generation,
    accept: snapshots.accept,
    restore: snapshots.restore,
    disableAutoUnlock: keys.disableAutoUnlock,
    unlock: snapshots.unlock,
    lockVault: keys.lockVault,
    keepKey: keys.keepKey,
    /** The key that unlocks this record now, for a sync that opens the next snapshot. */
    keyFor: context.keyFor,
    lock: context.lock,
    remove: keys.remove,
    ...ssoManagerOperations(context.options.host, context.withLiveVault),
    listFields: capabilities.listFields,
    catalog: capabilities.catalog,
    matchUris: capabilities.matchUris,
    loginUsernames: capabilities.loginUsernames,
    findPasskeys: capabilities.findPasskeys,
    passkeyRpIds: capabilities.passkeyRpIds,
    signPasskey: capabilities.signPasskey,
    verifyMasterPassword: capabilities.verifyMasterPassword,
    resolveField: capabilities.resolveField,
    resolveFields: capabilities.resolveFields,
    status: context.status,
    dispose: context.dispose,
  };
}
export type LocalVaultManager = ReturnType<typeof createLocalVaultManager>;
