import {
  decodeLocalPasskeyPrivateKey,
  mapLocalPasskeyCredentials,
  type BitwardenResult,
  type LocalCryptoSession,
  type LocalPasskeyCredential,
} from "@pateat/bitwarden";
import { equalBytes, fromBase64Url, sha256, toBase64Url } from "../passkeys/encoding";
import { importAssertionKey, signAssertion } from "../passkeys/signature";

/** Snapshot binding the Worker attaches to every passkey result. */
export interface PasskeyBinding {
  readonly connectionId: string;
  readonly userId: string;
  readonly snapshotId: string;
}

export interface PasskeySignRequest {
  /** Stored credential ID as unpadded base64url. */
  readonly credentialId: string;
  readonly rpId: string;
  /** Unpadded base64url of exactly 37 bytes: RP ID hash, flags and a zero counter. */
  readonly authenticatorData: string;
  /** Unpadded base64url SHA-256 of the client data. */
  readonly clientDataHash: string;
}

export interface PasskeySignature extends PasskeyBinding {
  readonly itemId: string;
  readonly credentialId: string;
  /** DER ECDSA signature as unpadded base64url. */
  readonly signature: string;
}

const failure = (code: "invalid-request" | "stale-field-reference" | "unsupported-crypto") => ({
  ok: false as const,
  error: { code },
});
// UP, UV, BE and BS are the only flags an assertion may carry; AT, ED and RFU bits stay clear.
const ALLOWED_FLAGS = 0x01 | 0x04 | 0x08 | 0x10;
const REQUIRED_FLAGS = 0x01 | 0x08 | 0x10;

/**
 * The host retires a session on `crypto-failed`, so one unreadable passkey must not lock the
 * vault. Only a genuinely locked session keeps its retiring code.
 */
function perItem<T>(result: BitwardenResult<T>): BitwardenResult<T> {
  if (result.ok || result.error.code === "crypto-locked") return result;
  return result.error.code === "crypto-failed" ? failure("unsupported-crypto") : result;
}

/** Secret-free metadata for the item's stored passkey; the key stays encrypted. */
export async function listStoredPasskeys(
  session: LocalCryptoSession,
  binding: PasskeyBinding,
  itemId: string,
  cipher: unknown,
): Promise<BitwardenResult<readonly LocalPasskeyCredential[]>> {
  try {
    const views = await session.decryptFido2Credentials({
      connectionId: binding.connectionId,
      cipher,
    });
    if (!views.ok) return perItem(views);
    return perItem(
      mapLocalPasskeyCredentials({
        connectionId: binding.connectionId,
        userId: binding.userId,
        snapshotId: binding.snapshotId,
        itemId,
        credentials: views.data,
      }),
    );
  } catch {
    return failure("unsupported-crypto");
  }
}

/**
 * Sign one assertion with the item's stored key. The Worker re-derives the credential and checks
 * that the data is a zero-counter assertion for that credential's RP ID, so this cannot be used
 * as a general signing service. The private key is imported non-extractable and never returned.
 */
export async function signStoredPasskey(
  session: LocalCryptoSession,
  binding: PasskeyBinding,
  itemId: string,
  cipher: unknown,
  request: PasskeySignRequest,
): Promise<BitwardenResult<PasskeySignature>> {
  const authenticatorData = fromBase64Url(request.authenticatorData);
  const clientDataHash = fromBase64Url(request.clientDataHash);
  if (authenticatorData?.length !== 37 || clientDataHash?.length !== 32)
    return failure("invalid-request");
  const listed = await listStoredPasskeys(session, binding, itemId, cipher);
  if (!listed.ok) return listed;
  const [credential] = listed.data;
  if (
    listed.data.length !== 1 ||
    !credential ||
    credential.credentialId !== request.credentialId ||
    credential.rpId !== request.rpId
  )
    return failure("stale-field-reference");
  if (credential.counter !== 0) return failure("unsupported-crypto");
  const flags = authenticatorData[32]!;
  if (
    (flags & REQUIRED_FLAGS) !== REQUIRED_FLAGS ||
    (flags & ~ALLOWED_FLAGS) !== 0 ||
    authenticatorData.subarray(33).some((byte) => byte !== 0) ||
    !equalBytes(
      authenticatorData.subarray(0, 32),
      await sha256(new TextEncoder().encode(credential.rpId)),
    )
  )
    return failure("invalid-request");
  try {
    const encoded = await session.decryptFido2PrivateKey({
      connectionId: binding.connectionId,
      cipher,
    });
    if (!encoded.ok) return perItem(encoded);
    const decoded = decodeLocalPasskeyPrivateKey(encoded.data);
    if (!decoded.ok) return perItem(decoded);
    let key: CryptoKey;
    try {
      key = await importAssertionKey(decoded.data);
    } finally {
      decoded.data.fill(0);
    }
    const signature = await signAssertion(key, authenticatorData, clientDataHash);
    return {
      ok: true,
      data: Object.freeze({
        connectionId: credential.connectionId,
        userId: credential.userId,
        snapshotId: credential.snapshotId,
        itemId: credential.itemId,
        credentialId: credential.credentialId,
        signature: toBase64Url(signature),
      }),
    };
  } catch {
    return failure("unsupported-crypto");
  }
}
