import {
  APICallError,
  Experimental_DecisionRefusalError,
  InvalidResponseDataError,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  RetryError,
  TypeValidationError,
} from "ai";
import type { InferenceErrorCode } from "./outcome";

/**
 * Maps SDK and transport failures to local outcome codes. `signals` distinguish our
 * own timeout from caller cancellation, independent of how the SDK wraps aborts.
 */
export function classifyInferenceError(
  error: unknown,
  signals: { timeout: AbortSignal; caller?: AbortSignal | undefined },
): InferenceErrorCode {
  if (signals.caller?.aborted) return "cancelled";
  if (signals.timeout.aborted) return "timeout";
  const cause = RetryError.isInstance(error) ? error.lastError : error;
  if (Experimental_DecisionRefusalError.isInstance(cause)) return "refused";
  if (NoObjectGeneratedError.isInstance(cause)) {
    if (cause.finishReason === "length") return "truncated";
    if (cause.finishReason === "content-filter") return "refused";
    return "invalid-output";
  }
  if (
    NoOutputGeneratedError.isInstance(cause) ||
    InvalidResponseDataError.isInstance(cause) ||
    TypeValidationError.isInstance(cause) ||
    JSONParseError.isInstance(cause)
  )
    return "invalid-output";
  if (APICallError.isInstance(cause) && cause.statusCode === 429) return "rate-limited";
  return "provider-error";
}
