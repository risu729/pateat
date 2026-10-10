import * as v from "valibot";

import { failure, type BitwardenResult } from "./errors";

/** Secret-free metadata for one stored passkey. The private key stays encrypted in the item. */
export interface LocalPasskeyCredential {
  readonly connectionId: string;
  readonly userId: string;
  readonly snapshotId: string;
  readonly itemId: string;
  /** Raw credential ID bytes as unpadded base64url. */
  readonly credentialId: string;
  readonly rpId: string;
  /** Raw user handle bytes as unpadded base64url, when stored. */
  readonly userHandle: string | null;
  readonly discoverable: boolean;
  readonly counter: number;
}

const identifier = v.pipe(v.string(), v.minLength(1), v.maxLength(128));
const uuid = v.pipe(
  v.string(),
  v.uuid(),
  v.transform((value) => value.toLowerCase()),
);
const text = v.pipe(v.string(), v.minLength(1), v.maxLength(1_048_576));
const optionalText = v.nullish(v.pipe(v.string(), v.maxLength(1_048_576)));
// Decrypted SDK Fido2CredentialView. keyValue remains an EncString and is never decoded here.
const viewSchema = v.object({
  credentialId: text,
  keyType: text,
  keyAlgorithm: text,
  keyCurve: text,
  keyValue: text,
  rpId: text,
  userHandle: optionalText,
  counter: text,
  discoverable: text,
});
const inputSchema = v.strictObject({
  connectionId: identifier,
  userId: uuid,
  snapshotId: uuid,
  itemId: uuid,
  credentials: v.pipe(v.array(v.unknown()), v.maxLength(1000)),
});
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
// RP IDs are stored as the canonical ASCII host they were registered with.
const rpIdPattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const MAX_COUNTER = 0xff_ff_ff_ff;
// WebAuthn limits: credential IDs to 1023 bytes, user handles to 64 bytes.
const MAX_CREDENTIAL_ID_BYTES = 1023;
const MAX_USER_HANDLE_BYTES = 64;

/**
 * Decode Bitwarden's base64 storage. Its client accepts both URL-safe and standard alphabets with
 * optional padding; mixed alphabets, bad padding and non-canonical trailing bits are rejected.
 */
export function decodeBitwardenBase64(value: string): Uint8Array | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_400_000) return undefined;
  const urlSafe = /[-_]/u.test(value);
  if (urlSafe && /[+/]/u.test(value)) return undefined;
  const body = value.replace(/=+$/u, "");
  const padding = value.length - body.length;
  if (padding > 0 && (padding > 2 || value.length % 4 !== 0)) return undefined;
  if (!/^[A-Za-z0-9+/_-]*$/u.test(body) || body.length % 4 === 1) return undefined;
  const standard = body.replace(/-/gu, "+").replace(/_/gu, "/");
  try {
    const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    if (encodeBase64Url(bytes) !== body.replace(/\+/gu, "-").replace(/\//gu, "_")) return undefined;
    return bytes;
  } catch {
    return undefined;
  }
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** Bitwarden credential IDs: a GUID for 16 raw bytes, or `b64.` plus base64url bytes. */
export function decodeBitwardenCredentialId(value: string): Uint8Array | undefined {
  if (typeof value !== "string") return undefined;
  if (value.startsWith("b64.")) {
    const bytes = decodeBitwardenBase64(value.slice(4));
    return bytes && bytes.length <= MAX_CREDENTIAL_ID_BYTES ? bytes : undefined;
  }
  if (!guid.test(value)) return undefined;
  const hex = value.replace(/-/gu, "");
  return Uint8Array.from({ length: 16 }, (_, index) =>
    Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16),
  );
}

/**
 * Map an item's decrypted FIDO2 credential views into strict metadata. The pinned Bitwarden client
 * and SDK private-key accessor use only the first credential, so an item with several is rejected
 * rather than choosing one. A nonzero counter is preserved for the caller to refuse explicitly.
 */
export function mapLocalPasskeyCredentials(
  input: unknown,
): BitwardenResult<readonly LocalPasskeyCredential[]> {
  try {
    const scope = v.safeParse(inputSchema, input);
    if (!scope.success) return failure("invalid-crypto-input");
    const { credentials, ...binding } = scope.output;
    if (credentials.length === 0) return { ok: true, data: Object.freeze([]) };
    if (credentials.length > 1) return failure("unsupported-crypto");
    const view = v.safeParse(viewSchema, credentials[0]);
    if (!view.success) return failure("invalid-crypto-input");
    const credential = view.output;
    if (
      credential.keyType !== "public-key" ||
      credential.keyAlgorithm !== "ECDSA" ||
      credential.keyCurve !== "P-256"
    )
      return failure("unsupported-crypto");
    const credentialId = decodeBitwardenCredentialId(credential.credentialId);
    if (!credentialId) return failure("unsupported-crypto");
    if (!rpIdPattern.test(credential.rpId)) return failure("unsupported-crypto");
    if (credential.discoverable !== "true" && credential.discoverable !== "false")
      return failure("unsupported-crypto");
    if (!/^(?:0|[1-9][0-9]{0,9})$/u.test(credential.counter)) return failure("unsupported-crypto");
    const counter = Number(credential.counter);
    if (counter > MAX_COUNTER) return failure("unsupported-crypto");
    let userHandle: string | null = null;
    if (credential.userHandle != null && credential.userHandle !== "") {
      const bytes = decodeBitwardenBase64(credential.userHandle);
      if (!bytes || bytes.length > MAX_USER_HANDLE_BYTES) return failure("unsupported-crypto");
      userHandle = encodeBase64Url(bytes);
    }
    const discoverable = credential.discoverable === "true";
    // A discoverable credential is returned without an allow list and must identify its account.
    if (discoverable && userHandle === null) return failure("unsupported-crypto");
    return {
      ok: true,
      data: Object.freeze([
        Object.freeze({
          ...binding,
          credentialId: encodeBase64Url(credentialId),
          rpId: credential.rpId,
          userHandle,
          discoverable,
          counter,
        }),
      ]),
    };
  } catch {
    return failure("invalid-crypto-input");
  }
}

/** Decode the SDK-decrypted PKCS #8 private key for import inside the signing worker only. */
export function decodeLocalPasskeyPrivateKey(value: unknown): BitwardenResult<Uint8Array> {
  if (typeof value !== "string") return failure("invalid-crypto-input");
  const bytes = decodeBitwardenBase64(value);
  // A P-256 PKCS #8 key is a DER SEQUENCE of roughly 67 to 138 bytes.
  if (!bytes || bytes.length < 64 || bytes.length > 256 || bytes[0] !== 0x30)
    return failure("unsupported-crypto");
  return { ok: true, data: bytes };
}
