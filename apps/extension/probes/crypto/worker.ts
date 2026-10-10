import { createLocalCryptoSession } from "../../../../packages/bitwarden/src/local-crypto";
import { loadBrowserCryptoSdk } from "../../../../packages/bitwarden/src/browser-sdk";
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

// The SDK's Error log level still logs errors and panic details. This dedicated
// synthetic host emits only boolean evidence, never raw SDK errors or values.
for (const method of ["log", "info", "warn", "error", "debug", "trace"] as const)
  console[method] = () => {};
let busy = false;
self.onmessage = async (event: MessageEvent<unknown>) => {
  if (busy || !event.data || typeof event.data !== "object") return;
  const request = event.data as { id?: unknown; operation?: unknown };
  if (
    typeof request.id !== "string" ||
    request.id.length > 64 ||
    (request.operation !== "vectors" && request.operation !== "kdf")
  )
    return;
  busy = true;
  const id = request.id;
  try {
    const sdk = await loadBrowserCryptoSdk();
    // The only permitted fetch was the packaged same-extension WASM above.
    globalThis.fetch = () => Promise.reject(new Error("Network disabled in crypto host"));
    sdk.init_sdk(sdk.LogLevel.Error, sdk.LogLevel.Error, 0);
    self.postMessage({ id, type: "started" });
    const encode = (value: string) => new TextEncoder().encode(value);
    if (request.operation === "kdf") {
      const value = sdk.PureCrypto.derive_kdf_material(encode(kdfPassword), encode(kdfSalt), {
        argon2id: { iterations: 20, memory: 128, parallelism: 2 },
      });
      value.fill(0);
      self.postMessage({ id, type: "complete", results: { finished: true } });
      return;
    }
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
    try {
      const cipher = legacyCipher();
      const decrypted = await first.data.decryptCipher({ connectionId: base.connectionId, cipher });
      loginMatches =
        decrypted.ok &&
        decrypted.data.name === "My test login" &&
        decrypted.data.login?.username === "test_username" &&
        decrypted.data.login?.password === "test_password";
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
    const checks = {
      pbkdf2: pbkdf.every((value, index) => value === pbkdf2Expected[index]),
      argon2id: argon.every((value, index) => value === argon2Expected[index]),
      loginMatches,
      corruptionRejected,
      v2Verified,
    };
    pbkdf.fill(0);
    argon.fill(0);
    self.postMessage({ id, type: "complete", results: checks });
  } catch {
    self.postMessage({ id, type: "failed" });
  }
};
