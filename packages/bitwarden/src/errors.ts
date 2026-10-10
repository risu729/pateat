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
  | "invalid-uri-input";

export type BitwardenResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: BitwardenErrorCode; status?: number } };

export function failure(code: BitwardenErrorCode, status?: number): BitwardenResult<never> {
  return { ok: false, error: status === undefined ? { code } : { code, status } };
}
