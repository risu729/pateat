import type { CryptoHost } from "../crypto/host";
import type { SsoCryptoHost } from "./sso";

/** The crypto host operations the local vault manager calls. */
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
