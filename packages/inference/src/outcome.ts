import { generationOutputRejectionSchema, type GenerationOutputRejection } from "@pateat/contracts";
import * as v from "valibot";
import type { GeneratedPageRejection } from "./plan";

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
  | "no-action"
  /** The local value check rejected the mapping; see `checkPlanValues`. */
  | "value-mismatch";

/**
 * Why the structured-output check refused the model's text as `invalid-output`
 * (`generationOutputRejectionSchema`): never the text, the issue's message or the value
 * it received, which may quote the output.
 */
export type OutputSchemaIssue = Exclude<GenerationOutputRejection, { check: "plan" }>;

/**
 * Every role returns one of these local outcomes. Diagnostics carry codes only;
 * prompts, page text and raw model output are never included. A generated plan the role's
 * own check refused is kept only as `output`, reduced to references the request holds.
 */
export type InferenceOutcome<T> = {
  calls: number;
  usage: InferenceUsage;
  /**
   * The model's own answer once its output passed the response format, before any local
   * check or adjustment, for the request log: each ID that is not a candidate or slot of
   * the request is `?` and each generated name `name-N` (ADR 0012).
   */
  answer?: unknown;
} & (
  | { status: "ok"; value: T }
  | { status: "abstained"; reason: AbstentionReason }
  | {
      status: "failed";
      error: InferenceErrorCode;
      /** For `invalid-output`: the code of the role's own check that refused the output. */
      detail?: GeneratedPageRejection;
      /** For `invalid-output`: the structured-output check that refused the model's text. */
      schemaIssue?: OutputSchemaIssue;
      /**
       * For `invalid-output` with a `detail`: the output that check refused, for the
       * request log, with each string that is not a reference the request holds replaced
       * (`redactGeneratedPage`).
       */
      output?: unknown;
      /** For `refused`: the provider's refusal category code when it reports one. */
      refusalCategory?: string;
    }
);

/**
 * Which check refused a failed outcome's output, and why, as the service reports it;
 * nothing for any other failure, or for a code the contract does not accept.
 */
export function outputRejection(
  outcome: Pick<
    Extract<InferenceOutcome<unknown>, { status: "failed" }>,
    "error" | "detail" | "schemaIssue"
  >,
): GenerationOutputRejection | undefined {
  if (outcome.error !== "invalid-output") return undefined;
  const rejection: GenerationOutputRejection | undefined =
    outcome.detail === undefined ? outcome.schemaIssue : { check: "plan", reason: outcome.detail };
  return rejection !== undefined && v.is(generationOutputRejectionSchema, rejection)
    ? rejection
    : undefined;
}

/** Keeps a provider refusal category only when it is a short code, never free text. */
export const refusalCategoryCode = (value: unknown): string | undefined =>
  typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value) ? value : undefined;

export const unknownUsage: InferenceUsage = { inputTokens: null, outputTokens: null };
/** Usage of an outcome decided locally before any model call. */
export const noUsage: InferenceUsage = { inputTokens: 0, outputTokens: 0 };

const count = (value: number | undefined) =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : null;

export function normalizeUsage(
  usage: { inputTokens?: number | undefined; outputTokens?: number | undefined } | undefined,
): InferenceUsage {
  return { inputTokens: count(usage?.inputTokens), outputTokens: count(usage?.outputTokens) };
}

/**
 * Accumulates usage for every model attempt, including failed retries. One attempt
 * without reported usage makes the total unknown rather than undercounting it.
 */
export function createUsageMeter() {
  const attempts: InferenceUsage[] = [];
  const sum = (key: keyof InferenceUsage) =>
    attempts.reduce<number | null>(
      (total, attempt) => (total === null || attempt[key] === null ? null : total + attempt[key]),
      0,
    );
  return {
    record: (usage: InferenceUsage) => {
      attempts.push(usage);
    },
    total: (): InferenceUsage => ({
      inputTokens: sum("inputTokens"),
      outputTokens: sum("outputTokens"),
    }),
  };
}

/** Explicit request limits shared by both roles. Retries are bounded and default to none. */
export const roleLimitsSchema = v.strictObject({
  maxRetries: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(2)), 0),
  timeoutMs: v.pipe(v.number(), v.integer(), v.minValue(100), v.maxValue(60_000)),
  maxInputBytes: v.pipe(v.number(), v.integer(), v.minValue(256), v.maxValue(256 * 1024)),
});
export type RoleLimits = v.InferInput<typeof roleLimitsSchema>;

const encoder = new TextEncoder();

/**
 * Measures the serialized request content Pateat sends: instructions, input, output
 * schema or questions and options. Provider envelope overhead is not included.
 */
export const requestBytes = (parts: readonly unknown[]): number =>
  parts.reduce<number>(
    (total, part) =>
      total + encoder.encode(typeof part === "string" ? part : JSON.stringify(part)).length,
    0,
  );

/** Settles with the signal's reason once aborted, even when a transport ignores the signal. */
export async function raceAbort<T>(work: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  // Observe a late rejection of abandoned work so it never becomes unhandled.
  Promise.resolve(work).catch(() => {});
  signal.throwIfAborted();
  const { promise: aborted, reject } = Promise.withResolvers<never>();
  const abort = () => reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

/**
 * A short version of what a role sends besides the page: the first 12 hex digits of the
 * SHA-256 of its instructions, a newline and its response format's JSON Schema as sent.
 * Logged with each call, so a log row shows which instructions produced it.
 */
export async function promptVersion(instructions: string, schemaJson: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${instructions}\n${schemaJson}`),
  );
  return new Uint8Array(digest).toHex().slice(0, 12);
}

/** Computes a role's prompt version once, on first use. */
export function promptVersionOf(instructions: string, schemaJson: string): () => Promise<string> {
  let version: Promise<string> | undefined;
  return () => (version ??= promptVersion(instructions, schemaJson));
}
