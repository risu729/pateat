import { expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { createLocalCryptoSession } from "../../src/local-crypto";
import { v1PrivateKey } from "../../src/__fixtures__/crypto";
import type { AccountInitializationContext } from "./context";

export function registerAccountInitializationTests({
  sessions,
  v1Input,
  v2Input,
  organizationInput,
  corrupt,
  securityStateWithVersion,
  verifiedAsRecordedSdk,
  session,
}: AccountInitializationContext) {
  it.each(
    (["security_state", "signed_public_key"] as const).flatMap((field) =>
      // Valid base64 with malformed COSE is not checked locally: it would strand the SDK's
      // Promise here, and in the extension only the host's Worker termination ends it.
      ["!not-base64", "AA"].map((value) => ({ field, value })),
    ),
  )(
    "rejects invalid or non-canonical base64 in signed V2 $field ($value) before async SDK initialization",
    async ({ field, value }) => {
      const input = v2Input();
      input.accountCryptographicState.V2[field] = value;
      const initialize = vi.spyOn(sdk.CryptoClient.prototype, "initialize_user_crypto");
      expect(await createLocalCryptoSession(input, sdk)).toEqual({
        ok: false,
        error: { code: "invalid-crypto-input" },
      });
      expect(initialize).not.toHaveBeenCalled();
    },
  );

  it.each(["!not-base64", "AA==", "gA=="])(
    "rejects malformed serialized decrypted user key %s before async SDK initialization",
    async (userKey) => {
      const input = v2Input();
      input.unlock.userKey = userKey;
      const initialize = vi.spyOn(sdk.CryptoClient.prototype, "initialize_user_crypto");
      expect(await createLocalCryptoSession(input, sdk)).toEqual({
        ok: false,
        error: { code: "invalid-crypto-input" },
      });
      expect(initialize).not.toHaveBeenCalled();
    },
  );

  it("rejects a wrong master password", async () => {
    const input = v1Input();
    input.unlock.password = "synthetic-wrong-password";
    expect(await createLocalCryptoSession(input, sdk)).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "master-password" },
    });
  });

  it("rejects a corrupt V1 private key despite SDK's lenient initialization", async () => {
    const input = v1Input();
    input.accountCryptographicState.V1.private_key = corrupt(v1PrivateKey);
    expect(await createLocalCryptoSession(input, sdk)).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "session-open" },
    });
  });

  it.each(["private_key", "signing_key", "security_state", "signed_public_key"] as const)(
    "rejects authenticated V2 %s tampering",
    async (field) => {
      const input = v2Input();
      input.accountCryptographicState.V2[field] = corrupt(
        input.accountCryptographicState.V2[field],
      );
      const result = await createLocalCryptoSession(input, sdk);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error).toEqual({ code: "crypto-failed", check: "session-open" });
    },
  );

  it("rejects a wrong V2 user key", async () => {
    const input = v2Input();
    input.unlock.userKey = corrupt(input.unlock.userKey);
    expect((await createLocalCryptoSession(input, sdk)).ok).toBe(false);
  });

  it("enforces the locally retained security floor", async () => {
    expect(
      await createLocalCryptoSession({ ...v1Input(), minimumSecurityVersion: 2 }, sdk),
    ).toEqual({ ok: false, error: { code: "security-downgrade" } });
  });

  it("exposes only the narrow verified unlock export without SDK networking or broad key APIs", async () => {
    const active = await session();
    expect(Object.keys(active).sort()).toEqual(
      [
        "decryptCipher",
        "decryptCatalogGroups",
        "decryptFido2Credentials",
        "decryptFido2PrivateKey",
        "dispose",
        "exportUnlockMaterial",
        "metadata",
        // Returns an encrypted copy and field paths, never a decrypted value.
        "repairCipher",
        // Answers only whether a password matches; it exports nothing.
        "verifyMasterPassword",
      ].sort(),
    );
  });

  it.each([0, 3, 23])("rejects unsupported verified security version %s", async (version) => {
    // This tests forward-version handling, not signed future-format interoperability.
    const input = v2Input();
    input.accountCryptographicState.V2.security_state = securityStateWithVersion(version);
    expect(await createLocalCryptoSession(input, verifiedAsRecordedSdk())).toEqual({
      ok: false,
      error: { code: "unsupported-crypto" },
    });
  });

  it("reads the version from the verified security state, not a constant", async () => {
    const input = v2Input();
    input.accountCryptographicState.V2.security_state = securityStateWithVersion(1);
    const created = await createLocalCryptoSession(input, verifiedAsRecordedSdk());
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    sessions.push(created.data);
    expect(created.data.metadata.securityVersion).toBe(1);
    expect(
      await createLocalCryptoSession(
        { ...input, minimumSecurityVersion: 2 },
        verifiedAsRecordedSdk(),
      ),
    ).toEqual({ ok: false, error: { code: "security-downgrade" } });
  });

  it("requires the signed public key of a V2 account", async () => {
    const input = v2Input();
    const { signed_public_key: _signedPublicKey, ...state } = input.accountCryptographicState.V2;
    const initialize = vi.spyOn(sdk.CryptoClient.prototype, "initialize_user_crypto");
    expect(
      await createLocalCryptoSession({ ...input, accountCryptographicState: { V2: state } }, sdk),
    ).toEqual({ ok: false, error: { code: "invalid-crypto-input" } });
    expect(initialize).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    [],
    { ...v1Input(), userId: "not-a-uuid" },
    { ...v1Input(), kdf: { unknown: { iterations: 600_000 } } },
    { ...v1Input(), upgradeToken: "unexpected-migration" },
  ])("rejects invalid or excessive crypto input before SDK use %#", async (input) => {
    const initialize = vi.fn();
    expect(await createLocalCryptoSession(input, { ...sdk, init_sdk: initialize })).toEqual({
      ok: false,
      error: { code: "invalid-crypto-input" },
    });
    expect(initialize).not.toHaveBeenCalled();
  });

  it.each([
    { ...v1Input(), kdf: { pBKDF2: { iterations: 2_000_001 } } },
    { ...v2Input(), kdf: { argon2id: { iterations: 21, memory: 32, parallelism: 4 } } },
    { ...v2Input(), kdf: { argon2id: { iterations: 6, memory: 1025, parallelism: 4 } } },
    { ...v2Input(), kdf: { argon2id: { iterations: 6, memory: 32, parallelism: 17 } } },
  ])("reports valid but excessive KDF configuration as a resource limit %#", async (input) => {
    const initialize = vi.fn();
    expect(await createLocalCryptoSession(input, { ...sdk, init_sdk: initialize })).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    expect(initialize).not.toHaveBeenCalled();
  });

  it("reports an excessive master-unlock KDF as a resource limit", async () => {
    const original = v1Input();
    const kdf = { argon2id: { iterations: 6, memory: 1025, parallelism: 4 } };
    const input = {
      ...original,
      kdf,
      unlock: {
        ...original.unlock,
        masterPasswordUnlock: { ...original.unlock.masterPasswordUnlock, kdf },
      },
    };
    const initialize = vi.fn();
    expect(await createLocalCryptoSession(input, { ...sdk, init_sdk: initialize })).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    expect(initialize).not.toHaveBeenCalled();
  });

  // Bitwarden lets users choose Argon2id memory up to 1024 MiB. The SDK's user-crypto
  // initialization is stubbed so no derivation of that size runs.
  it.each([257, 512, 1024])(
    "admits Argon2id memory %s MiB within Bitwarden's 1024 MiB range for password unlock",
    async (memory) => {
      const original = v1Input();
      const kdf = { argon2id: { iterations: 6, memory, parallelism: 4 } };
      const input = {
        ...original,
        kdf,
        unlock: {
          ...original.unlock,
          masterPasswordUnlock: { ...original.unlock.masterPasswordUnlock, kdf },
        },
      };
      const initializeSdk = vi.fn(sdk.init_sdk);
      const initializeUser = vi
        .spyOn(sdk.CryptoClient.prototype, "initialize_user_crypto")
        .mockRejectedValue(new Error("Stop after resource admission"));
      // The password is right; only the stopped initialization fails.
      vi.spyOn(sdk.PureCrypto, "decrypt_user_key_with_master_password").mockReturnValue(
        new Uint8Array(64),
      );
      expect(await createLocalCryptoSession(input, { ...sdk, init_sdk: initializeSdk })).toEqual({
        ok: false,
        error: { code: "crypto-failed", check: "session-open" },
      });
      expect(initializeSdk).toHaveBeenCalledTimes(1);
      expect(initializeUser).toHaveBeenCalledTimes(1);
      expect(initializeUser).toHaveBeenCalledWith(
        expect.objectContaining({
          kdfParams: kdf,
          method: expect.objectContaining({
            masterPasswordUnlock: expect.objectContaining({
              master_password_unlock: expect.objectContaining({ kdf }),
            }),
          }),
        }),
      );
    },
  );

  it("zeroes the user key it unwraps to tell a right password from a failed open", async () => {
    vi.spyOn(sdk.CryptoClient.prototype, "initialize_user_crypto").mockRejectedValue(
      new Error("Stop after resource admission"),
    );
    const unwrapped = new Uint8Array(64).fill(7);
    vi.spyOn(sdk.PureCrypto, "decrypt_user_key_with_master_password").mockReturnValue(unwrapped);
    expect(await createLocalCryptoSession(v1Input(), sdk)).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "session-open" },
    });
    expect(unwrapped.every((byte) => byte === 0)).toBe(true);
  });

  // Below the SDK's minimums every unwrap throws, so it says nothing of the password.
  it.each([
    { pBKDF2: { iterations: 4999 } },
    { argon2id: { iterations: 1, memory: 64, parallelism: 4 } },
    { argon2id: { iterations: 3, memory: 8, parallelism: 4 } },
  ])("does not call a password wrong for KDF settings below the SDK's minimums", async (kdf) => {
    const original = v1Input();
    const input = {
      ...original,
      kdf,
      unlock: {
        ...original.unlock,
        masterPasswordUnlock: { ...original.unlock.masterPasswordUnlock, kdf },
      },
    };
    vi.spyOn(sdk.CryptoClient.prototype, "initialize_user_crypto").mockRejectedValue(
      new Error("Refused below the minimums"),
    );
    const unwrap = vi.spyOn(sdk.PureCrypto, "decrypt_user_key_with_master_password");
    const result = await createLocalCryptoSession(input, sdk);
    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : result.error).not.toEqual(
      expect.objectContaining({ check: "master-password" }),
    );
    expect(unwrap).not.toHaveBeenCalled();
  });

  it("initializes a decrypted-key account whose Argon2id memory is 1024 MiB", async () => {
    // The decrypted-key path runs no KDF, so the real SDK completes initialization quickly.
    const input = {
      ...v2Input(),
      kdf: { argon2id: { iterations: 6, memory: 1024, parallelism: 4 } },
    };
    const created = await createLocalCryptoSession(input, sdk);
    if (!created.ok) expect.unreachable(`initialization failed with ${created.error.code}`);
    sessions.push(created.data);
  });

  it("rejects conflicting account and master-unlock KDFs before SDK use", async () => {
    const original = v1Input();
    const input = {
      ...original,
      unlock: {
        ...original.unlock,
        masterPasswordUnlock: {
          ...original.unlock.masterPasswordUnlock,
          kdf: { pBKDF2: { iterations: 600_000 } },
        },
      },
    };
    const initialize = vi.fn();
    expect(await createLocalCryptoSession(input, { ...sdk, init_sdk: initialize })).toEqual({
      ok: false,
      error: { code: "invalid-crypto-input" },
    });
    expect(initialize).not.toHaveBeenCalled();
  });

  it.each([
    "bad",
    "00000000-0000-0000-0000-000000000000",
    "a".repeat(31),
    "a".repeat(33),
    "g".repeat(32),
  ])(
    "rejects malformed contained key identifier %s before SDK initialization",
    async (containedKeyId) => {
      const original = v1Input();
      const input = {
        ...original,
        unlock: {
          ...original.unlock,
          masterPasswordUnlock: { ...original.unlock.masterPasswordUnlock, containedKeyId },
        },
      };
      const initializeSdk = vi.fn();
      const initializeUser = vi.spyOn(sdk.CryptoClient.prototype, "initialize_user_crypto");
      expect(await createLocalCryptoSession(input, { ...sdk, init_sdk: initializeSdk })).toEqual({
        ok: false,
        error: { code: "invalid-crypto-input" },
      });
      expect(initializeSdk).not.toHaveBeenCalled();
      expect(initializeUser).not.toHaveBeenCalled();
    },
  );

  it("admits a 32-hex contained key identifier and canonicalizes its case", async () => {
    const original = v1Input();
    const input = {
      ...original,
      unlock: {
        ...original.unlock,
        masterPasswordUnlock: {
          ...original.unlock.masterPasswordUnlock,
          containedKeyId: "00112233445566778899AABBCCDDEEFF",
        },
      },
    };
    // This proves admission/canonicalization only; this synthetic ID is not a fixture key ID.
    const initializeUser = vi
      .spyOn(sdk.CryptoClient.prototype, "initialize_user_crypto")
      .mockRejectedValue(new Error("Stop after supported-format admission"));
    expect(await createLocalCryptoSession(input, sdk)).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "session-open" },
    });
    expect(initializeUser).toHaveBeenCalledTimes(1);
    expect(initializeUser).toHaveBeenCalledWith(
      expect.objectContaining({
        method: expect.objectContaining({
          masterPasswordUnlock: expect.objectContaining({
            master_password_unlock: expect.objectContaining({
              containedKeyId: "00112233445566778899aabbccddeeff",
            }),
          }),
        }),
      }),
    );
  });

  it("rejects malformed organization ciphertext before the SDK's async deserializer", async () => {
    const input = organizationInput();
    input.organizationKeys[0]!.key = "malformed-no-encryption-prefix";
    const initialize = vi.fn();
    expect(await createLocalCryptoSession(input, { ...sdk, init_sdk: initialize })).toEqual({
      ok: false,
      error: { code: "unsupported-crypto" },
    });
    expect(initialize).not.toHaveBeenCalled();
  });

  it.each(["7.AA==", "7.gA==", "7.hA=="])(
    "rejects malformed organization COSE ciphertext %s before async organization initialization",
    async (key) => {
      const input = organizationInput();
      input.organizationKeys[0]!.key = key;
      const initializeUser = vi.spyOn(sdk.CryptoClient.prototype, "initialize_user_crypto");
      const initializeOrganization = vi.spyOn(sdk.CryptoClient.prototype, "initialize_org_crypto");
      // With no organization key that opens, the account's own key is the likelier fault.
      expect(await createLocalCryptoSession(input, sdk)).toEqual({
        ok: false,
        error: { code: "crypto-failed", check: "session-open" },
      });
      expect(initializeUser).toHaveBeenCalledTimes(1);
      expect(initializeOrganization).not.toHaveBeenCalled();
    },
  );

  it("rejects duplicate organization bindings before SDK initialization", async () => {
    const initialize = vi.fn();
    const organizationId = "11111111-1111-4111-8111-111111111111";
    expect(
      await createLocalCryptoSession(
        {
          ...v1Input(),
          organizationKeys: [
            { organizationId, key: "synthetic-first-key" },
            { organizationId, key: "synthetic-second-key" },
          ],
        },
        { ...sdk, init_sdk: initialize },
      ),
    ).toEqual({ ok: false, error: { code: "invalid-crypto-input" } });
    expect(initialize).not.toHaveBeenCalled();
  });

  it("sanitizes SDK failures without returning an exception or supplied secrets", async () => {
    const initialize = vi.fn(() => {
      throw new Error("synthetic-password http://secret.example.test synthetic-key");
    });
    expect(await createLocalCryptoSession(v1Input(), { ...sdk, init_sdk: initialize })).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "session-open" },
    });
  });
}
