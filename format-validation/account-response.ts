import type * as Sdk from "@bitwarden/sdk-internal";
import * as v from "valibot";
import { decodeBase64, decodeBase64Url } from "./base64";
import { bitwardenEmail } from "./email";
import type { BitwardenErrorCode, BitwardenMismatchCheck } from "./errors";
import { admitLocalCryptoCipher } from "./local-crypto";

export type RecordValue = Record<string, unknown>;
export const uuid = v.pipe(
  v.string(),
  v.uuid(),
  v.transform((value) => value.toLowerCase()),
);
const email = bitwardenEmail;

export class AdmissionFailure extends Error {
  readonly code: BitwardenErrorCode;
  readonly check: BitwardenMismatchCheck | undefined;
  constructor(code: BitwardenErrorCode = "invalid-response", check?: BitwardenMismatchCheck) {
    super();
    this.code = code;
    this.check = check;
  }
}
export function reject(code?: BitwardenErrorCode): never {
  throw new AdmissionFailure(code);
}
export function rejectMismatch(check: BitwardenMismatchCheck): never {
  throw new AdmissionFailure("account-mismatch", check);
}
export function record(input: unknown): RecordValue {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)
  )
    reject();
  return input as RecordValue;
}
export function same(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, i) => same(entry, b[i]))
    );
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
const isoDate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$/;
/** The epoch milliseconds of a server date, or `undefined` for other text. */
function dateMs(text: string): number | undefined {
  if (!isoDate.test(text)) return undefined;
  try {
    return Temporal.Instant.from(text).epochMilliseconds;
  } catch {
    return undefined;
  }
}
/** Server-stored legacy cipher Data omits nulls and may format dates differently from the
 * response model built from it. Present values must still agree. */
function sameStored(a: unknown, b: unknown): boolean {
  if (a == null && b == null) return true;
  if (typeof a === "string" && typeof b === "string") {
    if (a === b) return true;
    const ms = dateMs(a);
    return ms !== undefined && ms === dateMs(b);
  }
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((entry, i) => sameStored(entry, b[i]));
  if (
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    !Array.isArray(a) &&
    !Array.isArray(b)
  ) {
    const keys = (value: object) =>
      Object.keys(value)
        .filter((key) => (value as RecordValue)[key] != null)
        .sort();
    const left = keys(a);
    return (
      same(left, keys(b)) &&
      left.every((key) => sameStored((a as RecordValue)[key], (b as RecordValue)[key]))
    );
  }
  return a === b;
}
export function read(value: RecordValue, name: string): unknown {
  const pascal = name === "sshKey" ? "SSHKey" : name[0]!.toUpperCase() + name.slice(1);
  if (
    Object.hasOwn(value, name) &&
    Object.hasOwn(value, pascal) &&
    !same(value[name], value[pascal])
  )
    reject();
  return Object.hasOwn(value, name) ? value[name] : value[pascal];
}
export function requiredText(input: unknown, max = 1_048_576): string {
  if (typeof input !== "string" || !input || input.length > max || /[\uD800-\uDFFF]/u.test(input))
    reject();
  return input;
}
/** Opaque collection metadata Pateat never reads; the web admin console saves a blank as "". */
export function optionalCollectionText(input: unknown): string | undefined {
  return input == null || input === "" ? undefined : requiredText(input);
}
export function identifier(input: unknown): string {
  const parsed = v.safeParse(uuid, input);
  if (!parsed.success) reject();
  return parsed.output;
}
export function normalizedEmail(input: unknown): string {
  const parsed = v.safeParse(email, input);
  if (!parsed.success) reject();
  return parsed.output.toLowerCase();
}
export function list(input: unknown, maximum = 10_000): unknown[] {
  if (!Array.isArray(input) || input.length > maximum) reject();
  return input;
}
export function optionalList(input: unknown, maximum = 10_000): unknown[] {
  return input == null ? [] : list(input, maximum);
}
export function boolean(input: unknown): boolean {
  if (typeof input !== "boolean") reject();
  return input;
}
function canonicalBase64(input: unknown): string {
  const value = requiredText(input);
  base64Bytes(value);
  return value;
}
function base64Bytes(value: string): Uint8Array {
  return decodeBase64(value) ?? reject();
}
export function encrypted(input: unknown, formats = [2, 7]): Sdk.EncString {
  const value = requiredText(input);
  if (!formats.includes(Number(value[0])) || value[1] !== ".") reject("unsupported-crypto");
  const lengths = value
    .slice(2)
    .split("|")
    .map((part) => base64Bytes(requiredText(part)).length);
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
export function integer(input: unknown): number {
  if (typeof input !== "number" || !Number.isInteger(input) || input < 1 || input > 4_294_967_295)
    reject();
  return input;
}
export function kdf(input: unknown): Sdk.Kdf {
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
/** Bitwarden before 2025.7.0 and Vaultwarden before 1.37.0 send no type: a shared collection. */
export function collectionType(input: unknown): 0 | 1 {
  if (input == null) return 0;
  if (input !== 0 && input !== 1) reject();
  return input;
}
export function containedId(input: unknown): Sdk.KeyId | undefined {
  if (input == null) return undefined;
  if (typeof input !== "string" || !/^[0-9a-f]{32}$/iu.test(input)) reject();
  return input.toLowerCase() as Sdk.KeyId;
}
export function modernUnlock(input: unknown): Sdk.MasterPasswordUnlockData {
  const value = record(input);
  const containedKeyId = containedId(read(value, "containedKeyId"));
  return {
    kdf: kdf(read(value, "kdf")),
    masterKeyWrappedUserKey: encrypted(read(value, "masterKeyEncryptedUserKey")),
    salt: requiredText(read(value, "salt"), 320),
    ...(containedKeyId ? { containedKeyId } : {}),
  };
}
/** The token's copy may omit the contained key ID hint; every present value must still agree. */
export function sameUnlock(a: Sdk.MasterPasswordUnlockData, b: Sdk.MasterPasswordUnlockData): boolean {
  const { containedKeyId: left, ...leftRequired } = a;
  const { containedKeyId: right, ...rightRequired } = b;
  return same(leftRequired, rightRequired) && (left == null || right == null || left === right);
}
type SdkV2State = Extract<Sdk.WrappedAccountCryptographicState, { V2: unknown }>["V2"];
/** One response's account state. Older sync responses omit V2's signed public key. */
type ResponseAccountState =
  | Extract<Sdk.WrappedAccountCryptographicState, { V1: unknown }>
  | {
      V2: Omit<SdkV2State, "signed_public_key"> & {
        signed_public_key: Sdk.SignedPublicKey | undefined;
      };
    };
export function accountKeys(input: unknown): ResponseAccountState {
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
    // Older sync responses omit the signed public key; the token response may still carry it.
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
export function sameAccountState(a: ResponseAccountState, b: ResponseAccountState): boolean {
  if ("V2" in a && "V2" in b) {
    const { signed_public_key: left, ...leftRequired } = a.V2;
    const { signed_public_key: right, ...rightRequired } = b.V2;
    return same(leftRequired, rightRequired) && (left == null || right == null || left === right);
  }
  return same(a, b);
}
export function accountFromProfile(profile: RecordValue): ResponseAccountState {
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
export function tokenClaims(token: unknown, now: number): RecordValue {
  const value = requiredText(token, 16384);
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) reject();
  const decode = (part: string) => {
    const bytes = decodeBase64Url(part);
    if (!bytes) reject();
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  };
  record(JSON.parse(decode(parts[0]!)));
  const claims = record(JSON.parse(decode(parts[1]!)));
  // Like the official clients' TokenService, only exp decides expiry; nbf is the server's issue
  // second and a local clock behind the server must still accept a fresh token.
  const exp = integer(claims["exp"]);
  if (exp <= now) reject("authentication-expired");
  for (const name of ["nbf", "iat"]) {
    if (
      claims[name] != null &&
      (typeof claims[name] !== "number" || !Number.isInteger(claims[name]) || claims[name] < 0)
    )
      reject();
  }
  if (claims["iss"] != null) requiredText(claims["iss"], 2048);
  if (claims["aud"] != null) {
    const values = typeof claims["aud"] === "string" ? [claims["aud"]] : list(claims["aud"], 100);
    if (!values.length) reject();
    values.forEach((entry) => requiredText(entry, 2048));
  }
  return claims;
}

// Only known casing aliases are normalized. Cipher admission drops inner members it does not read.
function camelRecord(input: unknown): RecordValue {
  const value = record(input);
  const output: RecordValue = {};
  for (const [key, entry] of Object.entries(value)) {
    // Reject rather than assign keys that change prototypes or bypass Valibot's key admission.
    if (["__proto__", "prototype", "constructor"].includes(key)) reject();
    const name =
      key === "SSHKey"
        ? "sshKey"
        : key === "SSN"
          ? "ssn"
          : key.charAt(0).toLowerCase() + key.slice(1);
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
export function cipherDto(input: RecordValue, type: number, itemId: string): Sdk.Cipher {
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
  // Every response model carries its type tag; the SDK attachment DTO does not accept it.
  if (Array.isArray(output["attachments"]))
    output["attachments"] = output["attachments"].map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const { object, ...rest } = entry as RecordValue;
      if (object !== undefined && object !== "attachment") reject();
      return rest;
    });
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
      // Keys outside the item's type are ignored, like nested cipher members, but no
      // spelling of a sealed blob's keys is read as legacy fields.
      if (
        !Object.hasOwn(flat, "name") ||
        Object.keys(flat).some((key) =>
          ["formatversion", "wrappedcek", "envelope"].includes(
            key.replaceAll("_", "").toLowerCase(),
          ),
        )
      )
        reject("unsupported-crypto");
      const nested: RecordValue = {};
      for (const name of subtypeFields[kind]!)
        if (Object.hasOwn(flat, name)) nested[name] = flat[name];
      const fromData: RecordValue = { [kind]: kind === "login" ? login(nested) : nested };
      for (const name of ["name", "notes", "fields", "passwordHistory"])
        if (Object.hasOwn(flat, name)) fromData[name] = flat[name];
      const stored: RecordValue = { ...output, ...fromData };
      const compared: string[] = [];
      for (const [name, value] of Object.entries(fromData)) {
        if (Object.hasOwn(output, name) && output[name] != null) compared.push(name);
        else output[name] = value;
      }
      // The response model is authoritative; its stored Data copy must not contradict it.
      // Both are compared as admitted, so keys Pateat does not read differ freely.
      const response = admittedCipher(output);
      // A copy that cannot be admitted contradicts the admitted response.
      const admittedCopy = admitLocalCryptoCipher(stored);
      if (!admittedCopy.ok) reject();
      const responseRecord = response as unknown as RecordValue;
      const copyRecord = admittedCopy.data as unknown as RecordValue;
      if (!compared.every((name) => sameStored(responseRecord[name], copyRecord[name]))) reject();
      // Known, checked flat legacy Data is redundant. Never pass it to the sealed-blob gate.
      return response;
    }
  }
  return admittedCipher(output);
}
function admittedCipher(output: RecordValue): Sdk.Cipher {
  const result = admitLocalCryptoCipher(output);
  if (!result.ok)
    reject(result.error.code === "invalid-crypto-input" ? "invalid-response" : result.error.code);
  return result.data;
}

const uriMatchDefaultsPolicy = 16;
export type OrganizationPolicyContext = {
  enabled: boolean;
  usePolicies?: boolean;
  role?: unknown;
  status?: unknown;
  providerUser: boolean;
};
/** Mirrors the pinned SDK policy filter's default enforcement for UriMatchDefaults:
 * owners, admins and provider users are exempt; missing organization context enforces.
 * The pinned clients then use the first enforced policy; differing values fail closed here.
 */
export function uriMatchDefault(
  policies: readonly unknown[],
  organizations: ReadonlyMap<string, OrganizationPolicyContext>,
): 0 | 1 | 2 | 3 | 4 | 5 | "unavailable" {
  const values = new Set<number>();
  for (const raw of policies) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "unavailable";
    const policy = raw as RecordValue;
    if (read(policy, "type") !== uriMatchDefaultsPolicy) continue;
    const enabled = read(policy, "enabled");
    const organizationId = v.safeParse(uuid, read(policy, "organizationId"));
    if (typeof enabled !== "boolean" || !organizationId.success) return "unavailable";
    if (!enabled) continue;
    const context = organizations.get(organizationId.output);
    if (
      context &&
      (!context.enabled ||
        context.usePolicies === false ||
        context.role === 0 ||
        context.role === 1 ||
        context.providerUser ||
        (context.status != null && context.status !== 1 && context.status !== 2))
    )
      continue;
    const data = read(policy, "data");
    const detection =
      data && typeof data === "object" && !Array.isArray(data)
        ? read(data as RecordValue, "uriMatchDetection")
        : undefined;
    // Invalid or absent policy data falls back to the provider's Domain default, as upstream.
    values.add(
      typeof detection === "number" && [0, 1, 2, 3, 4, 5].includes(detection) ? detection : 0,
    );
  }
  if (values.size > 1) return "unavailable";
  return ([...values][0] ?? 0) as 0 | 1 | 2 | 3 | 4 | 5;
}
