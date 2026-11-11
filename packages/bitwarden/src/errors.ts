export type BitwardenErrorCode =
  | "invalid-profile"
  | "invalid-options"
  | "invalid-request"
  | "connection-mismatch"
  | "account-mismatch"
  | "authentication-expired"
  | "unsupported-unlock"
  | "cancelled"
  | "timeout"
  | "network"
  | "redirect"
  | "http-error"
  | "response-too-large"
  | "invalid-response"
  | "invalid-crypto-input"
  | "crypto-failed"
  | "unsupported-crypto"
  | "security-downgrade"
  | "crypto-locked"
  | "resource-limit"
  | "invalid-field-input"
  | "stale-field-reference"
  | "field-denied"
  | "field-missing"
  | "unsupported-field"
  | "invalid-totp"
  | "invalid-uri-input"
  | "uri-context-unavailable";

/** Names which account consistency check failed. It never carries a compared value. */
export type BitwardenMismatchCheck =
  | "token-subject"
  | "token-email"
  | "configured-email"
  | "known-user"
  | "security-stamp"
  | "token-account-keys"
  | "token-private-key"
  | "user-key"
  | "token-unlock";

/**
 * Names which strict decryption check refused an item, on `crypto-failed` only. It never
 * carries a decrypted or encrypted value.
 * - `unknown-organization`: the item names an organization whose key the account lacks.
 *   The account mapper refuses such a sync first, so this guard is defensive.
 * - `sdk-decrypt`: the SDK threw while decrypting the item: a field, URI or checksum that
 *   does not decrypt or authenticate, or an item shape or value this SDK does not read.
 * - `attachment`: an attachment's metadata failed to decrypt.
 * - `passkey-dropped`: the SDK left out a passkey; only passkey operations decrypt them.
 * - `item-type`: the decrypted item type is not one Pateat reads. Admission already
 *   requires a readable type, so this guard is defensive.
 * - `folder`, `collection`: a folder or collection name failed to decrypt.
 * - `catalog`: the SDK threw while reading the folders and collections.
 * - `master-password`: the master password did not unwrap the account's user key.
 * - `session-open`: opening the account failed before any item was read: its keys,
 *   security state or organization keys did not initialize.
 */
export const BITWARDEN_DECRYPT_CHECKS = [
  "unknown-organization",
  "sdk-decrypt",
  "attachment",
  "passkey-dropped",
  "item-type",
  "folder",
  "collection",
  "catalog",
  "master-password",
  "session-open",
] as const;
export type BitwardenDecryptCheck = (typeof BITWARDEN_DECRYPT_CHECKS)[number];

export type BitwardenResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: BitwardenErrorCode;
        status?: number;
        check?: BitwardenMismatchCheck | BitwardenDecryptCheck;
        /** On `crypto-failed` for a received item: its ID, never its name. */
        item?: string;
        /** With `item`: the item's server revision date in milliseconds. */
        revised?: number;
      };
    };

export function failure(code: BitwardenErrorCode, status?: number): BitwardenResult<never> {
  return { ok: false, error: status === undefined ? { code } : { code, status } };
}

export function mismatch(check: BitwardenMismatchCheck): BitwardenResult<never> {
  return { ok: false, error: { code: "account-mismatch", check } };
}

export function decryptFailure(check: BitwardenDecryptCheck): BitwardenResult<never> {
  return { ok: false, error: { code: "crypto-failed", check } };
}
