import { createBitwardenAccountMapper } from "../../../../packages/bitwarden/src/account";
import { parsePasswordTokenOutcome } from "../../../../packages/bitwarden/src/auth-models";
import {
  createLocalCryptoSession,
  type LocalCryptoSdk,
} from "../../../../packages/bitwarden/src/local-crypto";
import {
  accountNow,
  accountProfile,
  rawV1Account,
  rawV2Account,
} from "../../../../packages/bitwarden/src/__fixtures__/account";
import { v1Email, v1Password } from "../../../../packages/bitwarden/src/__fixtures__/crypto";

/** Raw synthetic provider DTOs through mapping and real WASM password unlock. */
export async function mappedAccountVectors(sdk: LocalCryptoSdk) {
  async function check(raw: { token: unknown; sync: unknown }, version: "v1" | "v2") {
    const authenticated = parsePasswordTokenOutcome(raw.token, 200);
    if (authenticated?.kind !== "authenticated") return false;
    const mapper = createBitwardenAccountMapper(
      accountProfile,
      { kind: "bootstrap", email: v1Email },
      { nowSeconds: () => accountNow },
    );
    if (!mapper.ok) return false;
    const prepared = mapper.data.map({
      connectionId: accountProfile.connectionId,
      authenticated,
      sync: raw.sync,
    });
    if (!prepared.ok || prepared.data.unavailableItems.length !== 0) return false;
    const account = prepared.data;
    const opened = await createLocalCryptoSession(
      {
        connectionId: account.binding.profile.connectionId,
        userId: account.binding.userId,
        email: account.binding.email,
        kdf: account.kdf,
        accountCryptographicState: account.accountCryptographicState,
        organizationKeys: account.organizationKeys,
        minimumSecurityVersion: account.minimumSecurityVersion,
        unlock: {
          kind: "password",
          password: v1Password,
          masterPasswordUnlock: account.masterPasswordUnlock,
        },
      },
      sdk,
    );
    if (!opened.ok) return false;
    try {
      if (opened.data.metadata.accountVersion !== version || account.ciphers.length !== 1)
        return false;
      const decrypted = await opened.data.decryptCipher({
        connectionId: accountProfile.connectionId,
        cipher: account.ciphers[0],
      });
      if (!decrypted.ok) return false;
      return version === "v1"
        ? decrypted.data.name === "My test login" &&
            decrypted.data.login?.username === "test_username" &&
            decrypted.data.login?.password === "test_password"
        : opened.data.metadata.securityVersion === 2 &&
            decrypted.data.name === "Test Cipher" &&
            decrypted.data.notes === "Some notes" &&
            decrypted.data.secureNote?.type === 0;
    } finally {
      opened.data.dispose();
    }
  }
  return {
    mappedV1Login: await check(rawV1Account(), "v1"),
    mappedV2Blob: await check(rawV2Account(), "v2"),
  };
}
