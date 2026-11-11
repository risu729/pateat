import type * as Sdk from "@bitwarden/sdk-internal";
import * as v from "valibot";

import { decodeBase64 } from "./base64";
import { decryptFailure, failure, type BitwardenResult } from "./errors";
import { verifiedSecurityStateVersion } from "./security-state";
import {
  admitLocalCryptoCipher,
  authenticatedCiphertext,
  decryptSchema,
  encryptedCatalogContextSchema,
  framedEncryption,
  kdfSchema,
  parsed,
  sessionSchema,
  verifyPasswordSchema,
} from "./local-crypto-admission";
export {
  admitLocalCryptoCipher,
  localCryptoAccountContextSchema,
  encryptedCatalogContextSchema,
} from "./local-crypto-admission";

/** Host binds packaged WASM before calling this factory. No SDK network APIs are exposed. */
export type LocalCryptoSdk = Pick<
  typeof Sdk,
  "PasswordManagerClient" | "ManagedSettingsClient" | "PureCrypto" | "LogLevel" | "init_sdk"
>;

/** Decrypted passkey metadata. The SDK view's decrypted private key (`keyValue`) is withheld. */
export type LocalFido2CredentialMetadata = Omit<Sdk.Fido2CredentialView, "keyValue">;
/**
 * The SDK's strict CipherView without the decrypted cipher, attachment and passkey private keys,
 * which the pinned SDK places in the view. None leaves the crypto boundary through this view.
 */
export type LocalCipherView = Omit<Sdk.CipherView, "key" | "login" | "attachments"> & {
  login:
    | (Omit<Sdk.LoginView, "fido2Credentials"> & {
        fido2Credentials: LocalFido2CredentialMetadata[] | undefined;
      })
    | undefined;
  attachments: Omit<Sdk.AttachmentView, "key">[] | undefined;
};

export interface LocalCryptoSession {
  readonly metadata: Readonly<{
    connectionId: string;
    userId: string;
    accountVersion: "v1" | "v2";
    securityVersion: 1 | 2;
  }>;
  /** Existing SDK-verified key only. The vault host separately gates export on item verification. */
  exportUnlockMaterial(): BitwardenResult<{
    userKey: string;
    metadata: LocalCryptoSession["metadata"];
  }>;
  /**
   * Whether a master password unwraps this session's user key from the account's stored
   * master-password unlock data, offline, as Bitwarden's re-prompt checks it. This code keeps
   * nothing derived from the password; copies the SDK's native heap may hold are not wiped.
   */
  verifyMasterPassword(input: unknown): BitwardenResult<{ matches: boolean }>;
  decryptCipher(input: unknown): Promise<BitwardenResult<LocalCipherView>>;
  decryptCatalogGroups(
    input: unknown,
  ): Promise<BitwardenResult<{ id: string; label: string; kind: "folder" | "collection" }[]>>;
  decryptFido2Credentials(input: unknown): Promise<BitwardenResult<LocalFido2CredentialMetadata[]>>;
  /** The item's single stored passkey private key, for the Worker's signing step only. */
  decryptFido2PrivateKey(input: unknown): Promise<BitwardenResult<string>>;
  dispose(): void;
}

/** Compares without an early exit, so the time taken does not tell where keys differ. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!;
  return difference === 0;
}

function bytesFromBase64(value: string): Uint8Array {
  const bytes = decodeBase64(value);
  if (!bytes) throw new Error();
  return bytes;
}

function canonicalBase64(value: string): boolean {
  return decodeBase64(value) !== undefined;
}

function passkeyMetadata({
  keyValue: _privateKey,
  ...metadata
}: Sdk.Fido2CredentialView): LocalFido2CredentialMetadata {
  return metadata;
}

function memoryBridge() {
  const values = new Map<string, unknown>();
  const slots = [
    "user_key",
    "user_key_id",
    "persistent_pin_envelope",
    "ephemeral_pin_envelope",
    "encrypted_pin",
    "v2_upgrade_token",
    "account_cryptographic_state",
    "masterpassword_unlock_data",
    "webauthn_prf_unlock_data",
    "kdf_config",
    "v2_encrypted_migrations_grace_period_start",
  ];
  const methods: Record<string, unknown> = {};
  for (const slot of slots) {
    methods[`set_${slot}`] = async (value: unknown) => {
      values.set(slot, value);
    };
    methods[`get_${slot}`] = async () => values.get(slot) ?? null;
    methods[`clear_${slot}`] = async () => {
      values.delete(slot);
    };
  }
  // Exact pinned SDK bridge method names; values originate solely from that SDK.
  return { bridge: methods as unknown as Sdk.WasmStateBridge, values };
}

type MasterPasswordKdf = Parameters<
  LocalCryptoSdk["PureCrypto"]["decrypt_user_key_with_master_password"]
>[3];
/** KDF settings the SDK refuses for any password, so a refusal says nothing of the password. */
function belowSdkMinimum(kdf: MasterPasswordKdf): boolean {
  return "pBKDF2" in kdf
    ? kdf.pBKDF2.iterations < 5000
    : kdf.argon2id.iterations < 2 || kdf.argon2id.memory < 16;
}
/**
 * Whether the master password unwraps the account's user key; a wrong one fails
 * authentication. Settings below the SDK's minimums answer true: the password is not
 * what failed.
 */
function masterPasswordOpens(
  sdk: LocalCryptoSdk,
  unlock: {
    password: string;
    masterPasswordUnlock: {
      masterKeyWrappedUserKey: string;
      salt: string;
      kdf: MasterPasswordKdf;
    };
  },
): boolean {
  if (belowSdkMinimum(unlock.masterPasswordUnlock.kdf)) return true;
  try {
    sdk.PureCrypto.decrypt_user_key_with_master_password(
      unlock.masterPasswordUnlock.masterKeyWrappedUserKey,
      unlock.password,
      unlock.masterPasswordUnlock.salt,
      unlock.masterPasswordUnlock.kdf,
    ).fill(0);
    return true;
  } catch {
    return false;
  }
}

/** Local-only account initialization. Authentication, migrations and persisted unlock are separate gates. */
export async function createLocalCryptoSession(
  input: unknown,
  sdk: LocalCryptoSdk,
): Promise<BitwardenResult<LocalCryptoSession>> {
  const options = parsed(sessionSchema, input);
  if (!options) return failure("invalid-crypto-input");
  const withinResourceBudget = (kdf: v.InferOutput<typeof kdfSchema>) =>
    "pBKDF2" in kdf
      ? kdf.pBKDF2.iterations <= 2_000_000
      : kdf.argon2id.iterations <= 20 &&
        kdf.argon2id.memory <= 1024 &&
        kdf.argon2id.parallelism <= 16;
  if (
    !withinResourceBudget(options.kdf) ||
    (options.unlock.kind === "password" &&
      !withinResourceBudget(options.unlock.masterPasswordUnlock.kdf))
  )
    return failure("resource-limit");
  const account = options.accountCryptographicState;
  if (
    "V1" in account
      ? !authenticatedCiphertext(account.V1.private_key)
      : !authenticatedCiphertext(account.V2.private_key) ||
        !authenticatedCiphertext(account.V2.signing_key)
  ) {
    return failure("unsupported-crypto");
  }
  if (
    options.unlock.kind === "password" &&
    !authenticatedCiphertext(options.unlock.masterPasswordUnlock.masterKeyWrappedUserKey)
  ) {
    return failure("unsupported-crypto");
  }
  if (
    options.unlock.kind === "password" &&
    JSON.stringify(options.kdf) !== JSON.stringify(options.unlock.masterPasswordUnlock.kdf)
  ) {
    return failure("invalid-crypto-input");
  }
  const organizationKeys = new Map(
    options.organizationKeys?.map((entry) => [entry.organizationId, entry.key]),
  );
  if (organizationKeys.size !== (options.organizationKeys?.length ?? 0))
    return failure("invalid-crypto-input");
  // Invalid EncString deserialization inside the SDK's async WASM export can strand its Promise.
  if (!organizationKeys.values().every((key) => framedEncryption(key, [3, 4, 7])))
    return failure("unsupported-crypto");
  const accountVersion = "V1" in options.accountCryptographicState ? "v1" : "v2";
  const memory = memoryBridge();
  const handles: { free(): void }[] = [];
  let locked = false;
  let pendingCalls = 0;
  const releaseHandles = () => {
    for (const handle of handles.reverse()) {
      try {
        handle.free();
      } catch {
        /* Cleanup never exposes SDK error objects. */
      }
    }
    handles.length = 0;
  };
  const dispose = () => {
    locked = true;
    memory.values.clear();
    // WASM async closures retain these native objects. Freeing while pending is unsafe.
    // Host Worker termination is the hard cancellation boundary; local disposal withholds results.
    if (pendingCalls === 0) releaseHandles();
  };
  try {
    // Error level still logs: the trusted host must disable console before SDK initialization.
    sdk.init_sdk(sdk.LogLevel.Error, sdk.LogLevel.Error, 0);
    // The SDK's async initialization never settles when it cannot parse an argument. Invalid base64
    // is rejected here; malformed COSE inside valid base64 is not checked locally, and only the
    // host's termination of the owning Worker ends such a call (as `crypto-failed` or `timeout`).
    if (
      "V2" in account &&
      (!canonicalBase64(account.V2.security_state) ||
        !canonicalBase64(account.V2.signed_public_key))
    ) {
      dispose();
      return failure("invalid-crypto-input");
    }
    if (options.unlock.kind === "decrypted-key") {
      let key: Uint8Array | undefined;
      let wrappingKey: Uint8Array | undefined;
      try {
        key = bytesFromBase64(options.unlock.userKey);
        wrappingKey = sdk.PureCrypto.make_user_key_aes256_cbc_hmac();
        // Synchronous SDK parsing validates AES/COSE key serialization. Discard the wrapped result.
        sdk.PureCrypto.wrap_symmetric_key(key, wrappingKey);
      } catch {
        dispose();
        return failure("invalid-crypto-input");
      } finally {
        key?.fill(0);
        wrappingKey?.fill(0);
      }
    }
    const settings = new sdk.ManagedSettingsClient();
    handles.push(settings);
    const client = new sdk.PasswordManagerClient(
      { get_access_token: async () => undefined },
      undefined,
      settings,
    );
    handles.push(client);
    const platform = client.platform();
    handles.push(platform);
    await platform.load_flags(new Map([["strict-cipher-decryption", true]]));
    const bridge = client.km_state_bridge();
    handles.push(bridge);
    bridge.register_bridge_impl(memory.bridge);
    const crypto = client.crypto();
    handles.push(crypto);
    try {
      await crypto.initialize_user_crypto({
        userId: options.userId as unknown as Sdk.UserId,
        email: options.email,
        kdfParams: options.kdf,
        accountCryptographicState:
          options.accountCryptographicState as Sdk.WrappedAccountCryptographicState,
        method:
          options.unlock.kind === "password"
            ? {
                masterPasswordUnlock: {
                  password: options.unlock.password,
                  master_password_unlock: options.unlock
                    .masterPasswordUnlock as Sdk.MasterPasswordUnlockData,
                },
              }
            : { decryptedKey: { decrypted_user_key: options.unlock.userKey } },
        // Never pass upgradeToken: it can change V1 account cryptography.
      });
    } catch (error) {
      // Only on this failure path, unwrap the user key alone: when that fails too, the
      // password is wrong; otherwise the account's own state did not initialize.
      if (options.unlock.kind === "password" && !masterPasswordOpens(sdk, options.unlock)) {
        dispose();
        return decryptFailure("master-password");
      }
      throw error;
    }
    let securityVersion: 1 | 2 = 1;
    const unopenedOrganizations = new Set<string>();
    if (accountVersion === "v1" || organizationKeys.size > 0) {
      // Upstream V1 initialization tolerates an invalid private key. Our session does not.
      const storedKey = memory.values.get("user_key");
      if (typeof storedKey !== "string") throw new Error();
      const userKey = bytesFromBase64(storedKey);
      let privateKey: Uint8Array | undefined;
      try {
        privateKey = sdk.PureCrypto.unwrap_decapsulation_key(
          "V1" in account ? account.V1.private_key : account.V2.private_key,
          userKey,
        );
        // Parse/decapsulate shared keys synchronously before the SDK's async serde boundary.
        // An organization key that does not open leaves out only that organization's items
        // and collections, as for one whose key was not received (ADR 0006).
        for (const [organizationId, key] of organizationKeys) {
          try {
            const decryptedOrganizationKey = sdk.PureCrypto.decapsulate_key_unsigned(
              key,
              privateKey,
            );
            decryptedOrganizationKey.fill(0);
          } catch {
            organizationKeys.delete(organizationId);
            unopenedOrganizations.add(organizationId);
          }
        }
      } finally {
        userKey.fill(0);
        privateKey?.fill(0);
      }
    }
    if ("V2" in account) {
      // initialize_user_crypto succeeded, so the SDK verified this exact security state with the
      // account's signing key. It exports no accessor for the version, so read the verified payload.
      const version = verifiedSecurityStateVersion(bytesFromBase64(account.V2.security_state));
      if (version !== 1 && version !== 2) {
        dispose();
        return failure("unsupported-crypto");
      }
      securityVersion = version;
    }
    if (securityVersion < (options.minimumSecurityVersion ?? 1)) {
      dispose();
      return failure("security-downgrade");
    }
    if (organizationKeys.size > 0)
      await crypto.initialize_org_crypto({
        organizationKeys:
          organizationKeys as unknown as Sdk.InitOrgCryptoRequest["organizationKeys"],
      });
    const vault = client.vault();
    handles.push(vault);
    const ciphers = vault.ciphers();
    handles.push(ciphers);
    const metadata = Object.freeze({
      connectionId: options.connectionId,
      userId: options.userId,
      accountVersion,
      securityVersion,
    });
    // Do not retain the parsed password/account input in operation closures.
    const connectionId = options.connectionId;
    const knownOrganizations = new Set(organizationKeys.keys());
    organizationKeys.clear();

    const decrypt = async (
      request: unknown,
      passkeys: "decrypt" | "omit" = "decrypt",
    ): Promise<BitwardenResult<Sdk.CipherView>> => {
      if (locked) return failure("crypto-locked");
      const checked = parsed(decryptSchema, request);
      if (!checked) return failure("invalid-crypto-input");
      if (checked.connectionId !== connectionId) return failure("connection-mismatch");
      const admittedCipher = checked.cipher;
      // Strict decryption also decrypts each separately encrypted legacy passkey. Outside the
      // passkey operations, leave them out so one unreadable passkey affects only passkey use.
      const cipher =
        passkeys === "omit" && admittedCipher.login?.fido2Credentials
          ? { ...admittedCipher, login: { ...admittedCipher.login, fido2Credentials: null } }
          : admittedCipher;
      if (cipher.organizationId && unopenedOrganizations.has(cipher.organizationId))
        return decryptFailure("organization-key");
      if (cipher.organizationId && !knownOrganizations.has(cipher.organizationId))
        return decryptFailure("unknown-organization");
      const admitted = admitLocalCryptoCipher(admittedCipher);
      if (!admitted.ok) return admitted;
      pendingCalls += 1;
      try {
        const view = await ciphers.decrypt(cipher as unknown as Sdk.Cipher);
        if (locked) return failure("crypto-locked");
        // Admission refuses server-restricted ciphers; a partial view withholds its secrets.
        if (view.partial) return failure("unsupported-crypto");
        if (view.attachmentDecryptionFailures?.length) return decryptFailure("attachment");
        // The SDK leaves out a URI whose checksum it refuses and uses the rest of the item,
        // as the official clients do (ADR 0005); a legacy item's URIs are used unchecked.
        const rawLogin = cipher["login"];
        // Strict decryption fails on any unreadable passkey; never accept a view that dropped one.
        if (
          rawLogin &&
          typeof rawLogin === "object" &&
          "fido2Credentials" in rawLogin &&
          Array.isArray(rawLogin.fido2Credentials) &&
          rawLogin.fido2Credentials.length !== (view.login?.fido2Credentials?.length ?? 0)
        )
          return decryptFailure("passkey-dropped");
        if (locked) return failure("crypto-locked");
        return { ok: true, data: view };
      } catch {
        return locked ? failure("crypto-locked") : decryptFailure("sdk-decrypt");
      } finally {
        pendingCalls -= 1;
        if (locked && pendingCalls === 0) releaseHandles();
      }
    };
    return {
      ok: true,
      data: Object.freeze({
        metadata,
        exportUnlockMaterial: () => {
          if (locked) return failure("crypto-locked");
          const userKey = memory.values.get("user_key");
          if (typeof userKey !== "string" || userKey.length === 0) return failure("crypto-failed");
          // The bridge value is the pinned SDK's unchanged serialized user key.
          // No password, master key, private key bundle or network API is exported.
          return { ok: true as const, data: { userKey, metadata } };
        },
        verifyMasterPassword: (request: unknown) => {
          if (locked) return failure("crypto-locked");
          const checked = parsed(verifyPasswordSchema, request);
          if (!checked) return failure("invalid-crypto-input");
          const unlock = checked.masterPasswordUnlock;
          if (!withinResourceBudget(unlock.kdf)) return failure("resource-limit");
          // Below the SDK's own minimums it throws for any password; that is not a wrong one.
          if (belowSdkMinimum(unlock.kdf)) return failure("invalid-crypto-input");
          if (!authenticatedCiphertext(unlock.masterKeyWrappedUserKey))
            return failure("unsupported-crypto");
          const storedKey = memory.values.get("user_key");
          if (typeof storedKey !== "string" || storedKey.length === 0)
            return failure("crypto-failed");
          let expected: Uint8Array | undefined;
          let unwrapped: Uint8Array | undefined;
          try {
            expected = bytesFromBase64(storedKey);
            try {
              unwrapped = sdk.PureCrypto.decrypt_user_key_with_master_password(
                unlock.masterKeyWrappedUserKey,
                checked.password,
                unlock.salt,
                unlock.kdf,
              );
            } catch {
              // The wrapped key and KDF passed admission, so the unwrap's authentication
              // failing is what remains: a wrong password.
              return { ok: true as const, data: { matches: false } };
            }
            return { ok: true as const, data: { matches: sameBytes(expected, unwrapped) } };
          } catch {
            return failure("crypto-failed");
          } finally {
            expected?.fill(0);
            unwrapped?.fill(0);
          }
        },
        decryptCipher: async (request: unknown): Promise<BitwardenResult<LocalCipherView>> => {
          const decrypted = await decrypt(request, "omit");
          if (!decrypted.ok) return decrypted;
          const { key: _cipherKey, login, attachments, ...view } = decrypted.data;
          return {
            ok: true,
            data: {
              ...view,
              login: login && {
                ...login,
                // Sealed-blob ciphers still carry their passkeys inside the authenticated blob.
                fido2Credentials: login.fido2Credentials?.map(passkeyMetadata),
              },
              attachments: attachments?.map(({ key: _attachmentKey, ...attachment }) => attachment),
            },
          };
        },
        decryptCatalogGroups: async (contextInput: unknown) => {
          if (locked) return failure("crypto-locked");
          let checked: v.SafeParseResult<typeof encryptedCatalogContextSchema>;
          try {
            checked = v.safeParse(encryptedCatalogContextSchema, structuredClone(contextInput));
          } catch {
            return failure("invalid-crypto-input");
          }
          if (!checked.success) return failure("invalid-crypto-input");
          const output: { id: string; label: string; kind: "folder" | "collection" }[] = [];
          const ids = new Set<string>();
          pendingCalls += 1;
          const folders = vault.folders();
          const collections = client.collections();
          try {
            for (const [kind, groups] of [
              ["folder", checked.output.folders],
              ["collection", checked.output.collections],
            ] as const) {
              for (const group of groups) {
                const id = group.id.toLowerCase();
                if (ids.has(id)) return failure("invalid-crypto-input");
                ids.add(id);
                // A collection of an organization whose key did not open is left out.
                if (
                  kind === "collection" &&
                  "organizationId" in group &&
                  unopenedOrganizations.has(group.organizationId.toLowerCase())
                )
                  continue;
                // Folder::decrypt swallows name errors. Verify the same authenticated
                // name with strict SDK cipher decryption before using its group view.
                // eslint-disable-next-line no-await-in-loop
                const authenticated = await decrypt({
                  connectionId,
                  cipher: {
                    id,
                    type: 2,
                    name: group.name,
                    collectionIds: [],
                    favorite: false,
                    reprompt: 0,
                    organizationUseTotp: false,
                    edit: false,
                    viewPassword: false,
                    creationDate: "1970-01-01T00:00:00Z",
                    revisionDate: "1970-01-01T00:00:00Z",
                    secureNote: { type: 0 },
                    ...(kind === "collection" && "organizationId" in group
                      ? { organizationId: group.organizationId }
                      : {}),
                  },
                });
                if (!authenticated.ok)
                  return authenticated.error.code === "crypto-failed"
                    ? decryptFailure(kind)
                    : authenticated;
                const view =
                  kind === "folder"
                    ? folders.decrypt(group as unknown as Sdk.Folder)
                    : collections.decrypt(group as unknown as Sdk.Collection);
                output.push({ id, label: (view.name || id).slice(0, 200), kind });
              }
            }
            return locked ? failure("crypto-locked") : { ok: true as const, data: output };
          } catch {
            return locked ? failure("crypto-locked") : decryptFailure("catalog");
          } finally {
            folders.free();
            collections.free();
            pendingCalls -= 1;
            if (locked && pendingCalls === 0) releaseHandles();
          }
        },
        decryptFido2Credentials: async (
          request: unknown,
        ): Promise<BitwardenResult<LocalFido2CredentialMetadata[]>> => {
          const decrypted = await decrypt(request);
          if (!decrypted.ok) return decrypted;
          if (locked) return failure("crypto-locked");
          return {
            ok: true,
            data: (decrypted.data.login?.fido2Credentials ?? []).map(passkeyMetadata),
          };
        },
        decryptFido2PrivateKey: async (request: unknown): Promise<BitwardenResult<string>> => {
          const decrypted = await decrypt(request);
          if (!decrypted.ok) return decrypted;
          if (locked) return failure("crypto-locked");
          // Official clients use the first key. Require a unique credential instead of choosing one.
          const credentials = decrypted.data.login?.fido2Credentials;
          if (credentials?.length !== 1) return failure("unsupported-crypto");
          const keyValue = credentials[0]?.keyValue;
          return typeof keyValue === "string" && keyValue.length > 0
            ? { ok: true, data: keyValue }
            : failure("crypto-failed");
        },
        dispose,
      }),
    };
  } catch {
    dispose();
    return decryptFailure("session-open");
  }
}
