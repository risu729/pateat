export type BitwardenErrorCode =
  | "invalid-profile"
  | "invalid-options"
  | "invalid-request"
  | "connection-mismatch"
  | "cancelled"
  | "timeout"
  | "network"
  | "redirect"
  | "http-error"
  | "response-too-large"
  | "invalid-response";

export type BitwardenResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: BitwardenErrorCode; status?: number } };

export function failure(code: BitwardenErrorCode, status?: number): BitwardenResult<never> {
  return { ok: false, error: status === undefined ? { code } : { code, status } };
}
