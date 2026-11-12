import type { UriTestBindings } from "../../src/uri.test";

export function registerDestinationGrant({
  expect,
  it,
  matchBitwardenLoginUris,
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  resolveSiteAccount,
}: UriTestBindings) {
  it.each([
    { uri: "https://bank.example", match: 2, target: "https://bank.example.evil.test/login" },
    { uri: "https://bank.example", match: 0, target: "http://bank.example/login" },
    { uri: "https://bank.example", match: 0, target: "https://bank.example:8443/login" },
  ])(
    "a permissive provider match cannot change the allowed origin case %#",
    ({ uri, match, target: targetUrl }) => {
      expect(matchBitwardenLoginUris([{ uri, match }], targetUrl)).toMatchObject({
        ok: true,
        data: { matched: true },
      });
      const settings = createDefaultSettings();
      // Even an explicit site selection cannot expand this item's allowed origin.
      settings.siteDefaults.push({
        origin: new URL(targetUrl).origin,
        provider: "dummy",
        server: "cloud-us",
        userId: "demo-personal-account",
        itemId: "primary",
      });
      expect(resolveSiteAccount(settings, DUMMY_VAULT_CATALOG, targetUrl)).toEqual({
        ok: false,
        reason: "item-origin-mismatch",
      });
    },
  );
}

export function registerAuthenticatedSdk({
  expect,
  it,
  vi,
  createLocalCryptoSession,
  sdk,
  legacyCipher,
  uriCiphertexts,
  v1Email,
  v1Kdf,
  v1Password,
  v1PrivateKey,
  v1WrappedUserKey,
  matchBitwardenLoginUris,
}: UriTestBindings) {
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
