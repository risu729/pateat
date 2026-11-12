import { expect, it, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { createLocalCryptoSession } from "../../src/local-crypto";
import {
  customFieldCiphertexts,
  fidoCredential,
  fidoPrivateKey,
  legacyCipher,
  sealedBlob,
  TEST_ORGANIZATION_KEY,
  totpCiphertext,
  uriCiphertexts,
  v1Password,
  v1WrappedUserKey,
  v2WrappedBlobKey,
} from "../../src/__fixtures__/crypto";
import { bitwardenTotpSecret } from "../../src/__fixtures__/totp";
import type { CipherIsolationContext } from "./context";

export function registerCipherIsolationTests({
  connectionId,
  sessions,
  v1Input,
  v2Input,
  blobInput,
  blobCipher,
  organizationInput,
  unopenedOrganizationId,
  organizationCipher,
  expectOrganizationLeftOut,
  corrupt,
  viewOverrideSdk,
  session,
}: CipherIsolationContext) {
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
      error: { code: "crypto-failed", check: "sdk-decrypt" },
    });
  });

  it.each([
    [
      "a partial view",
      (view: sdk.CipherView) => ({ ...view, partial: true }),
      { code: "unsupported-crypto" },
    ],
    [
      "a dropped passkey",
      (view: sdk.CipherView) => ({ ...view, login: { ...view.login!, fido2Credentials: [] } }),
      { code: "crypto-failed", check: "passkey-dropped" },
    ],
    [
      "an attachment that failed to decrypt",
      (view: sdk.CipherView) =>
        ({ ...view, attachmentDecryptionFailures: [{}] }) as unknown as sdk.CipherView,
      { code: "crypto-failed", check: "attachment" },
    ],
  ] as const)("rejects %s from the SDK", async (_name, transform, error) => {
    const created = await createLocalCryptoSession(v1Input(), viewOverrideSdk(transform));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    sessions.push(created.data);
    const original = legacyCipher();
    const cipher = {
      ...original,
      login: {
        ...original.login,
        uris: [{ uri: uriCiphertexts.uri, match: null, uriChecksum: uriCiphertexts.checksum }],
        fido2Credentials: [fidoCredential],
      },
    };
    expect(await created.data.decryptFido2Credentials({ connectionId, cipher })).toEqual({
      ok: false,
      error,
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
      error: { code: "crypto-failed", check: "sdk-decrypt" },
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

  it("rejects a corrupted organization key when no organization key opens", async () => {
    const input = organizationInput();
    input.organizationKeys[0]!.key = corrupt(TEST_ORGANIZATION_KEY);
    expect(await createLocalCryptoSession(input, sdk)).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "session-open" },
    });
  });

  it.each([
    ["corrupted", corrupt(TEST_ORGANIZATION_KEY)],
    ["malformed COSE", "7.AA=="],
  ])(
    "leaves out only the organization whose %s key does not open (ADR 0006)",
    async (_name, key) => {
      const input = organizationInput();
      input.organizationKeys.push({ organizationId: unopenedOrganizationId, key });
      const opened = await createLocalCryptoSession(input, sdk);
      expect(opened.ok).toBe(true);
      if (!opened.ok) return;
      try {
        const working = await opened.data.decryptCipher({
          connectionId: input.connectionId,
          cipher: organizationCipher(),
        });
        expect(working.ok && working.data.name).toBe("Synthetic organization login");
      } finally {
        await expectOrganizationLeftOut(opened.data, input.connectionId);
      }
    },
  );

  it("rejects an account private key that is not an RSA key", async () => {
    const input = organizationInput();
    const userKey = sdk.PureCrypto.decrypt_user_key_with_master_password(
      input.unlock.masterPasswordUnlock.masterKeyWrappedUserKey,
      v1Password,
      input.unlock.masterPasswordUnlock.salt,
      input.unlock.masterPasswordUnlock.kdf,
    );
    try {
      input.accountCryptographicState = {
        V1: { private_key: sdk.PureCrypto.symmetric_encrypt_bytes(new Uint8Array(64), userKey) },
      };
      // Without organization keys, nothing else would use the private key at open.
      input.organizationKeys = [];
    } finally {
      userKey.fill(0);
    }
    expect(await createLocalCryptoSession(input, sdk)).toEqual({
      ok: false,
      error: { code: "crypto-failed", check: "session-open" },
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
      error: { code: "crypto-failed", check: "sdk-decrypt" },
    });
  });

  // The official clients use a legacy keyless item's URIs unchecked, and the SDK leaves
  // out a URI whose checksum it refuses (ADR 0005); either way the item is used.
  it.each([uriCiphertexts.checksum, uriCiphertexts.wrongChecksum])(
    "uses a legacy item's URI whatever its checksum %#",
    async (uriChecksum) => {
      const active = await session();
      const original = legacyCipher();
      const cipher = {
        ...original,
        login: { ...original.login, uris: [{ uri: uriCiphertexts.uri, match: null, uriChecksum }] },
      };
      const result = await active.decryptCipher({ connectionId, cipher });
      expect(result.ok).toBe(true);
      if (result.ok)
        expect(result.data.login?.uris?.[0]?.uri).toBe("https://synthetic.example.test/login");
    },
  );

  it("uses an item whose URI the SDK left out", async () => {
    const created = await createLocalCryptoSession(
      v1Input(),
      viewOverrideSdk((view) => ({ ...view, login: { ...view.login!, uris: [] } })),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    sessions.push(created.data);
    const original = legacyCipher();
    const cipher = {
      ...original,
      login: {
        ...original.login,
        uris: [{ uri: uriCiphertexts.uri, match: null, uriChecksum: uriCiphertexts.checksum }],
      },
    };
    const result = await created.data.decryptCipher({ connectionId, cipher });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.login?.uris).toEqual([]);
      expect(result.data.login?.password).toBe("test_password");
    }
  });

  it("decrypts the fixed TOTP key the E2E fixture stores", async () => {
    const active = await session();
    const original = legacyCipher();
    const cipher = { ...original, login: { ...original.login, totp: totpCiphertext } };
    const result = await active.decryptCipher({ connectionId, cipher });
    expect(result.ok && result.data.login?.totp).toBe(bitwardenTotpSecret);
  });

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
    ).toEqual({ ok: false, error: { code: "crypto-failed", check: "sdk-decrypt" } });
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
      if (!result.ok) expect(result.error).toEqual({ code: "crypto-failed", check: "sdk-decrypt" });
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
      error: { code: "crypto-failed", check: "unknown-organization" },
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
}
