import { kdfPassword, kdfSalt } from "../../../../packages/bitwarden/src/__fixtures__/crypto";
import { initializeSyntheticCryptoHost } from "./host";

// A fixed workload used only to measure hard cancellation by Worker termination.
void (async () => {
  try {
    const sdk = await initializeSyntheticCryptoHost();
    self.postMessage({ type: "started" });
    const encode = (value: string) => new TextEncoder().encode(value);
    const value = sdk.PureCrypto.derive_kdf_material(encode(kdfPassword), encode(kdfSalt), {
      argon2id: { iterations: 20, memory: 128, parallelism: 2 },
    });
    value.fill(0);
    self.postMessage({ type: "complete", results: { finished: true } });
  } catch {
    self.postMessage({ type: "failed" });
  }
})();
