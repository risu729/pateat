import type * as Sdk from "@bitwarden/sdk-internal";
import type * as v from "valibot";
import type { BitwardenProfile } from "./environment";
import type { BitwardenResult } from "./errors";
import type { encryptedCatalogContextSchema } from "./local-crypto";
import type { BitwardenUriMatchContext } from "./uri";

export type BitwardenAccountBinding =
  | { kind: "bootstrap"; email: string }
  | {
      kind: "known";
      profile: BitwardenProfile;
      email: string;
      userId: string;
      accountVersion: "v1" | "v2";
      /** Previously verified by local crypto, never read from unsigned profile metadata. */
      minimumSecurityVersion: 1 | 2;
    };
export type PreparedBitwardenAccount = {
  binding: {
    profile: BitwardenProfile;
    userId: string;
    email: string;
    accountVersion: "v1" | "v2";
  };
  accountCryptographicState: Sdk.WrappedAccountCryptographicState;
  /** This local-only session context uses the UNLOCK KDF, not the authentication prelogin KDF. */
  kdf: Sdk.Kdf;
  masterPasswordUnlock: Sdk.MasterPasswordUnlockData;
  organizationKeys: { organizationId: string; key: string }[];
  ciphers: Sdk.Cipher[];
  unavailableItems: { itemId: string; reason: "unsupported-cipher-type" }[];
  minimumSecurityVersion: 1 | 2;
  coverage: "received-envelope";
  encryptedMetadata: v.InferOutput<typeof encryptedCatalogContextSchema>;
  /**
   * Always retained at acceptance. Admission drops one that no longer readmits (for example
   * after an IDNA table change), and a record rewritten from that admitted copy, such as
   * when auto-unlock is disabled, keeps it absent; URI matching then stays unavailable.
   */
  uriMatchContext?: BitwardenUriMatchContext;
};
export interface BitwardenAccountMapper {
  readonly profile: BitwardenProfile;
  /** Only call with results obtained by the trusted host's fixed provider transport.
   * JWT decoding correlates those responses; it performs no signature verification.
   * Success is preparation, not an unlocked account or usable/authoritative cache.
   */
  map(input: unknown): BitwardenResult<PreparedBitwardenAccount>;
}
