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
 * - `sdk-decrypt`: the SDK could not decrypt or authenticate the item.
 * - `attachment`: an attachment's metadata failed to decrypt.
 * - `uri-dropped`: the SDK left out a URI, which it does when the URI or its checksum does
 *   not decrypt or the checksum does not match.
 * - `passkey-dropped`: the SDK left out a passkey.
 * - `uri-checksum-without-uri`: a URI has a checksum but no URI.
 * - `uri-checksum`: a URI's checksum is not the SHA-256 of the URI.
 * - `item-type`: the decrypted item type is not one Pateat reads.
 * - `folder`, `collection`: a folder or collection name failed to decrypt.
 */
export const BITWARDEN_DECRYPT_CHECKS = [
  "unknown-organization",
  "sdk-decrypt",
  "attachment",
  "uri-dropped",
  "passkey-dropped",
  "uri-checksum-without-uri",
  "uri-checksum",
  "item-type",
  "folder",
  "collection",
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
