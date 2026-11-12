import { expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { matchBitwardenLoginUris } from "../../src/uri";
import { createLocalCryptoSession } from "../../src/local-crypto";
import {
  legacyCipher,
  uriCiphertexts,
  v1Email,
  v1Kdf,
  v1Password,
  v1PrivateKey,
  v1WrappedUserKey,
} from "../../src/__fixtures__/crypto";

export function registerAuthenticatedSdk() {
  it("uses the actual decrypted URI and mode without network discovery", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("Synthetic URI test prohibits network"));
    try {
      const initialized = await createLocalCryptoSession(
        {
          connectionId: "synthetic-uri",
          userId: "00000000-0000-0000-0000-000000000001",
          email: v1Email,
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
      expect(initialized.ok).toBe(true);
      if (!initialized.ok) return;
      try {
        const original = legacyCipher();
        const decrypted = await initialized.data.decryptCipher({
          connectionId: "synthetic-uri",
          cipher: {
            ...original,
            login: {
              ...original.login,
              uris: [{ uri: uriCiphertexts.uri, match: 3, uriChecksum: uriCiphertexts.checksum }],
            },
          },
        });
        expect(decrypted.ok).toBe(true);
        if (!decrypted.ok) return;
        expect(
          matchBitwardenLoginUris(
            decrypted.data.login?.uris,
            "https://synthetic.example.test/login",
          ),
        ).toMatchObject({
          ok: true,
          data: {
            matched: true,
            targetOrigin: "https://synthetic.example.test",
            matches: [{ uriIndex: 0, match: 3 }],
          },
        });
        expect(
          matchBitwardenLoginUris(
            decrypted.data.login?.uris,
            "https://synthetic.example.test/login?other=1",
          ),
        ).toMatchObject({ ok: true, data: { matched: false } });
      } finally {
        initialized.data.dispose();
      }
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
}
