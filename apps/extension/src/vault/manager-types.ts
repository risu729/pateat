import type { BitwardenProfile } from "@pateat/bitwarden";
import type { CryptoHost } from "../crypto/host";
import type { DurableVaultStore } from "./storage";
import type { SessionKeyStore } from "./session-key";
import type { SsoCryptoHost } from "./sso";

export type VaultCryptoHost = SsoCryptoHost &
  Pick<
    CryptoHost,
    | "open"
    | "verifyReceivedCiphers"
    | "exportUnlockMaterial"
    | "lock"
    | "isOpen"
    | "listFields"
    | "resolveField"
    | "catalog"
    | "matchUris"
    | "loginUsernames"
    | "customFieldDigests"
    | "findPasskeys"
    | "passkeyRpIds"
    | "signPasskey"
    | "verifyMasterPassword"
  >;
export type LocalVaultHandle = {
  managerGeneration: string;
  handleId: string;
  connectionId: string;
  userId: string;
  recordId: string;
  snapshotId: string;
};
export type LocalVaultSummary = {
  connectionId: string;
  revision: string;
  autoUnlock: "enabled" | "disabled";
  recordId?: string;
  snapshotId?: string;
  userId?: string;
  accountVersion?: "v1" | "v2";
  securityVersion?: 1 | 2;
  coverage?: "received-envelope";
};
export type VaultCheckpoint = "before-write" | "after-write";
/**
 * Where an unlocked vault's key is kept (ADR 0075): `durable` in the vault record, so the
 * vault unlocks by itself after a browser restart (ADR 0006), or `session` in this browser
 * session's memory only, while a vault timeout other than "Never" is set.
 */
export type KeyRetention = "durable" | "session";
export type LocalVaultManagerOptions = {
  profile: BitwardenProfile;
  host: VaultCryptoHost;
  store: DurableVaultStore;
  randomId?: () => string;
  nowMs?: () => number;
  /** Synthetic probe only; no secrets or generic commands are exposed by checkpoints. */
  checkpoint?: (stage: VaultCheckpoint) => Promise<void>;
  /** Read at each write of a key; absent keeps the key on disk. */
  retention?: () => Promise<KeyRetention>;
  /** The key of a vault unlocked in this browser session; absent keeps it in this object. */
  sessionKey?: SessionKeyStore;
};
