import type * as Sdk from "@bitwarden/sdk-internal";
import * as v from "valibot";
import { failure, type BitwardenResult } from "./errors";

const text = v.pipe(v.string(), v.minLength(1), v.maxLength(1_048_576));
const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const uuid = v.pipe(v.string(), v.uuid());
const positive = (maximum: number) =>
  v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(maximum));
// Validate the SDK's unsigned integer shape independently of browser resource limits.
export const kdfSchema = v.union([
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
      signed_public_key: text,
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
export const verifyPasswordSchema = v.strictObject({
  password: v.pipe(v.string(), v.minLength(1)),
  masterPasswordUnlock: masterUnlockSchema,
});
export const sessionSchema = v.strictObject({
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
  // Temporal reads only a date that exists, such as no February 29 outside a leap year.
  v.check((value) => {
    try {
      Temporal.Instant.from(value);
      return true;
    } catch {
      return false;
    }
  }),
);
const groupEncryption = v.pipe(
  text,
  v.check((value) => authenticatedCiphertext(value)),
);
export const encryptedCatalogContextSchema = v.strictObject({
  folders: v.pipe(
    v.array(v.strictObject({ id: uuid, name: groupEncryption, revisionDate: date })),
    v.maxLength(10000),
  ),
  collections: v.pipe(
    v.array(
      v.strictObject({
        id: uuid,
        organizationId: uuid,
        name: groupEncryption,
        externalId: nullable(v.string()),
        hidePasswords: v.boolean(),
        readOnly: v.boolean(),
        manage: v.boolean(),
        defaultUserCollectionEmail: nullable(v.string()),
        type: v.picklist([0, 1]),
      }),
    ),
    v.maxLength(10000),
  ),
});
// Like Bitwarden's response models, nested cipher objects keep only the keys Pateat reads; the
// SDK and the cache get that copy. Vaultwarden returns the JSON a client stored, keys and all.
const known = <TEntries extends v.ObjectEntries>(entries: TEntries) =>
  v.pipe(plainRecord, v.object(entries));
const items = <TSchema extends v.GenericSchema>(schema: TSchema) =>
  nullable(v.pipe(v.array(schema), v.maxLength(10_000)));
const encryptedObject = (names: readonly string[], required: readonly string[] = []) =>
  known(
    Object.fromEntries(
      names.map((name) => [name, required.includes(name) ? text : nullable(text)]),
    ),
  );
const fidoSchema = known({
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
const loginSchema = known({
  username: nullable(text),
  password: nullable(text),
  passwordRevisionDate: nullable(date),
  uris: items(
    known({
      uri: nullable(text),
      match: nullable(v.picklist([0, 1, 2, 3, 4, 5])),
      uriChecksum: nullable(text),
    }),
  ),
  totp: nullable(text),
  autofillOnPageLoad: nullable(v.boolean()),
  fido2Credentials: items(fidoSchema),
});
const fieldSchema = known({
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
const cipherSchema = v.pipe(
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
    secureNote: nullable(known({ type: v.literal(0) })),
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
    permissions: nullable(known({ delete: v.boolean(), restore: v.boolean() })),
    localData: nullable(known({ lastUsedDate: nullable(date), lastLaunched: nullable(date) })),
    attachments: items(
      known({
        id: nullable(v.string()),
        url: nullable(v.string()),
        size: nullable(v.string()),
        sizeName: nullable(v.string()),
        fileName: nullable(text),
        key: nullable(text),
      }),
    ),
    fields: items(fieldSchema),
    passwordHistory: items(known({ password: text, lastUsedDate: date })),
    creationDate: date,
    revisionDate: date,
    deletedDate: nullable(date),
    archivedDate: nullable(date),
  }),
);
export const decryptSchema = v.strictObject({ connectionId: identifier, cipher: cipherSchema });
const blobSchema = v.strictObject({
  format_version: v.literal(1),
  wrapped_cek: text,
  envelope: text,
});

export function authenticatedCiphertext(value: unknown): boolean {
  return value == null || framedEncryption(value, [2, 7]);
}

export function framedEncryption(value: unknown, allowed: readonly number[]): boolean {
  if (typeof value !== "string" || !allowed.includes(Number(value[0])) || value[1] !== ".")
    return false;
  try {
    const parts = value.slice(2).split("|");
    const lengths = parts.map((part) => Uint8Array.fromBase64(part).length);
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

export function parsed<TSchema extends v.GenericSchema>(
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
