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
  | "unsupported-totp"
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

export type BitwardenResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: BitwardenErrorCode; status?: number; check?: BitwardenMismatchCheck };
    };

export function failure(code: BitwardenErrorCode, status?: number): BitwardenResult<never> {
  return { ok: false, error: status === undefined ? { code } : { code, status } };
}

export function mismatch(check: BitwardenMismatchCheck): BitwardenResult<never> {
  return { ok: false, error: { code: "account-mismatch", check } };
}
