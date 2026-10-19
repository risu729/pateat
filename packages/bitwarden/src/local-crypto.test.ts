import { afterEach, describe, expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { createLocalCryptoSession } from "./local-crypto";
import {
  blobPrivateKey,
  blobWrappingKey,
  customFieldCiphertexts,
  fidoCredential,
  fidoPrivateKey,
  legacyCipher,
  ORG_ACCOUNT_MASTER_KEY_WRAPPED_USER_KEY,
  ORG_ACCOUNT_PRIVATE_KEY,
  sealedBlob,
  TEST_ORGANIZATION_ID,
  TEST_ORGANIZATION_KEY,
  uriCiphertexts,
  v1Email,
  v1Kdf,
  v1Password,
  v1PrivateKey,
  v1WrappedUserKey,
  v2Kdf,
  v2WrappedBlobKey,
  V2_DECRYPTED_USER_KEY,
  V2_PRIVATE_KEY,
  V2_SECURITY_STATE,
  V2_SIGNED_PUBLIC_KEY,
  V2_SIGNING_KEY,
} from "./__fixtures__/crypto";

const connectionId = "synthetic-crypto-a";
const userId = "00000000-0000-0000-0000-000000000000";
const decode = (value: string) => Uint8Array.from(atob(value), (part) => part.charCodeAt(0));
const sessions: Array<{ dispose(): void }> = [];

function v1Input() {
  return {
    connectionId,
    userId,
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
  };
}

function v2Input() {
  return {
    connectionId,
    userId,
    email: v1Email,
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
  };
}

function blobInput() {
  return {
    ...v1Input(),
    accountCryptographicState: { V1: { private_key: blobPrivateKey } },
    unlock: { kind: "decrypted-key", userKey: blobWrappingKey },
  };
}

function blobCipher() {
  return { ...legacyCipher(), name: null, login: null, type: 2, data: sealedBlob };
}

function organizationInput() {
  const original = v1Input();
  const kdf = { pBKDF2: { iterations: 600_000 } };
  return {
    ...original,
    kdf,
    accountCryptographicState: { V1: { private_key: ORG_ACCOUNT_PRIVATE_KEY } },
    unlock: {
      ...original.unlock,
      masterPasswordUnlock: {
        kdf,
        salt: v1Email,
        masterKeyWrappedUserKey: ORG_ACCOUNT_MASTER_KEY_WRAPPED_USER_KEY,
      },
    },
    organizationKeys: [{ organizationId: TEST_ORGANIZATION_ID, key: TEST_ORGANIZATION_KEY }],
  };
}

function corrupt(value: string) {
  // Change decoded authenticated bytes, preserving valid base64 and framing.
  const separator = value.lastIndexOf("|");
  const prefix =
    separator >= 0 ? value.slice(0, separator + 1) : (/^\d+\./u.exec(value)?.[0] ?? "");
  const bytes = decode(value.slice(prefix.length));
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
  return prefix + btoa(String.fromCharCode(...bytes));
}

/** The recorded V2 security state re-encoded with another version and the original signature. */
function securityStateWithVersion(version: number) {
  const original = decode(V2_SECURITY_STATE);
  // [protected bstr, {}, payload bstr, 64-byte signature bstr]
  const headers = original.subarray(0, 3 + original[2]! + 1);
  const payload = [0xa1, 0x67, ...new TextEncoder().encode("version"), version];
  const signature = original.subarray(original.length - 66);
  return btoa(String.fromCharCode(...headers, 0x40 | payload.length, ...payload, ...signature));
}

/** Real WASM verifies the recorded signed state while the session reads a substituted copy. */
function verifiedAsRecordedSdk() {
  class RecordedStateClient extends sdk.PasswordManagerClient {
    override crypto(): sdk.CryptoClient {
      const crypto = super.crypto();
      return new Proxy(crypto, {
        get(target, property) {
          if (property === "initialize_user_crypto")
            return (request: sdk.InitUserCryptoRequest) => {
              const state = request.accountCryptographicState;
              return target.initialize_user_crypto({
                ...request,
                accountCryptographicState:
                  "V2" in state
                    ? { V2: { ...state.V2, security_state: V2_SECURITY_STATE } }
                    : state,
              });
            };
          const member: unknown = Reflect.get(target, property, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    }
  }
  return { ...sdk, PasswordManagerClient: RecordedStateClient };
}

/** Real WASM decrypts; the returned CipherView is transformed to reach defensive branches. */
function viewOverrideSdk(transform: (view: sdk.CipherView) => sdk.CipherView) {
  const wrap = <T extends object>(target: T, overrides: Record<string, unknown>) =>
    new Proxy(target, {
      get(object, property) {
        if (typeof property === "string" && property in overrides) return overrides[property];
        const member: unknown = Reflect.get(object, property, object);
        return typeof member === "function" ? member.bind(object) : member;
      },
    });
  class ViewClient extends sdk.PasswordManagerClient {
    override vault(): sdk.VaultClient {
      const vault = super.vault();
      return wrap(vault, {
        ciphers: () => {
          const ciphers = vault.ciphers();
          return wrap(ciphers, {
            decrypt: async (cipher: sdk.Cipher) => transform(await ciphers.decrypt(cipher)),
          });
        },
      });
    }
  }
  return { ...sdk, PasswordManagerClient: ViewClient };
}

async function session(input: unknown = v1Input()) {
  const created = await createLocalCryptoSession(input, sdk);
  expect(created.ok).toBe(true);
  if (!created.ok) throw new Error("Synthetic account was not initialized");
  sessions.push(created.data);
  return created.data;
}

afterEach(() => {
  for (const active of sessions.splice(0)) active.dispose();
  vi.restoreAllMocks();
});

describe("strict account initialization and metadata", () => {
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
      error: { code: "crypto-failed" },
    });
  });

  it("rejects a corrupt V1 private key despite SDK's lenient initialization", async () => {
    const input = v1Input();
    input.accountCryptographicState.V1.private_key = corrupt(v1PrivateKey);
    expect(await createLocalCryptoSession(input, sdk)).toEqual({
      ok: false,
      error: { code: "crypto-failed" },
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
      if (!result.ok) expect(result.error).toEqual({ code: "crypto-failed" });
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
    { ...v2Input(), kdf: { argon2id: { iterations: 6, memory: 257, parallelism: 4 } } },
    { ...v2Input(), kdf: { argon2id: { iterations: 6, memory: 32, parallelism: 17 } } },
  ])("reports valid but excessive KDF configuration as a resource limit %#", async (input) => {
    const initialize = vi.fn();
    expect(await createLocalCryptoSession(input, { ...sdk, init_sdk: initialize })).toEqual({
      ok: false,
      error: { code: "resource-limit" },
    });
    expect(initialize).not.toHaveBeenCalled();
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
      error: { code: "crypto-failed" },
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
      expect(await createLocalCryptoSession(input, sdk)).toEqual({
        ok: false,
        error: { code: "crypto-failed" },
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
      error: { code: "crypto-failed" },
    });
  });
});

describe("strict cipher isolation and disposal", () => {
  it.each([
    "2024-04-31T00:00:00Z",
    "2024-13-01T00:00:00Z",
    "2024-00-01T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
  ])("rejects impossible calendar timestamp %s before SDK decryption", async (creationDate) => {
    const active = await session();
    const decrypt = vi.spyOn(sdk.CiphersClient.prototype, "decrypt");
    expect(
      await active.decryptCipher({
        connectionId,
        cipher: { ...legacyCipher(), creationDate },
      }),
    ).toEqual({ ok: false, error: { code: "invalid-crypto-input" } });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.each(["2024-02-29T00:00:00Z", "2000-02-29T00:00:00Z"])(
    "accepts the actual leap-day timestamp %s",
    async (creationDate) => {
      const active = await session();
      expect(
        (
          await active.decryptCipher({
            connectionId,
            cipher: { ...legacyCipher(), creationDate },
          })
        ).ok,
      ).toBe(true);
    },
  );

  it.each([
    { name: "invalid optional cipher UUID", cipher: { ...legacyCipher(), id: "not-a-uuid" } },
    { name: "invalid optional folder UUID", cipher: { ...legacyCipher(), folderId: "bad-folder" } },
    { name: "invalid collection UUID", cipher: { ...legacyCipher(), collectionIds: ["bad-id"] } },
    {
      name: "unknown linked-field reference",
      cipher: {
        ...legacyCipher(),
        fields: [{ name: null, value: null, type: 3, linkedId: 999 }],
      },
    },
    {
      name: "unknown URI matching mode",
      cipher: {
        ...legacyCipher(),
        login: { ...legacyCipher().login, uris: [{ uri: null, match: 99, uriChecksum: null }] },
      },
    },
    {
      name: "invalid FIDO creation timestamp",
      cipher: {
        ...legacyCipher(),
        login: {
          ...legacyCipher().login,
          fido2Credentials: [{ ...fidoCredential, creationDate: "not-a-date" }],
        },
      },
    },
    {
      name: "missing required FIDO encrypted field",
      cipher: {
        ...legacyCipher(),
        login: {
          ...legacyCipher().login,
          fido2Credentials: [{ ...fidoCredential, keyValue: undefined }],
        },
      },
    },
  ])("rejects $name before invoking the SDK cipher deserializer", async ({ cipher }) => {
    const active = await session();
    const decrypt = vi.spyOn(sdk.CiphersClient.prototype, "decrypt");
    expect(await active.decryptCipher({ connectionId, cipher })).toEqual({
      ok: false,
      error: { code: "invalid-crypto-input" },
    });
    expect(decrypt).not.toHaveBeenCalled();
  });

  it.each([
    ["card", []],
    ["card", ["2.x"]],
    ["permissions", []],
    ["localData", Object.create({ lastUsedDate: null })],
  ])("refuses %s that is not a plain object", async (name, value) => {
    const active = await session();
    const cipher = { ...legacyCipher(), [name]: value };
    expect((await active.decryptCipher({ connectionId, cipher })).ok).toBe(false);
  });

  it("passes the SDK nested objects without keys Pateat does not read", async () => {
    // Vaultwarden returns client-stored JSON as is; `bw import` stores `response: null` in a passkey.
    const original = legacyCipher();
    const cipher = {
      ...original,
      login: {
        ...original.login,
        futureField: "not-guessed",
        fido2Credentials: [{ ...fidoCredential, response: null }],
      },
      fields: [{ name: null, value: null, type: 0, linkedId: null, futureField: "not-guessed" }],
      permissions: { delete: true, restore: true, futureField: "not-guessed" },
      passwordHistory: [],
    };
    const active = await session();
    const decrypt = vi.spyOn(sdk.CiphersClient.prototype, "decrypt");
    expect((await active.decryptCipher({ connectionId, cipher })).ok).toBe(true);
    expect((await active.decryptFido2Credentials({ connectionId, cipher })).ok).toBe(true);
    expect(await active.decryptFido2PrivateKey({ connectionId, cipher })).toEqual({
      ok: true,
      data: fidoPrivateKey,
    });
    expect(decrypt).toHaveBeenCalled();
    for (const [received] of decrypt.mock.calls)
      expect(JSON.stringify(received)).not.toMatch(/futureField|"response"/u);
  });

  it("decodes independent synthetic FIDO2 metadata and its exact PKCS8 private key", async () => {
    const active = await session();
    const original = legacyCipher();
    const cipher = {
      ...original,
      login: { ...original.login, fido2Credentials: [fidoCredential] },
    };
    const metadata = await active.decryptFido2Credentials({ connectionId, cipher });
    expect(metadata.ok).toBe(true);
    if (metadata.ok) expect(metadata.data[0]).not.toHaveProperty("keyValue");
    if (metadata.ok)
      expect(metadata.data).toMatchObject([
        {
          credentialId: "12345678-1234-4234-8234-123456789abc",
          keyType: "public-key",
          keyAlgorithm: "ECDSA",
          keyCurve: "P-256",
          rpId: "synthetic.example.test",
          userName: "synthetic-user",
          counter: "0",
          discoverable: "true",
        },
      ]);
    expect(await active.decryptFido2PrivateKey({ connectionId, cipher })).toEqual({
      ok: true,
      data: fidoPrivateKey,
    });
  });

  it("withholds the decrypted cipher key and passkey private keys from cipher views", async () => {
    const active = await session(v2Input());
    const blob = await active.decryptCipher({
      connectionId,
      cipher: { ...blobCipher(), key: v2WrappedBlobKey },
    });
    expect(blob.ok).toBe(true);
    if (blob.ok) expect(blob.data).not.toHaveProperty("key");
    const legacy = await session();
    const original = legacyCipher();
    const view = await legacy.decryptCipher({
      connectionId,
      cipher: { ...original, login: { ...original.login, fido2Credentials: [fidoCredential] } },
    });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.data.login?.fido2Credentials ?? undefined).toBeUndefined();
    expect(JSON.stringify(view.data)).not.toContain(fidoPrivateKey);
  });

  it("keeps an unreadable passkey from failing the item's other fields", async () => {
    const active = await session();
    const original = legacyCipher();
    const cipher = {
      ...original,
      login: {
        ...original.login,
        fido2Credentials: [{ ...fidoCredential, keyValue: corrupt(fidoCredential.keyValue) }],
      },
    };
    const view = await active.decryptCipher({ connectionId, cipher });
    expect(view.ok).toBe(true);
    if (view.ok) expect(view.data.login?.password).toBe("test_password");
    expect(await active.decryptFido2Credentials({ connectionId, cipher })).toEqual({
      ok: false,
      error: { code: "crypto-failed" },
    });
  });

  it.each([
    [
      "a partial view",
      (view: sdk.CipherView) => ({ ...view, partial: true }),
      "unsupported-crypto",
    ],
    [
      "a dropped passkey",
      (view: sdk.CipherView) => ({ ...view, login: { ...view.login!, fido2Credentials: [] } }),
      "crypto-failed",
    ],
  ] as const)("rejects %s from the SDK", async (_name, transform, code) => {
    const created = await createLocalCryptoSession(v1Input(), viewOverrideSdk(transform));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    sessions.push(created.data);
    const original = legacyCipher();
    const cipher = {
      ...original,
      login: { ...original.login, fido2Credentials: [fidoCredential] },
    };
    expect(await created.data.decryptFido2Credentials({ connectionId, cipher })).toEqual({
      ok: false,
      error: { code },
    });
  });

  it.each<{ name: string; metadata: Pick<sdk.AttachmentView, "url" | "size" | "sizeName"> }>([
    { name: "omitted optional metadata", metadata: {} },
    {
      name: "present optional metadata",
      metadata: { url: "https://synthetic.example.test/a.txt", size: "1", sizeName: "1 B" },
    },
  ])("withholds decrypted attachment keys with $name", async ({ metadata }) => {
    const created = await createLocalCryptoSession(
      v1Input(),
      viewOverrideSdk((view) => ({
        ...view,
        attachments: [
          {
            id: "synthetic-attachment",
            ...metadata,
            fileName: "a.txt",
            key: "synthetic-key" as sdk.SymmetricKey,
          },
        ],
      })),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    sessions.push(created.data);
    const view = await created.data.decryptCipher({ connectionId, cipher: legacyCipher() });
    expect(view).toMatchObject({
      ok: true,
      data: { attachments: [{ id: "synthetic-attachment", fileName: "a.txt" }] },
    });
    if (view.ok) {
      expect(view.data.attachments).toEqual([
        { id: "synthetic-attachment", fileName: "a.txt", ...metadata },
      ]);
      expect(view.data.attachments?.[0]).not.toHaveProperty("key");
    }
  });

  it("refuses an empty passkey private key from the SDK", async () => {
    const created = await createLocalCryptoSession(
      v1Input(),
      viewOverrideSdk((view) => ({
        ...view,
        login: {
          ...view.login!,
          fido2Credentials: view.login!.fido2Credentials!.map((credential) => ({
            ...credential,
            keyValue: "",
          })),
        },
      })),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    sessions.push(created.data);
    const original = legacyCipher();
    const cipher = {
      ...original,
      login: { ...original.login, fido2Credentials: [fidoCredential] },
    };
    expect(await created.data.decryptFido2PrivateKey({ connectionId, cipher })).toEqual({
      ok: false,
      error: { code: "crypto-failed" },
    });
  });

  it("rejects authenticated FIDO2 private-key corruption", async () => {
    const active = await session();
    const original = legacyCipher();
    const cipher = {
      ...original,
      login: {
        ...original.login,
        fido2Credentials: [{ ...fidoCredential, keyValue: corrupt(fidoCredential.keyValue) }],
      },
    };
    expect(await active.decryptFido2PrivateKey({ connectionId, cipher })).toEqual({
      ok: false,
      error: { code: "crypto-failed" },
    });
  });

  it("does not select the first of multiple FIDO2 private keys", async () => {
    const active = await session();
    const original = legacyCipher();
    const cipher = {
      ...original,
      login: { ...original.login, fido2Credentials: [fidoCredential, fidoCredential] },
    };
    expect(await active.decryptFido2PrivateKey({ connectionId, cipher })).toEqual({
      ok: false,
      error: { code: "unsupported-crypto" },
    });
  });

  it("rejects a corrupted organization key without producing a partial account", async () => {
    const input = organizationInput();
    input.organizationKeys[0]!.key = corrupt(TEST_ORGANIZATION_KEY);
    expect(await createLocalCryptoSession(input, sdk)).toEqual({
      ok: false,
      error: { code: "crypto-failed" },
    });
  });

  it("preserves custom-field types, duplicate names, linked references and leading zeros", async () => {
    const active = await session();
    const cipher = {
      ...legacyCipher(),
      fields: [
        {
          name: customFieldCiphertexts.duplicateName,
          value: customFieldCiphertexts.branch,
          type: 0,
          linkedId: null,
        },
        {
          name: customFieldCiphertexts.duplicateName,
          value: customFieldCiphertexts.account,
          type: 1,
          linkedId: null,
        },
        {
          name: customFieldCiphertexts.duplicateName,
          value: customFieldCiphertexts.boolean,
          type: 2,
          linkedId: null,
        },
        { name: customFieldCiphertexts.linkedName, value: null, type: 3, linkedId: 101 },
      ],
    };
    const result = await active.decryptCipher({ connectionId, cipher });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fields).toHaveLength(4);
      expect(result.data.fields?.slice(0, 3)).toMatchObject([
        { name: "duplicate", value: "007", type: 0 },
        { name: "duplicate", value: "00001234", type: 1 },
        { name: "duplicate", value: "true", type: 2 },
      ]);
      expect(result.data.fields?.[3]).toMatchObject({
        name: "linked-password",
        type: 3,
        linkedId: 101,
      });
      expect(result.data.fields?.[3]?.value).toBeUndefined();
    }
  });

  it("rejects the entire cipher when a custom-field value's MAC fails", async () => {
    const active = await session();
    const cipher = {
      ...legacyCipher(),
      fields: [
        {
          name: customFieldCiphertexts.duplicateName,
          value: corrupt(customFieldCiphertexts.branch),
          type: 0,
          linkedId: null,
        },
      ],
    };
    expect(await active.decryptCipher({ connectionId, cipher })).toEqual({
      ok: false,
      error: { code: "crypto-failed" },
    });
  });

  it.each([
    [uriCiphertexts.checksum, true],
    [uriCiphertexts.wrongChecksum, false],
  ])(
    "accepts a URI only with its authenticated valid checksum %#",
    async (uriChecksum, accepted) => {
      const active = await session();
      const original = legacyCipher();
      const cipher = {
        ...original,
        login: { ...original.login, uris: [{ uri: uriCiphertexts.uri, match: null, uriChecksum }] },
      };
      const result = await active.decryptCipher({ connectionId, cipher });
      expect(result.ok).toBe(accepted);
      if (result.ok)
        expect(result.data.login?.uris?.[0]?.uri).toBe("https://synthetic.example.test/login");
      else expect(result.error).toEqual({ code: "crypto-failed" });
    },
  );

  it("decrypts a complete fixed V1 login without requesting the network", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No network in synthetic crypto test"));
    const active = await session();
    const result = await active.decryptCipher({ connectionId, cipher: legacyCipher() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("My test login");
      expect(result.data.login?.username).toBe("test_username");
      expect(result.data.login?.password).toBe("test_password");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("decrypts the independent fixed current sealed-blob vector", async () => {
    const active = await session(blobInput());
    const result = await active.decryptCipher({ connectionId, cipher: blobCipher() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.name).toBe("Test Cipher");
      expect(result.data.notes).toBe("Some notes");
      expect(result.data.secureNote?.type).toBe(0);
    }
  });

  it("rejects a cipher key that fails authentication instead of falling back to the user key", async () => {
    // The user key alone decrypts this blob, so a fallback would succeed.
    const active = await session(blobInput());
    expect(
      await active.decryptCipher({
        connectionId,
        cipher: { ...blobCipher(), key: corrupt(v1WrappedUserKey) },
      }),
    ).toEqual({ ok: false, error: { code: "crypto-failed" } });
  });

  it.each(["name", "username", "password"])(
    "fails the complete cipher when %s authentication fails",
    async (field) => {
      const active = await session();
      const cipher = legacyCipher();
      if (field === "name") cipher.name = corrupt(cipher.name);
      else if (field === "username") cipher.login.username = corrupt(cipher.login.username);
      else cipher.login.password = corrupt(cipher.login.password);
      const result = await active.decryptCipher({ connectionId, cipher });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toEqual({ code: "crypto-failed" });
    },
  );

  it.each(["wrapped_cek", "envelope"])(
    "rejects authenticated blob %s corruption",
    async (field) => {
      const active = await session(blobInput());
      const blob = JSON.parse(sealedBlob) as Record<string, string>;
      blob[field] = corrupt(blob[field] ?? "");
      expect(
        (
          await active.decryptCipher({
            connectionId,
            cipher: { ...blobCipher(), data: JSON.stringify(blob) },
          })
        ).ok,
      ).toBe(false);
    },
  );
  it("rejects cross-connection requests before cipher processing", async () => {
    const active = await session();
    expect(
      await active.decryptCipher({ connectionId: "synthetic-crypto-b", cipher: legacyCipher() }),
    ).toEqual({ ok: false, error: { code: "connection-mismatch" } });
  });

  it("fails closed for a cipher whose organization key was never loaded", async () => {
    const active = await session();
    const cipher = { ...legacyCipher(), organizationId: "11111111-1111-4111-8111-111111111111" };
    expect(await active.decryptCipher({ connectionId, cipher })).toEqual({
      ok: false,
      error: { code: "crypto-failed" },
    });
  });

  it.each([
    ["8.ABC", "unsupported-crypto"],
    ["2.AAECAw==|Y3Q=|AAECAw==", "unsupported-crypto"],
    ["2.!!!!|Y3Q=|!!!!", "unsupported-crypto"],
  ])("rejects unparsable or unknown encrypted data %s", async (name, code) => {
    const active = await session();
    expect(
      await active.decryptCipher({ connectionId, cipher: { ...legacyCipher(), name } }),
    ).toEqual({ ok: false, error: { code } });
  });

  it("rejects authenticated field downgrade to unauthenticated CBC", async () => {
    const active = await session();
    const cipher = legacyCipher();
    cipher.name = `0.${cipher.name.slice(2).split("|").slice(0, 2).join("|")}`;
    expect(await active.decryptCipher({ connectionId, cipher })).toEqual({
      ok: false,
      error: { code: "unsupported-crypto" },
    });
  });

  it("locks every operation after idempotent disposal", async () => {
    const active = await session();
    active.dispose();
    active.dispose();
    expect(await active.decryptCipher({ connectionId, cipher: legacyCipher() })).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
    expect(await active.decryptFido2Credentials({ connectionId, cipher: legacyCipher() })).toEqual({
      ok: false,
      error: { code: "crypto-locked" },
    });
  });

  it("discards a decryption result when disposed while it is awaiting the SDK", async () => {
    const active = await session();
    const pending = active.decryptCipher({ connectionId, cipher: legacyCipher() });
    active.dispose();
    expect(await pending).toEqual({ ok: false, error: { code: "crypto-locked" } });
  });

  it("isolates two clients and keeps the other account usable after disposal", async () => {
    const first = await session();
    const second = await session({ ...v1Input(), connectionId: "synthetic-crypto-b" });
    first.dispose();
    expect(
      (await second.decryptCipher({ connectionId: "synthetic-crypto-b", cipher: legacyCipher() }))
        .ok,
    ).toBe(true);
    expect(await second.decryptCipher({ connectionId, cipher: legacyCipher() })).toEqual({
      ok: false,
      error: { code: "connection-mismatch" },
    });
  });

  it.each([99, 0, "1", null])(
    "does not fall back when blob format version is %j",
    async (formatVersion) => {
      const active = await session();
      const cipher = legacyCipher();
      const data = JSON.parse(sealedBlob) as Record<string, unknown>;
      data["format_version"] = formatVersion;
      const result = await active.decryptCipher({
        connectionId,
        cipher: { ...cipher, data: JSON.stringify(data) },
      });
      expect(result).toEqual({ ok: false, error: { code: "unsupported-crypto" } });
    },
  );

  it.each([
    "{",
    "[]",
    '{"format_version":1}',
    '{"format_version":1,"wrapped_cek":"8.ABC","envelope":"bad"}',
  ])("rejects malformed claimed blob %s", async (data) => {
    const active = await session();
    const result = await active.decryptCipher({
      connectionId,
      cipher: { ...legacyCipher(), data },
    });
    expect(result).toEqual({ ok: false, error: { code: "unsupported-crypto" } });
  });
});
