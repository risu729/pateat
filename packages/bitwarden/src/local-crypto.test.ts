import { afterEach, describe, expect, vi } from "vitest";
import * as sdk from "@bitwarden/sdk-internal/node/bitwarden_wasm_internal.js";
import { createLocalCryptoSession, type LocalCryptoSession } from "./local-crypto";
import {
  blobPrivateKey,
  blobWrappingKey,
  legacyCipher,
  ORG_ACCOUNT_MASTER_KEY_WRAPPED_USER_KEY,
  ORG_ACCOUNT_PRIVATE_KEY,
  sealedBlob,
  TEST_ORGANIZATION_ID,
  TEST_ORGANIZATION_KEY,
  organizationCipherFields,
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
} from "./__fixtures__/crypto";
import { registerAccountInitializationTests } from "../test/local-crypto/account-initialization";
import { registerCipherIsolationTests } from "../test/local-crypto/cipher-isolation";
import { registerItemRepairTests } from "../test/local-crypto/item-repair";

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

const unopenedOrganizationId = "2bc9ac1e-f5aa-45f2-94bf-b181009709b8";

function organizationCipher() {
  const cipher = legacyCipher();
  return {
    ...cipher,
    organizationId: TEST_ORGANIZATION_ID,
    name: organizationCipherFields.name,
    login: {
      ...cipher.login,
      username: organizationCipherFields.username,
      password: organizationCipherFields.password,
    },
  };
}

/** The unopened organization's items are refused by name and its collections left out. */
async function expectOrganizationLeftOut(active: LocalCryptoSession, connection: string) {
  try {
    expect(
      await active.decryptCipher({
        connectionId: connection,
        cipher: { ...legacyCipher(), organizationId: unopenedOrganizationId },
      }),
    ).toEqual({ ok: false, error: { code: "crypto-failed", check: "organization-key" } });
    expect(
      await active.decryptCatalogGroups({
        folders: [],
        collections: [
          {
            id: "6abcdef0-0000-4000-8000-000000000001",
            organizationId: unopenedOrganizationId,
            name: legacyCipher().name,
            externalId: null,
            hidePasswords: false,
            readOnly: false,
            manage: true,
            defaultUserCollectionEmail: null,
            type: 0,
          },
        ],
      }),
    ).toEqual({ ok: true, data: [] });
  } finally {
    active.dispose();
  }
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

export type LocalCryptoTestFixtures = {
  connectionId: typeof connectionId;
  sessions: typeof sessions;
  v1Input: typeof v1Input;
  v2Input: typeof v2Input;
  blobInput: typeof blobInput;
  blobCipher: typeof blobCipher;
  organizationInput: typeof organizationInput;
  unopenedOrganizationId: typeof unopenedOrganizationId;
  organizationCipher: typeof organizationCipher;
  expectOrganizationLeftOut: typeof expectOrganizationLeftOut;
  corrupt: typeof corrupt;
  securityStateWithVersion: typeof securityStateWithVersion;
  verifiedAsRecordedSdk: typeof verifiedAsRecordedSdk;
  viewOverrideSdk: typeof viewOverrideSdk;
  session: typeof session;
};

describe("strict account initialization and metadata", () => {
  registerAccountInitializationTests({
    sessions,
    v1Input,
    v2Input,
    organizationInput,
    corrupt,
    securityStateWithVersion,
    verifiedAsRecordedSdk,
    session,
  });
});

describe("strict cipher isolation and disposal", () => {
  registerCipherIsolationTests({
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
  });
});

describe("repairing a partly readable item (ADR 0006)", () => {
  registerItemRepairTests({ connectionId, corrupt, session });
});
