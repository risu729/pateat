import type * as Sdk from "@bitwarden/sdk-internal";
import * as v from "valibot";

import { normalizeBitwardenProfile, type BitwardenProfile } from "./environment";
import { failure, type BitwardenErrorCode, type BitwardenResult } from "./errors";
import { admitLocalCryptoCipher } from "./local-crypto";
import { encryptedSyncEnvelopeSchema } from "./models";

type RecordValue = Record<string, unknown>;
const uuid = v.pipe(
  v.string(),
  v.uuid(),
  v.transform((value) => value.toLowerCase()),
);
const email = v.pipe(v.string(), v.minLength(1), v.maxLength(320), v.email());
const bindingSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("bootstrap"), email }),
  v.strictObject({
    kind: v.literal("known"),
    profile: v.unknown(),
    email,
    userId: uuid,
    accountVersion: v.picklist(["v1", "v2"]),
    minimumSecurityVersion: v.picklist([1, 2]),
  }),
]);
export type BitwardenAccountBinding =
  | { kind: "bootstrap"; email: string }
  | {
      kind: "known";
      profile: BitwardenProfile;
      email: string;
      userId: string;
      accountVersion: "v1" | "v2";
      /** Previously verified by local crypto, never read from unsigned profile metadata. */
      minimumSecurityVersion: 1 | 2;
    };
export type PreparedBitwardenAccount = {
  binding: {
    profile: BitwardenProfile;
    userId: string;
    email: string;
    accountVersion: "v1" | "v2";
  };
  accountCryptographicState: Sdk.WrappedAccountCryptographicState;
  /** This local-only session context uses the UNLOCK KDF, not the authentication prelogin KDF. */
  kdf: Sdk.Kdf;
  masterPasswordUnlock: Sdk.MasterPasswordUnlockData;
  organizationKeys: { organizationId: string; key: string }[];
  ciphers: Sdk.Cipher[];
  unavailableItems: { itemId: string; reason: "unsupported-cipher-type" }[];
  minimumSecurityVersion: 1 | 2;
  coverage: "received-envelope";
};
export interface BitwardenAccountMapper {
  readonly profile: BitwardenProfile;
  /** Only call with results obtained by the trusted host's fixed provider transport.
   * JWT decoding correlates those responses; it performs no signature verification.
   * Success is preparation, not an unlocked account or usable/authoritative cache.
   */
  map(input: unknown): BitwardenResult<PreparedBitwardenAccount>;
}

class AdmissionFailure extends Error {
  readonly code: BitwardenErrorCode;
  constructor(code: BitwardenErrorCode = "invalid-response") {
    super();
    this.code = code;
  }
}
function reject(code?: BitwardenErrorCode): never {
  throw new AdmissionFailure(code);
}
function record(input: unknown): RecordValue {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  )
    reject();
  return input as RecordValue;
}
function same(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((entry, i) => same(entry, b[i]));
  if (a && b && typeof a === "object" && typeof b === "object") {
    const left = Object.keys(a)
      .filter((key) => (a as RecordValue)[key] !== undefined)
      .sort();
    const right = Object.keys(b)
      .filter((key) => (b as RecordValue)[key] !== undefined)
      .sort();
    return (
      same(left, right) &&
      left.every((key) => same((a as RecordValue)[key], (b as RecordValue)[key]))
    );
  }
  return a === b;
}
function read(value: RecordValue, name: string): unknown {
  const pascal = name === "sshKey" ? "SSHKey" : name[0]!.toUpperCase() + name.slice(1);
  if (
    Object.hasOwn(value, name) &&
    Object.hasOwn(value, pascal) &&
    !same(value[name], value[pascal])
  )
    reject();
  return Object.hasOwn(value, name) ? value[name] : value[pascal];
}
function requiredText(input: unknown, max = 1_048_576): string {
  if (typeof input !== "string" || !input || input.length > max || /[\uD800-\uDFFF]/u.test(input))
    reject();
  return input;
}
function identifier(input: unknown): string {
  const parsed = v.safeParse(uuid, input);
  if (!parsed.success) reject();
  return parsed.output;
}
function normalizedEmail(input: unknown): string {
  const parsed = v.safeParse(email, input);
  if (!parsed.success) reject();
  return parsed.output.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "").toLowerCase();
}
function list(input: unknown, maximum = 10_000): unknown[] {
  if (!Array.isArray(input) || input.length > maximum) reject();
  return input;
}
function optionalList(input: unknown, maximum = 10_000): unknown[] {
  return input == null ? [] : list(input, maximum);
}
function canonicalBase64(input: unknown): string {
  const value = requiredText(input);
  try {
    if (btoa(atob(value)) !== value) reject();
  } catch {
    reject();
  }
  return value;
}
function encrypted(input: unknown, formats = [2, 7]): Sdk.EncString {
  const value = requiredText(input);
  if (!formats.includes(Number(value[0])) || value[1] !== ".") reject("unsupported-crypto");
  const parts = value.slice(2).split("|").map(canonicalBase64);
  const lengths = parts.map((part) => atob(part).length);
  if (
    value[0] === "2" &&
    (lengths.length !== 3 ||
      lengths[0] !== 16 ||
      !lengths[1] ||
      lengths[1] % 16 !== 0 ||
      lengths[2] !== 32)
  )
    reject();
  if (value[0] === "7" && (lengths.length !== 1 || !lengths[0])) reject();
  if ((value[0] === "3" || value[0] === "4") && (lengths.length !== 1 || lengths[0] !== 256))
    reject();
  // A DTO representation brand only. The local session still authenticates ciphertext.
  return value as Sdk.EncString;
}
function integer(input: unknown): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 4_294_967_295)
    reject();
  return input;
}
function kdf(input: unknown): Sdk.Kdf {
  const value = record(input);
  const type = read(value, "kdfType");
  const iterations = integer(read(value, "iterations"));
  if (type === 0) return { pBKDF2: { iterations } };
  if (type === 1)
    return {
      argon2id: {
        iterations,
        memory: integer(read(value, "memory")),
        parallelism: integer(read(value, "parallelism")),
      },
    };
  reject("unsupported-crypto");
}
function containedId(input: unknown): Sdk.KeyId | undefined {
  if (input == null) return undefined;
  if (typeof input !== "string" || !/^[0-9a-f]{32}$/iu.test(input)) reject();
  return input.toLowerCase() as Sdk.KeyId;
}
function modernUnlock(input: unknown): Sdk.MasterPasswordUnlockData {
  const value = record(input);
  const containedKeyId = containedId(read(value, "containedKeyId"));
  return {
    kdf: kdf(read(value, "kdf")),
    masterKeyWrappedUserKey: encrypted(read(value, "masterKeyEncryptedUserKey")),
    salt: requiredText(read(value, "salt"), 320),
    ...(containedKeyId ? { containedKeyId } : {}),
  };
}
function accountKeys(input: unknown): Sdk.WrappedAccountCryptographicState {
  const value = record(input);
  const pair = record(read(value, "publicKeyEncryptionKeyPair"));
  canonicalBase64(read(pair, "publicKey"));
  const privateKey = encrypted(read(pair, "wrappedPrivateKey"));
  const signature = read(value, "signatureKeyPair");
  const state = read(value, "securityState");
  if (privateKey.startsWith("7.")) {
    const signing = record(signature);
    const security = record(state);
    canonicalBase64(read(signing, "verifyingKey"));
    // Pinned SDK permits an absent signed public key for older sync responses.
    const signedPublicKey = read(pair, "signedPublicKey");
    return {
      V2: {
        private_key: privateKey,
        signing_key: encrypted(read(signing, "wrappedSigningKey")),
        signed_public_key:
          signedPublicKey == null
            ? undefined
            : (canonicalBase64(signedPublicKey) as Sdk.SignedPublicKey),
        security_state: canonicalBase64(read(security, "securityState")),
      },
    };
  }
  if (signature != null || state != null || read(pair, "signedPublicKey") != null) reject();
  return { V1: { private_key: privateKey } };
}
function sameAccountState(
  a: Sdk.WrappedAccountCryptographicState,
  b: Sdk.WrappedAccountCryptographicState,
): boolean {
  if ("V2" in a && "V2" in b) {
    const { signed_public_key: left, ...leftRequired } = a.V2;
    const { signed_public_key: right, ...rightRequired } = b.V2;
    return same(leftRequired, rightRequired) && (left == null || right == null || left === right);
  }
  return same(a, b);
}
function accountFromProfile(profile: RecordValue): Sdk.WrappedAccountCryptographicState {
  const modern = read(profile, "accountKeys");
  const state =
    modern == null
      ? { V1: { private_key: encrypted(read(profile, "privateKey")) } }
      : accountKeys(modern);
  const legacy = read(profile, "privateKey");
  const privateKey = "V1" in state ? state.V1.private_key : state.V2.private_key;
  if (legacy != null && legacy !== privateKey) reject();
  // No modern state means an explicitly legacy AES private key, never a stripped COSE account.
  if (modern == null && privateKey.startsWith("7.")) reject();
  return state;
}
function tokenClaims(token: unknown, now: number): RecordValue {
  const value = requiredText(token, 16384);
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) reject();
  const decode = (part: string) => {
    const padding = "=".repeat((4 - (part.length % 4)) % 4);
    const bytes = atob(part.replace(/-/g, "+").replace(/_/g, "/") + padding);
    if (btoa(bytes).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") !== part) reject();
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(bytes, (c) => c.charCodeAt(0)),
    );
  };
  record(JSON.parse(decode(parts[0]!)));
  const claims = record(JSON.parse(decode(parts[1]!)));
  const exp = integer(claims["exp"]);
  if (exp <= now) reject("authentication-expired");
  for (const name of ["nbf", "iat"]) {
    if (
      claims[name] != null &&
      (typeof claims[name] !== "number" || !Number.isInteger(claims[name]) || claims[name] < 0)
    )
      reject();
  }
  if (typeof claims["nbf"] === "number" && claims["nbf"] > now) reject("authentication-expired");
  if (claims["iss"] != null) requiredText(claims["iss"], 2048);
  if (claims["aud"] != null) {
    const values = typeof claims["aud"] === "string" ? [claims["aud"]] : list(claims["aud"], 100);
    if (!values.length) reject();
    values.forEach((entry) => requiredText(entry, 2048));
  }
  return claims;
}

// Only known casing aliases are normalized. Inner unknown members remain for strict SDK DTO admission.
function camelRecord(input: unknown): RecordValue {
  const value = record(input);
  const output: RecordValue = {};
  for (const [key, entry] of Object.entries(value)) {
    // Reject rather than assign keys that change prototypes or bypass Valibot's key admission.
    if (["__proto__", "prototype", "constructor"].includes(key)) reject();
    const name = key === "SSHKey" ? "sshKey" : key[0]!.toLowerCase() + key.slice(1);
    if (Object.hasOwn(output, name) && !same(output[name], entry)) reject();
    output[name] = entry;
  }
  return output;
}
function inner(input: unknown): unknown {
  if (input == null) return input;
  if (Array.isArray(input)) return input.map(inner);
  if (typeof input !== "object") return input;
  const result = camelRecord(input);
  for (const key of Object.keys(result)) result[key] = inner(result[key]);
  return result;
}
function login(input: unknown): unknown {
  if (input == null) return input;
  const result = record(inner(input));
  const uri = result["uri"];
  if (uri != null) {
    const uris = optionalList(result["uris"]);
    if (uris.length && read(record(uris[0]), "uri") !== uri) reject();
    if (!uris.length) result["uris"] = [{ uri, match: null, uriChecksum: null }];
  }
  delete result["uri"];
  return result;
}
const kinds = ["login", "secureNote", "card", "identity"] as const;
const subtypeFields: Record<string, readonly string[]> = {
  login: [
    "username",
    "password",
    "passwordRevisionDate",
    "uri",
    "uris",
    "totp",
    "autofillOnPageLoad",
    "fido2Credentials",
  ],
  secureNote: ["type"],
  card: ["cardholderName", "expMonth", "expYear", "code", "brand", "number"],
  identity: [
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
  ],
};
function cipherDto(input: RecordValue, type: number, itemId: string): Sdk.Cipher {
  if (read(input, "partialData") != null) reject("unsupported-crypto");
  const kind = kinds[type - 1]!;
  const output: RecordValue = { id: itemId, type };
  for (const name of [
    "organizationId",
    "folderId",
    "key",
    "name",
    "notes",
    "favorite",
    "reprompt",
    "organizationUseTotp",
    "edit",
    "viewPassword",
    "permissions",
    "attachments",
    "fields",
    "passwordHistory",
    "creationDate",
    "revisionDate",
    "deletedDate",
    "archivedDate",
  ]) {
    const value = read(input, name);
    if (value !== undefined) output[name] = inner(value);
  }
  for (const name of ["organizationId", "folderId"])
    if (output[name] != null) output[name] = identifier(output[name]);
  output["collectionIds"] = optionalList(read(input, "collectionIds")).map(identifier);
  if (
    new Set(output["collectionIds"] as string[]).size !==
    (output["collectionIds"] as string[]).length
  )
    reject();
  for (const other of [...kinds, "sshKey", "bankAccount", "driversLicense", "passport"]) {
    const value = read(input, other);
    if (other !== kind && value != null) reject();
    if (other === kind && value != null)
      output[kind] = kind === "login" ? login(value) : inner(value);
  }
  const rawData = read(input, "data");
  if (rawData != null) {
    const encoded = requiredText(rawData);
    const data = record(JSON.parse(encoded));
    if (
      Object.hasOwn(data, "format_version") ||
      Object.hasOwn(data, "wrapped_cek") ||
      Object.hasOwn(data, "envelope")
    ) {
      // A claimed blob cannot fall back to redundant field-level values.
      if (
        ["name", "notes", "fields", "passwordHistory", ...kinds].some((key) => output[key] != null)
      )
        reject();
      output["data"] = encoded;
    } else {
      const flat = record(inner(data));
      const allowed = new Set([
        "name",
        "notes",
        "fields",
        "passwordHistory",
        ...subtypeFields[kind]!,
      ]);
      if (Object.keys(flat).some((key) => !allowed.has(key)) || !Object.hasOwn(flat, "name"))
        reject("unsupported-crypto");
      const nested: RecordValue = {};
      for (const name of subtypeFields[kind]!)
        if (Object.hasOwn(flat, name)) nested[name] = flat[name];
      const fromData: RecordValue = { [kind]: kind === "login" ? login(nested) : nested };
      for (const name of ["name", "notes", "fields", "passwordHistory"])
        if (Object.hasOwn(flat, name)) fromData[name] = flat[name];
      for (const [name, value] of Object.entries(fromData)) {
        if (Object.hasOwn(output, name) && !same(output[name], value)) reject();
        output[name] = value;
      }
      // Known, checked flat legacy Data is redundant. Never pass it to the sealed-blob gate.
    }
  }
  const admitted = admitLocalCryptoCipher(output);
  if (!admitted.ok)
    reject(
      admitted.error.code === "invalid-crypto-input" ? "invalid-response" : admitted.error.code,
    );
  return admitted.data;
}

/** Fixed provider/account context. No network, passwords, native crypto, migrations or cache writes. */
export function createBitwardenAccountMapper(
  profileInput: unknown,
  bindingInput: unknown,
  options: { nowSeconds?: () => number } = {},
): BitwardenResult<BitwardenAccountMapper> {
  const profile = normalizeBitwardenProfile(profileInput);
  if (!profile.ok) return profile;
  const parsedBinding = v.safeParse(bindingSchema, bindingInput);
  if (!parsedBinding.success) return failure("invalid-request");
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "nowSeconds") ||
    (options.nowSeconds !== undefined && typeof options.nowSeconds !== "function")
  )
    return failure("invalid-options");
  const binding = parsedBinding.output;
  if (binding.kind === "known") {
    const previous = normalizeBitwardenProfile(binding.profile);
    if (!previous.ok || !same(previous.data, profile.data)) return failure("account-mismatch");
  }
  const expectedEmail = binding.email.toLowerCase();
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  return {
    ok: true,
    data: Object.freeze({
      profile: profile.data,
      map(input: unknown): BitwardenResult<PreparedBitwardenAccount> {
        try {
          // Snapshot caller-owned DTOs before consistency checks and never retain them in this mapper.
          const request = record(structuredClone(input));
          if (request["connectionId"] !== profile.data.connectionId)
            return failure("connection-mismatch");
          const authenticated = record(request["authenticated"]);
          if (authenticated["kind"] !== "authenticated") reject("invalid-request");
          const tokens = record(authenticated["tokens"]);
          if (tokens["tokenType"] !== "Bearer") reject();
          integer(tokens["expiresIn"]);
          const now = nowSeconds();
          if (!Number.isSafeInteger(now) || now < 0) reject("invalid-options");
          const claims = tokenClaims(tokens["accessToken"], now);
          const syncResult = v.safeParse(encryptedSyncEnvelopeSchema, request["sync"]);
          if (!syncResult.success) reject();
          const sync = syncResult.output;
          const account = record(sync.profile);
          const userId = identifier(read(account, "id"));
          const actualEmail = normalizedEmail(read(account, "email"));
          if (
            identifier(claims["sub"]) !== userId ||
            normalizedEmail(claims["email"]) !== actualEmail ||
            actualEmail !== expectedEmail ||
            (binding.kind === "known" && binding.userId !== userId)
          )
            reject("account-mismatch");
          const stamp = read(account, "securityStamp");
          if (stamp != null) requiredText(stamp, 200);
          if (claims["sstamp"] != null) {
            const tokenStamp = requiredText(claims["sstamp"], 200);
            if (stamp != null && tokenStamp.toLowerCase() !== (stamp as string).toLowerCase())
              reject("account-mismatch");
          }
          const encryptedAccount = record(authenticated["encryptedAccount"]);
          // Password-reset and key-connector ceremonies are outside ordinary password unlock.
          for (const [source, names] of [
            [account, ["forcePasswordReset", "usesKeyConnector"]],
            [encryptedAccount, ["forcePasswordReset", "apiUseKeyConnector"]],
          ] as const) {
            for (const name of names) {
              const flag = read(source, name);
              if (flag != null && typeof flag !== "boolean") reject();
              if (flag === true) reject("unsupported-unlock");
            }
          }
          const cryptographicState = accountFromProfile(account);
          const accountVersion = "V2" in cryptographicState ? "v2" : "v1";
          if (
            binding.kind === "known" &&
            binding.accountVersion === "v2" &&
            accountVersion !== "v2"
          )
            reject("security-downgrade");
          const tokenKeys = read(encryptedAccount, "accountKeys");
          if (tokenKeys != null) {
            const tokenState = accountKeys(tokenKeys);
            if (!sameAccountState(tokenState, cryptographicState)) reject("account-mismatch");
            // Optional older-sync omission must not discard a present token signature.
            // Retain it so the local SDK verifies every supplied cryptographic statement.
            if (
              "V2" in tokenState &&
              "V2" in cryptographicState &&
              cryptographicState.V2.signed_public_key == null
            )
              cryptographicState.V2.signed_public_key = tokenState.V2.signed_public_key;
          }
          const tokenPrivate = read(encryptedAccount, "privateKey");
          const privateKey =
            "V1" in cryptographicState
              ? cryptographicState.V1.private_key
              : cryptographicState.V2.private_key;
          if (tokenPrivate != null && tokenPrivate !== privateKey) reject("account-mismatch");
          let unlock: Sdk.MasterPasswordUnlockData;
          const userDecryption = sync.userDecryption;
          if (userDecryption != null) {
            const raw = read(userDecryption, "masterPasswordUnlock");
            if (raw == null) reject("unsupported-unlock");
            unlock = modernUnlock(raw);
            const id = containedId(read(userDecryption, "userKeyId"));
            if (id && unlock.containedKeyId && id !== unlock.containedKeyId) reject();
          } else {
            if (accountVersion !== "v1") reject("unsupported-unlock");
            unlock = {
              kdf: kdf({
                kdfType: read(encryptedAccount, "kdf"),
                iterations: read(encryptedAccount, "kdfIterations"),
                memory: read(encryptedAccount, "kdfMemory"),
                parallelism: read(encryptedAccount, "kdfParallelism"),
              }),
              masterKeyWrappedUserKey: encrypted(read(account, "key")),
              salt: actualEmail,
            };
          }
          for (const source of [account, encryptedAccount]) {
            const key = read(source, "key");
            if (key != null && key !== unlock.masterKeyWrappedUserKey) reject("account-mismatch");
          }
          const tokenDecryption = read(encryptedAccount, "userDecryptionOptions");
          if (tokenDecryption != null) {
            const raw = read(record(tokenDecryption), "masterPasswordUnlock");
            if (raw != null && !same(modernUnlock(raw), unlock)) reject("account-mismatch");
          }
          const organizations = new Map<string, string>();
          const organizationIds = new Set<string>();
          for (const raw of optionalList(read(account, "organizations"), 1_000)) {
            const organization = record(raw);
            const id = identifier(read(organization, "id"));
            if (organizationIds.has(id)) reject();
            organizationIds.add(id);
            const enabled = read(organization, "enabled");
            if (typeof enabled !== "boolean") reject();
            const status = read(organization, "status");
            if (status != null && status !== 2) reject();
            const key = read(organization, "key");
            if (enabled && key != null) organizations.set(id, encrypted(key, [3, 4, 7]));
          }
          const ciphers: Sdk.Cipher[] = [];
          const unavailableItems: PreparedBitwardenAccount["unavailableItems"] = [];
          const itemIds = new Set<string>();
          for (const raw of list(sync.ciphers)) {
            const item = record(raw);
            const id = identifier(read(item, "id"));
            if (itemIds.has(id)) reject();
            itemIds.add(id);
            const type = integer(read(item, "type"));
            if (type > 4) {
              for (const name of ["organizationId", "folderId"])
                if (read(item, name) != null) identifier(read(item, name));
              unavailableItems.push({ itemId: id, reason: "unsupported-cipher-type" });
              continue;
            }
            const cipher = cipherDto(item, type, id);
            if (
              cipher.organizationId &&
              !organizations.has(cipher.organizationId as unknown as string)
            )
              reject();
            ciphers.push(cipher);
          }
          return {
            ok: true,
            data: {
              binding: { profile: profile.data, userId, email: actualEmail, accountVersion },
              accountCryptographicState: cryptographicState,
              kdf: unlock.kdf,
              masterPasswordUnlock: unlock,
              organizationKeys: [...organizations].map(([organizationId, key]) => ({
                organizationId,
                key,
              })),
              ciphers,
              unavailableItems,
              minimumSecurityVersion: binding.kind === "known" ? binding.minimumSecurityVersion : 1,
              coverage: "received-envelope",
            },
          };
        } catch (error) {
          return failure(error instanceof AdmissionFailure ? error.code : "invalid-response");
        }
      },
    }),
  };
}
