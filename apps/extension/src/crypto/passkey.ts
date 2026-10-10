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

const failure = (
  code: "field-missing" | "invalid-request" | "stale-field-reference" | "unsupported-crypto",
) => ({
  ok: false as const,
  error: { code },
});
// UP, UV, BE and BS are the only flags an assertion may carry; AT, ED and RFU bits stay clear.
const ALLOWED_FLAGS = 0x01 | 0x04 | 0x08 | 0x10;
const REQUIRED_FLAGS = 0x01 | 0x08 | 0x10;

/** The Worker's received snapshot, as far as passkey item selection needs it. */
export interface PasskeyItemSource {
  readonly verified: boolean;
  /** Encrypted ciphers keyed by lowercase item ID. */
  readonly ciphers: ReadonlyMap<string, unknown>;
  /** Live (not deleted or archived) login items keyed by SDK item ID, which is lowercase. */
  readonly loginUris: ReadonlyMap<string, unknown>;
}

/**
 * Select one verified, live login item: the same set URL matching considers. Deleted, archived
 * and non-login items, and every item before verification, have no passkey operations.
 */
export function selectPasskeyItem(
  source: PasskeyItemSource,
  itemId: string,
): BitwardenResult<{ readonly itemId: string; readonly cipher: unknown }> {
  if (!source.verified) return failure("invalid-request");
  const id = itemId.toLowerCase();
  const cipher = source.ciphers.get(id);
  if (cipher === undefined || !source.loginUris.has(id)) return failure("field-missing");
  return { ok: true, data: { itemId: id, cipher } };
}

/**
 * The host retires a session on `crypto-failed`, so one unreadable passkey must not lock the
 * vault. Only a genuinely locked session keeps its retiring code. An SDK fault in these calls is
 * therefore reported per item; the next non-passkey operation that fails still retires it.
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

export interface PasskeyMatches extends PasskeyBinding {
  readonly rpId: string;
  readonly candidates: readonly LocalPasskeyCredential[];
  /** Live login items whose stored passkey could not be read; never chosen silently. */
  readonly unavailableItemIds: readonly string[];
}

/** Cheap check on the still-encrypted cipher so items without passkeys are never decrypted. */
function storesPasskey(cipher: unknown) {
  const credentials = (cipher as { login?: { fido2Credentials?: unknown } } | null)?.login
    ?.fido2Credentials;
  return Array.isArray(credentials) && credentials.length > 0;
}

/**
 * Every verified live login item whose stored passkey has exactly this RP ID, as the official
 * Bitwarden client searches: by RP ID, not by saved URIs. Only secret-free metadata is returned.
 * An item is unavailable when its passkey metadata cannot be decrypted, so its RP ID is unknown,
 * or when it is decrypted, has this RP ID and still cannot be used; an item whose decrypted
 * passkeys all have other RP IDs never affects this search.
 */
export async function findStoredPasskeys(
  session: LocalCryptoSession,
  binding: PasskeyBinding,
  source: PasskeyItemSource,
  rpId: string,
): Promise<BitwardenResult<PasskeyMatches>> {
  if (!source.verified) return failure("invalid-request");
  const candidates: LocalPasskeyCredential[] = [];
  const unavailableItemIds: string[] = [];
  for (const key of source.loginUris.keys()) {
    const itemId = key.toLowerCase();
    const cipher = source.ciphers.get(itemId);
    if (cipher === undefined) {
      unavailableItemIds.push(itemId);
      continue;
    }
    if (!storesPasskey(cipher)) continue;
    let views: BitwardenResult<readonly { readonly rpId?: unknown }[]>;
    try {
      const input = { connectionId: binding.connectionId, cipher };
      // eslint-disable-next-line no-await-in-loop -- one SDK session decrypts serially.
      views = perItem(await session.decryptFido2Credentials(input));
    } catch {
      views = failure("unsupported-crypto");
    }
    if (!views.ok || !Array.isArray(views.data)) {
      if (!views.ok && views.error.code === "crypto-locked") return views;
      unavailableItemIds.push(itemId);
      continue;
    }
    if (!views.data.some((view) => view.rpId === rpId)) continue;
    const mapped = mapLocalPasskeyCredentials({
      connectionId: binding.connectionId,
      userId: binding.userId,
      snapshotId: binding.snapshotId,
      itemId,
      credentials: views.data,
    });
    if (!mapped.ok) {
      unavailableItemIds.push(itemId);
      continue;
    }
    for (const credential of mapped.data) if (credential.rpId === rpId) candidates.push(credential);
  }
  return {
    ok: true,
    data: Object.freeze({
      ...binding,
      rpId,
      candidates: Object.freeze(candidates),
      unavailableItemIds: Object.freeze(unavailableItemIds),
    }),
  };
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
