// Browser-safe raw provider DTO fixtures: no SDK import or cryptography at module load.
// Wire shapes follow pinned server9ee4e0e AccountKeys/UserDecryption/Cipher response models.
// Encrypted values come from public SDK7de8f13a fixtures (see crypto.ts) or explicitly
// labeled one-time SDK-generated adapters (account-generated.ts), never real accounts.
import {
  legacyName,
  legacyUsername,
  legacyPassword,
  organizationCipherFields,
  ORG_ACCOUNT_MASTER_KEY_WRAPPED_USER_KEY,
  ORG_ACCOUNT_PRIVATE_KEY,
  TEST_ORGANIZATION_ID,
  TEST_ORGANIZATION_KEY,
  v1Email,
  v1PrivateKey,
  v1WrappedUserKey,
  sealedBlob,
  v2WrappedBlobKey,
  V2_PRIVATE_KEY,
  V2_SIGNING_KEY,
  V2_SIGNED_PUBLIC_KEY,
  V2_SECURITY_STATE,
} from "./crypto";
import {
  accountPublicKey,
  accountVerifyingKey,
  v2ContainedKeyId,
  v2MasterWrappedUserKey,
  v2UnlockSalt,
} from "./account-generated";

export const accountProfile = {
  connectionId: "synthetic-account-a",
  environment: { kind: "cloud", region: "us" },
} as const;
export const accountUserId = "060000fb-0922-4dd3-b170-6e15cb5df8c8";
export const accountNow = 2_000_000_000;
export const accountSecurityStamp = "10000000-0000-4000-8000-000000000001";

export function syntheticJwt(claims: Record<string, unknown> = {}) {
  const encode = (value: unknown) =>
    btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    sub: accountUserId,
    email: v1Email,
    exp: accountNow + 3600,
    iat: accountNow - 1,
    nbf: accountNow - 1,
    client_id: "browser",
    iss: "https://identity.bitwarden.com",
    aud: "api",
    sstamp: accountSecurityStamp,
    ...claims,
  })}.c3ludGhldGljLXNpZ25hdHVyZQ`;
}

export function rawLoginCipher() {
  return {
    object: "cipherDetails",
    id: "090c19ea-a61a-4df6-8963-262b97bc6266",
    organizationId: null,
    folderId: null,
    collectionIds: [],
    key: null,
    type: 1,
    name: legacyName,
    notes: null,
    login: {
      username: legacyUsername,
      password: legacyPassword,
      passwordRevisionDate: null,
      uris: null,
      totp: null,
      autofillOnPageLoad: null,
      fido2Credentials: null,
    },
    favorite: false,
    reprompt: 0,
    organizationUseTotp: false,
    edit: true,
    viewPassword: true,
    creationDate: "2024-01-30T17:55:36.150Z",
    revisionDate: "2024-01-30T17:55:36.150Z",
    deletedDate: null,
    attachments: null,
    fields: null,
    passwordHistory: null,
    // Ordinary full Data is flat legacy JSON; it is not a sealed blob.
    data: JSON.stringify({
      name: legacyName,
      notes: null,
      fields: null,
      passwordHistory: null,
      username: legacyUsername,
      password: legacyPassword,
      passwordRevisionDate: null,
      uris: null,
      totp: null,
      autofillOnPageLoad: null,
      fido2Credentials: null,
    }),
  };
}

export function rawV1Account() {
  return {
    token: {
      access_token: syntheticJwt(),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "synthetic-refresh-token",
      Key: v1WrappedUserKey,
      PrivateKey: v1PrivateKey,
      Kdf: 0,
      KdfIterations: 100_000,
      KdfMemory: null,
      KdfParallelism: null,
    },
    sync: {
      object: "sync",
      profile: {
        object: "profile",
        id: accountUserId,
        email: v1Email,
        key: v1WrappedUserKey,
        privateKey: v1PrivateKey,
        securityStamp: accountSecurityStamp,
        organizations: [],
      },
      folders: [],
      collections: [],
      ciphers: [rawLoginCipher()],
      policies: [],
      policiesNew: [],
      sends: [],
      domains: null,
      userDecryption: null,
    },
  };
}

export function rawV2Account() {
  const accountKeys = {
    publicKeyEncryptionKeyPair: {
      publicKey: accountPublicKey,
      wrappedPrivateKey: V2_PRIVATE_KEY,
      signedPublicKey: V2_SIGNED_PUBLIC_KEY,
    },
    signatureKeyPair: { wrappedSigningKey: V2_SIGNING_KEY, verifyingKey: accountVerifyingKey },
    securityState: { securityState: V2_SECURITY_STATE, securityVersion: 2 },
  };
  const masterPasswordUnlock = {
    kdf: { kdfType: 1, iterations: 6, memory: 32, parallelism: 4 },
    masterKeyEncryptedUserKey: v2MasterWrappedUserKey,
    salt: v2UnlockSalt,
    containedKeyId: v2ContainedKeyId,
  };
  return {
    token: {
      access_token: syntheticJwt(),
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "synthetic-refresh-token",
      Key: v2MasterWrappedUserKey,
      PrivateKey: V2_PRIVATE_KEY,
      Kdf: 1,
      KdfIterations: 6,
      KdfMemory: 32,
      KdfParallelism: 4,
      AccountKeys: structuredClone(accountKeys),
      UserDecryptionOptions: {
        HasMasterPassword: true,
        MasterPasswordUnlock: structuredClone(masterPasswordUnlock),
      },
    },
    sync: {
      object: "sync",
      profile: {
        object: "profile",
        id: accountUserId,
        email: v1Email,
        key: v2MasterWrappedUserKey,
        privateKey: V2_PRIVATE_KEY,
        accountKeys,
        securityStamp: accountSecurityStamp,
        organizations: [],
      },
      folders: [],
      collections: [],
      ciphers: [
        {
          object: "cipherDetails",
          id: "090c19ea-a61a-4df6-8963-262b97bc6266",
          organizationId: null,
          folderId: null,
          collectionIds: [],
          type: 2,
          key: v2WrappedBlobKey,
          name: null,
          notes: null,
          favorite: false,
          reprompt: 0,
          organizationUseTotp: false,
          edit: true,
          viewPassword: true,
          creationDate: "2024-01-30T17:55:36.150Z",
          revisionDate: "2024-01-30T17:55:36.150Z",
          data: sealedBlob,
        },
      ],
      policies: [],
      policiesNew: [],
      sends: [],
      domains: null,
      userDecryption: { masterPasswordUnlock, userKeyId: v2ContainedKeyId },
    },
  };
}

export function rawOrganizationAccount() {
  const raw = rawV1Account();
  raw.token.Key = ORG_ACCOUNT_MASTER_KEY_WRAPPED_USER_KEY;
  raw.token.PrivateKey = ORG_ACCOUNT_PRIVATE_KEY;
  raw.token.KdfIterations = 600_000;
  raw.sync.profile.key = ORG_ACCOUNT_MASTER_KEY_WRAPPED_USER_KEY;
  raw.sync.profile.privateKey = ORG_ACCOUNT_PRIVATE_KEY;
  Object.assign(raw.sync.profile, {
    organizations: [
      { id: TEST_ORGANIZATION_ID, key: TEST_ORGANIZATION_KEY, enabled: true, status: 2 },
    ],
  });
  const cipher = raw.sync.ciphers[0]!;
  Object.assign(cipher, {
    organizationId: TEST_ORGANIZATION_ID,
    name: organizationCipherFields.name,
    login: {
      ...cipher.login,
      username: organizationCipherFields.username,
      password: organizationCipherFields.password,
    },
    data: JSON.stringify({
      ...JSON.parse(cipher.data),
      name: organizationCipherFields.name,
      username: organizationCipherFields.username,
      password: organizationCipherFields.password,
    }),
  });
  return raw;
}
