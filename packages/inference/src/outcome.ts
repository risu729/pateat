import * as v from "valibot";
import type { PlanRejection } from "./plan";

/** Token usage for one role invocation. `null` means the provider did not report it: unknown, not free. */
export type InferenceUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
};

export type InferenceErrorCode =
  | "incomplete-observation"
  | "invalid-request"
  | "input-too-large"
  | "invalid-output"
  | "refused"
  | "truncated"
  | "timeout"
  | "cancelled"
  | "rate-limited"
  | "provider-error";

export type AbstentionReason =
  | "no-login-form"
  | "ambiguous"
  | "insufficient-evidence"
  | "unsafe-instructions"
  | "low-confidence"
  | "missing-probabilities"
  | "inconsistent-mapping"
  | "no-action";

/**
 * Every role returns one of these local outcomes. Diagnostics carry codes only;
 * prompts, page text and raw model output are never included.
 */
export type InferenceOutcome<T> = { calls: number; usage: InferenceUsage } & (
  | { status: "ok"; value: T }
  | { status: "abstained"; reason: AbstentionReason }
  | { status: "failed"; error: InferenceErrorCode; detail?: PlanRejection }
);

export const unknownUsage: InferenceUsage = { inputTokens: null, outputTokens: null };

const count = (value: number | undefined) =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function normalizeUsage(
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined,
): InferenceUsage {
  return { inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens) };
}

/** Explicit request limits shared by both roles. Retries are bounded and default to none. */
export const roleLimitsSchema = v.strictObject({
  maxRetries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2)), 0),
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(60_000)),
  maxInputBytes: v.pipe(v.number(), v.integer(), v.minValue(256), v.maxValue(256 * 1024)),
});
export type RoleLimits = v.InferInput<typeof roleLimitsSchema>;

const encoder = new TextEncoder();

/** Measures the complete serialized request, including instructions, questions and options. */
export const requestBytes = (parts: readonly unknown[]): number =>
  parts.reduce<number>(
    (total, part) =>
      total + encoder.encode(typeof part === "string" ? part : JSON.stringify(part)).length,
    0,
  );

/** Settles with the signal's reason once aborted, even when a transport ignores the signal. */
export async function raceAbort<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
