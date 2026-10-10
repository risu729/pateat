import { createLocalCryptoSession } from "../../../../packages/bitwarden/src/local-crypto";
import { initializeSyntheticCryptoHost } from "./host";
import { mappedAccountVectors } from "./account-vectors";
import { localFieldVectors } from "./field-vectors";
import { derivePasswordAuthentication } from "../../../../packages/bitwarden/src/auth-crypto";
import {
  authPassword,
  pbkdf2Auth,
  argon2Auth,
} from "../../../../packages/bitwarden/src/__fixtures__/auth";
import {
  argon2Expected,
  kdfPassword,
  kdfSalt,
  pbkdf2Expected,
  legacyCipher,
  v1Email,
  v1Kdf,
  v1Password,
  v1PrivateKey,
  v1WrappedUserKey,
  v2Kdf,
  V2_DECRYPTED_USER_KEY,
  V2_PRIVATE_KEY,
  V2_SECURITY_STATE,
  V2_SIGNED_PUBLIC_KEY,
  V2_SIGNING_KEY,
} from "../../../../packages/bitwarden/src/__fixtures__/crypto";

// One fixed synthetic job per Worker. No message or page data selects credentials
// or controls a cryptographic operation inside this host.
void (async () => {
  try {
    const sdk = await initializeSyntheticCryptoHost();
    self.postMessage({ type: "started" });
    const encode = (value: string) => new TextEncoder().encode(value);
    const pbkdf = sdk.PureCrypto.derive_kdf_material(encode(kdfPassword), encode(kdfSalt), {
      pBKDF2: { iterations: 10_000 },
    });
    const argon = sdk.PureCrypto.derive_kdf_material(encode(kdfPassword), encode(kdfSalt), {
      argon2id: { iterations: 4, memory: 32, parallelism: 2 },
    });
    const base = {
      connectionId: "synthetic-browser",
      userId: "00000000-0000-0000-0000-000000000000",
      email: v1Email,
    };
    const first = await createLocalCryptoSession(
      {
        ...base,
        kdf: v1Kdf,
        accountCryptographicState: { V1: { private_key: v1PrivateKey } },
        unlock: {
          kind: "password",
          password: v1Password,
          masterPasswordUnlock: {
            kdf: v1Kdf,
            masterKeyWrappedUserKey: v1WrappedUserKey,
            salt: v1Email,
          },
        },
      },
      sdk,
    );
    if (!first.ok) throw new Error("Synthetic initialization failed");
    let loginMatches = false;
    let corruptionRejected = false;
    let fieldChecks = { localFields: false, localTotp: false, localSteam: false };
    try {
      const cipher = legacyCipher();
      const decrypted = await first.data.decryptCipher({ connectionId: base.connectionId, cipher });
      loginMatches =
        decrypted.ok &&
        decrypted.data.name === "My test login" &&
        decrypted.data.login?.username === "test_username" &&
        decrypted.data.login?.password === "test_password";
      if (decrypted.ok) fieldChecks = localFieldVectors(decrypted.data);
      const corrupt = { ...cipher, name: cipher.name.replace("JOw", "KOw") };
      const result = await first.data.decryptCipher({
        connectionId: base.connectionId,
        cipher: corrupt,
      });
      corruptionRejected = !result.ok;
    } finally {
      first.data.dispose();
    }
    const second = await createLocalCryptoSession(
      {
        ...base,
        kdf: v2Kdf,
        accountCryptographicState: {
          V2: {
            private_key: V2_PRIVATE_KEY,
            signing_key: V2_SIGNING_KEY,
            security_state: V2_SECURITY_STATE,
            signed_public_key: V2_SIGNED_PUBLIC_KEY,
          },
        },
        unlock: { kind: "decrypted-key", userKey: V2_DECRYPTED_USER_KEY },
      },
      sdk,
    );
    const v2Verified = second.ok && second.data.metadata.securityVersion === 2;
    if (second.ok) second.data.dispose();
    const authentication = await derivePasswordAuthentication(
      {
        connectionId: base.connectionId,
        email: pbkdf2Auth.salt,
        password: authPassword,
        prelogin: {
          mode: "legacy",
          response: { kdf: 0, kdfIterations: pbkdf2Auth.kdf.pBKDF2.iterations },
        },
      },
      sdk,
    );
    const argonAuthentication = await derivePasswordAuthentication(
      {
        connectionId: base.connectionId,
        email: pbkdf2Auth.salt,
        password: authPassword,
        prelogin: {
          mode: "password",
          response: {
            salt: argon2Auth.salt,
            kdfSettings: { kdfType: 1, ...argon2Auth.kdf.argon2id },
          },
        },
      },
      sdk,
    );
    const checks = {
      ...fieldChecks,
      ...(await mappedAccountVectors(sdk)),
      pbkdf2: pbkdf.every((value, index) => value === pbkdf2Expected[index]),
      argon2id: argon.every((value, index) => value === argon2Expected[index]),
      loginMatches,
      corruptionRejected,
      v2Verified,
      authPbkdf2:
        authentication.ok && authentication.data.masterPasswordHash === pbkdf2Auth.expected,
      authArgon2id:
        argonAuthentication.ok &&
        argonAuthentication.data.masterPasswordHash === argon2Auth.expected,
    };
    pbkdf.fill(0);
    argon.fill(0);
    self.postMessage({ type: "complete", results: checks });
  } catch {
    self.postMessage({ type: "failed" });
  }
})();
