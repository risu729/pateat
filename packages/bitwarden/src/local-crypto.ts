import type * as Sdk from "@bitwarden/sdk-internal";
import * as v from "valibot";

import { failure, type BitwardenResult } from "./errors";

/** Host binds packaged WASM before calling this factory. No SDK network APIs are exposed. */
export type LocalCryptoSdk = Pick<
  typeof Sdk,
  "PasswordManagerClient" | "ManagedSettingsClient" | "PureCrypto" | "LogLevel" | "init_sdk"
>;

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
  decryptCipher(input: unknown): Promise<BitwardenResult<Sdk.CipherView>>;
  decryptFido2Credentials(input: unknown): Promise<BitwardenResult<Sdk.Fido2CredentialView[]>>;
  decryptFido2PrivateKey(input: unknown): Promise<BitwardenResult<string>>;
  dispose(): void;
}

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(1_048_576));
const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const uuid = v.pipe(v.string(), v.uuid());
const positive = (maximum: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximum));
// Validate the SDK's unsigned integer shape independently of browser resource limits.
const kdfSchema = v.union([
  v.strictObject({ pBKDF2: v.strictObject({ iterations: positive(4_294_967_295) }) }),
  v.strictObject({
    argon2id: v.strictObject({
      iterations: positive(4_294_967_295),
      memory: positive(4_294_967_295),
      parallelism: positive(4_294_967_295),
    }),
  }),
]);
const accountSchema = v.union([
  v.strictObject({ V1: v.strictObject({ private_key: text }) }),
  v.strictObject({
    V2: v.strictObject({
      private_key: text,
      signed_public_key: v.optional(text),
      signing_key: text,
      security_state: text,
    }),
  }),
]);
const masterUnlockSchema = v.strictObject({
  kdf: kdfSchema,
  masterKeyWrappedUserKey: text,
  salt: v.pipe(v.string(), v.minLength(1), v.maxLength(320)),
  containedKeyId: v.optional(
    v.pipe(
      v.string(),
      v.regex(/^[0-9a-f]{32}$/iu),
      v.transform((value) => value.toLowerCase()),
    ),
  ),
});
/** Shared structural admission for offline encrypted context; grants no cryptographic trust. */
export const localCryptoAccountContextSchema = v.strictObject({
  kdf: kdfSchema,
  accountCryptographicState: accountSchema,
  masterPasswordUnlock: masterUnlockSchema,
  organizationKeys: v.pipe(
    v.array(v.strictObject({ organizationId: uuid, key: text })),
    v.maxLength(1_000),
  ),
  minimumSecurityVersion: v.picklist([1, 2]),
});
const sessionSchema = v.strictObject({
  connectionId: identifier,
  userId: uuid,
  email: v.pipe(v.string(), v.minLength(1), v.maxLength(320)),
  kdf: kdfSchema,
  accountCryptographicState: accountSchema,
  unlock: v.union([
    v.strictObject({
      kind: v.literal("password"),
      password: v.pipe(v.string(), v.minLength(1)),
      masterPasswordUnlock: masterUnlockSchema,
    }),
    v.strictObject({ kind: v.literal("decrypted-key"), userKey: text }),
  ]),
  organizationKeys: v.optional(
    v.pipe(v.array(v.strictObject({ organizationId: uuid, key: text })), v.maxLength(1_000)),
  ),
  minimumSecurityVersion: v.optional(v.picklist([1, 2])),
});

const plainRecord = v.pipe(
  v.unknown(),
  v.check(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  ),
);
const nullable = <TSchema extends v.GenericSchema>(schema: TSchema) =>
  v.optional(v.nullable(schema));
const date = v.pipe(
  v.string(),
  v.isoTimestamp(),
  v.check((value) => {
    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
    return day <= days && Number.isFinite(Date.parse(value));
  }),
);
const items = <TSchema extends v.GenericSchema>(schema: TSchema) =>
  nullable(v.pipe(v.array(schema), v.maxLength(10_000)));
const encryptedObject = (names: readonly string[], required: readonly string[] = []) =>
  v.strictObject(
    Object.fromEntries(
      names.map((name) => [name, required.includes(name) ? text : nullable(text)]),
    ),
  );
const fidoSchema = v.strictObject({
  credentialId: text,
  keyType: text,
  keyAlgorithm: text,
  keyCurve: text,
  keyValue: text,
  rpId: text,
  userHandle: nullable(text),
  userName: nullable(text),
  counter: text,
  rpName: nullable(text),
  userDisplayName: nullable(text),
  discoverable: text,
  creationDate: date,
});
const loginSchema = v.strictObject({
  username: nullable(text),
  password: nullable(text),
  passwordRevisionDate: nullable(date),
  uris: items(
    v.strictObject({
      uri: nullable(text),
      match: nullable(v.picklist([0, 1, 2, 3, 4, 5])),
      uriChecksum: nullable(text),
    }),
  ),
  totp: nullable(text),
  autofillOnPageLoad: nullable(v.boolean()),
  fido2Credentials: items(fidoSchema),
});
const fieldSchema = v.strictObject({
  name: nullable(text),
  value: nullable(text),
  type: v.picklist([0, 1, 2, 3]),
  linkedId: nullable(
    v.picklist([
      100, 101, 300, 301, 302, 303, 304, 305, 400, 401, 402, 403, 404, 405, 406, 407, 408, 409, 410,
      411, 412, 413, 414, 415, 416, 417, 418,
    ]),
  ),
});
const cipherSchema = v.intersect([
  plainRecord,
  v.strictObject({
    id: nullable(uuid),
    folderId: nullable(uuid),
    type: v.picklist([1, 2, 3, 4, 5, 6, 7, 8]),
    organizationId: nullable(uuid),
    key: nullable(text),
    name: nullable(text),
    notes: nullable(text),
    data: nullable(text),
    collectionIds: v.pipe(v.array(uuid), v.maxLength(10_000)),
    login: nullable(loginSchema),
    card: nullable(
      encryptedObject(["cardholderName", "expMonth", "expYear", "code", "brand", "number"]),
    ),
    identity: nullable(
      encryptedObject([
        "title",
        "firstName",
        "middleName",
        "lastName",
        "address1",
        "address2",
        "address3",
        "city",
        "state",
        "postalCode",
        "country",
        "company",
        "email",
        "phone",
        "ssn",
        "username",
        "passportNumber",
        "licenseNumber",
      ]),
    ),
    secureNote: nullable(v.strictObject({ type: v.literal(0) })),
    sshKey: nullable(encryptedObject(["privateKey", "publicKey", "fingerprint"], ["privateKey"])),
    bankAccount: nullable(
      encryptedObject([
        "bankName",
        "nameOnAccount",
        "accountType",
        "accountNumber",
        "routingNumber",
        "branchNumber",
        "pin",
        "swiftCode",
        "iban",
        "bankContactPhone",
      ]),
    ),
    driversLicense: nullable(
      encryptedObject([
        "firstName",
        "middleName",
        "lastName",
        "dateOfBirth",
        "licenseNumber",
        "issuingCountry",
        "issuingState",
        "issueDate",
        "expirationDate",
        "issuingAuthority",
        "licenseClass",
      ]),
    ),
    passport: nullable(
      encryptedObject([
        "surname",
        "givenName",
        "dateOfBirth",
        "sex",
        "birthPlace",
        "nationality",
        "issuingCountry",
        "passportNumber",
        "passportType",
        "nationalIdentificationNumber",
        "issuingAuthority",
        "issueDate",
        "expirationDate",
      ]),
    ),
    favorite: v.boolean(),
    reprompt: v.picklist([0, 1]),
    organizationUseTotp: v.boolean(),
    edit: v.boolean(),
    viewPassword: v.boolean(),
    permissions: nullable(v.strictObject({ delete: v.boolean(), restore: v.boolean() })),
    localData: nullable(
      v.strictObject({ lastUsedDate: nullable(date), lastLaunched: nullable(date) }),
    ),
    attachments: items(
      v.strictObject({
        id: nullable(v.string()),
        url: nullable(v.string()),
        size: nullable(v.string()),
        sizeName: nullable(v.string()),
        fileName: nullable(text),
        key: nullable(text),
      }),
    ),
    fields: items(fieldSchema),
    passwordHistory: items(v.strictObject({ password: text, lastUsedDate: date })),
    creationDate: date,
    revisionDate: date,
    deletedDate: nullable(date),
    archivedDate: nullable(date),
  }),
]);
const decryptSchema = v.strictObject({ connectionId: identifier, cipher: cipherSchema });
const blobSchema = v.strictObject({
  format_version: v.literal(1),
  wrapped_cek: text,
  envelope: text,
});

function authenticatedCiphertext(value: unknown): boolean {
  return value == null || framedEncryption(value, [2, 7]);
}

function framedEncryption(value: unknown, allowed: readonly number[]): boolean {
  if (typeof value !== "string" || !allowed.includes(Number(value[0])) || value[1] !== ".")
    return false;
  try {
    const parts = value.slice(2).split("|");
    const lengths = parts.map((part) => atob(part).length);
    if (value[0] === "2")
      return (
        lengths.length === 3 &&
        lengths[0] === 16 &&
        (lengths[1] ?? 0) > 0 &&
        (lengths[1] ?? 0) % 16 === 0 &&
        lengths[2] === 32
      );
    if (value[0] === "3" || value[0] === "4") return lengths.length === 1 && lengths[0] === 256;
    return lengths.length === 1 && (lengths[0] ?? 0) > 0;
  } catch {
    return false;
  }
}

function supportedEncryptedFields(cipher: Record<string, unknown>): boolean {
  const fields = (value: unknown, names: readonly string[]) => {
    if (value == null) return true;
    if (typeof value !== "object" || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return names.every((name) => authenticatedCiphertext(record[name]));
  };
  const list = (value: unknown, names: readonly string[]) =>
    value == null ||
    (Array.isArray(value) &&
      value.length <= 10_000 &&
      value.every((entry) => fields(entry, names)));
  if (!fields(cipher, ["key", "name", "notes"])) return false;
  for (const kind of [
    "card",
    "identity",
    "sshKey",
    "bankAccount",
    "driversLicense",
    "passport",
  ] as const) {
    const value = cipher[kind];
    if (
      value != null &&
      (typeof value !== "object" ||
        Array.isArray(value) ||
        !Object.values(value).every(authenticatedCiphertext))
    )
      return false;
  }
  if (
    !list(cipher["fields"], ["name", "value"]) ||
    !list(cipher["passwordHistory"], ["password"]) ||
    !list(cipher["attachments"], ["fileName", "key"])
  )
    return false;
  const login = cipher["login"];
  if (!fields(login, ["username", "password", "totp"])) return false;
  if (login != null) {
    const record = login as Record<string, unknown>;
    if (
      !list(record["uris"], ["uri", "uriChecksum"]) ||
      !list(record["fido2Credentials"], [
        "credentialId",
        "keyType",
        "keyAlgorithm",
        "keyCurve",
        "keyValue",
        "rpId",
        "userHandle",
        "userName",
        "counter",
        "rpName",
        "userDisplayName",
        "discoverable",
      ])
    )
      return false;
  }
  return true;
}

function parsed<TSchema extends v.GenericSchema>(
  schema: TSchema,
  input: unknown,
): v.InferOutput<TSchema> | undefined {
  try {
    const result = v.safeParse(schema, input);
    return result.success ? result.output : undefined;
  } catch {
    return undefined;
  }
}

/** Pure DTO admission shared with the provider mapper; no native parsing or decryption. */
export function admitLocalCryptoCipher(input: unknown): BitwardenResult<Sdk.Cipher> {
  const cipher = parsed(cipherSchema, input);
  if (!cipher) return failure("invalid-crypto-input");
  try {
    if (!supportedEncryptedFields(cipher)) return failure("unsupported-crypto");
    // Never let the SDK's legacy fallback reinterpret a claimed sealed blob.
    if (cipher.data != null) {
      const blob = parsed(blobSchema, JSON.parse(cipher.data));
      if (!blob || !authenticatedCiphertext(blob.wrapped_cek)) return failure("unsupported-crypto");
    } else if (!cipher.name) return failure("invalid-crypto-input");
    return { ok: true, data: cipher as unknown as Sdk.Cipher };
  } catch {
    return failure("unsupported-crypto");
  }
}

function bytesFromBase64(value: string): Uint8Array {
  const decoded = atob(value);
  if (btoa(decoded) !== value) throw new Error();
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
}

// Public upstream signing/signed_object.rs test verifying key, not an account key or trust anchor.
// Used only to invoke the SDK's synchronous shared COSE parser before its async serde boundary.
const framingVerifier = new Uint8Array([
  166, 1, 1, 2, 80, 55, 131, 40, 191, 230, 137, 76, 182, 184, 139, 94, 152, 45, 63, 13, 71, 3, 39,
  4, 129, 2, 32, 6, 33, 88, 32, 93, 213, 35, 177, 81, 219, 226, 241, 147, 140, 238, 32, 34, 183,
  213, 107, 227, 92, 75, 84, 208, 47, 198, 80, 18, 188, 172, 145, 184, 154, 26, 170,
]);

function signedFraming(value: string, sdk: LocalCryptoSdk): boolean {
  try {
    const bytes = bytesFromBase64(value);
    try {
      sdk.PureCrypto.verify_and_unwrap_signed_public_key(bytes, framingVerifier);
      return true;
    } catch (error: unknown) {
      // Signature errors occur AFTER the shared SignedObject COSE parse. They grant no trust.
      return (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        "variant" in error &&
        error.name === "CryptoError" &&
        error.variant === "Signature"
      );
    }
  } catch {
    return false;
  }
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
        kdf.argon2id.memory <= 256 &&
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
  if (![...organizationKeys.values()].every((key) => framedEncryption(key, [3, 4, 7])))
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
    if (
      "V2" in account &&
      (!signedFraming(account.V2.security_state, sdk) ||
        (account.V2.signed_public_key !== undefined &&
          !signedFraming(account.V2.signed_public_key, sdk)))
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
    let securityVersion: 1 | 2 = 1;
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
        for (const key of organizationKeys.values()) {
          const decryptedOrganizationKey = sdk.PureCrypto.decapsulate_key_unsigned(key, privateKey);
          decryptedOrganizationKey.fill(0);
        }
      } finally {
        userKey.fill(0);
        privateKey?.fill(0);
      }
    }
    if (accountVersion === "v2") {
      // The pinned helper re-exports/rewraps keys and signs the unchanged VERIFIED security state;
      // it performs no HTTP, version increment or state mutation. Discard every other export.
      const version = crypto.get_v2_rotated_account_keys().securityVersion;
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

    const decrypt = async (request: unknown): Promise<BitwardenResult<Sdk.CipherView>> => {
      if (locked) return failure("crypto-locked");
      const checked = parsed(decryptSchema, request);
      if (!checked) return failure("invalid-crypto-input");
      if (checked.connectionId !== connectionId) return failure("connection-mismatch");
      const cipher = checked.cipher;
      if (cipher.organizationId && !knownOrganizations.has(cipher.organizationId))
        return failure("crypto-failed");
      const admitted = admitLocalCryptoCipher(cipher);
      if (!admitted.ok) return admitted;
      pendingCalls += 1;
      try {
        const view = await ciphers.decrypt(cipher as unknown as Sdk.Cipher);
        if (locked) return failure("crypto-locked");
        if (view.attachmentDecryptionFailures?.length) return failure("crypto-failed");
        // The SDK may remove invalid URI checksums; this boundary rejects partial results.
        const rawLogin = cipher["login"];
        if (
          rawLogin &&
          typeof rawLogin === "object" &&
          "uris" in rawLogin &&
          Array.isArray(rawLogin.uris) &&
          rawLogin.uris.length !== (view.login?.uris?.length ?? 0)
        )
          return failure("crypto-failed");
        // Pinned SDK login.rs hashes the exact UTF-8 URI with SHA-256. Legacy keyless V1 skips
        // checksum enforcement; reject any PROVIDED wrong checksum while preserving absent legacy ones.
        for (const uri of view.login?.uris ?? []) {
          if (uri.uriChecksum == null) continue;
          if (uri.uri == null) return failure("crypto-failed");
          // Keep at most one digest pending; a large vault entry must not fan out native work.
          // eslint-disable-next-line no-await-in-loop
          const digest = await globalThis.crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(uri.uri),
          );
          const hash = new Uint8Array(digest);
          if (btoa(String.fromCharCode(...hash)) !== uri.uriChecksum)
            return failure("crypto-failed");
        }
        if (locked) return failure("crypto-locked");
        return { ok: true, data: view };
      } catch {
        return failure(locked ? "crypto-locked" : "crypto-failed");
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
        decryptCipher: decrypt,
        decryptFido2Credentials: async (
          request: unknown,
        ): Promise<BitwardenResult<Sdk.Fido2CredentialView[]>> => {
          const decrypted = await decrypt(request);
          if (!decrypted.ok) return decrypted;
          if (locked) return failure("crypto-locked");
          try {
            return { ok: true, data: ciphers.decrypt_fido2_credentials(decrypted.data) };
          } catch {
            return failure("crypto-failed");
          }
        },
        decryptFido2PrivateKey: async (request: unknown): Promise<BitwardenResult<string>> => {
          const decrypted = await decrypt(request);
          if (!decrypted.ok) return decrypted;
          if (locked) return failure("crypto-locked");
          // The SDK returns the first key. Require a unique credential instead of choosing one.
          if (decrypted.data.login?.fido2Credentials?.length !== 1)
            return failure("unsupported-crypto");
          try {
            return { ok: true, data: ciphers.decrypt_fido2_private_key(decrypted.data) };
          } catch {
            return failure("crypto-failed");
          }
        },
        dispose,
      }),
    };
  } catch {
    dispose();
    return failure("crypto-failed");
  }
}
