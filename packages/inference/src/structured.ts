import { valibotSchema } from "@ai-sdk/valibot";
import { generateText, Output, wrapLanguageModel, type LanguageModel } from "ai";
import * as v from "valibot";
import { classifyInferenceError } from "./errors";
import {
  createUsageMeter,
  normalizeUsage,
  raceAbort,
  refusalCategoryCode,
  unknownUsage,
  type AbstentionReason,
  type InferenceErrorCode,
  type InferenceOutcome,
} from "./outcome";
import type { PlanRejection } from "./plan";

/** What a role makes of the model's structured output, before usage is attached. */
export type Interpreted<T> =
  | { status: "ok"; value: T }
  | { status: "abstained"; reason: AbstentionReason }
  | { status: "failed"; error: InferenceErrorCode; detail?: PlanRejection };

/**
 * One structured-output call with the configured model only: usage is metered across
 * attempts, the timeout and caller cancellation are enforced, and telemetry stays off.
 * The caller validates the request and its size first.
 */
export async function runStructuredRole<O, T>(config: {
  model: Exclude<LanguageModel, string>;
  instructions: string;
  prompt: string;
  schema: v.GenericSchema<unknown, O>;
  name: string;
  limits: { maxRetries: number; timeoutMs: number };
  maxOutputTokens: number;
  abortSignal?: AbortSignal | undefined;
  /** Reads the provider's refusal category code from the last attempt's metadata. */
  refusalCategory?: ((providerMetadata: unknown) => string | undefined) | undefined;
  interpret: (output: O) => Interpreted<T>;
}): Promise<InferenceOutcome<T>> {
  let calls = 0;
  let lastMetadata: unknown;
  const meter = createUsageMeter();
  const timeout = AbortSignal.timeout(config.limits.timeoutMs);
  const signal = config.abortSignal ? AbortSignal.any([config.abortSignal, timeout]) : timeout;
  const model = wrapLanguageModel({
    model: config.model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        calls += 1;
        lastMetadata = undefined;
        try {
          const result = await raceAbort(doGenerate(), signal);
          lastMetadata = result.providerMetadata;
          meter.record(
            normalizeUsage({
              inputTokens: result.usage.inputTokens.total,
              outputTokens: result.usage.outputTokens.total,
            }),
          );
          return result;
        } catch (error) {
          meter.record(unknownUsage);
          throw error;
        }
      },
    },
  });
  const outcome = (result: Interpreted<T>): InferenceOutcome<T> => {
    const category =
      result.status === "failed" && result.error === "refused"
        ? refusalCategoryCode(config.refusalCategory?.(lastMetadata))
        : undefined;
    return {
      ...result,
      ...(category === undefined ? {} : { refusalCategory: category }),
      calls,
      usage: meter.total(),
    };
  };
  try {
    const result = await generateText({
      model,
      instructions: config.instructions,
      prompt: config.prompt,
      output: Output.object({ schema: valibotSchema(config.schema), name: config.name }),
      maxRetries: config.limits.maxRetries,
      maxOutputTokens: config.maxOutputTokens,
      abortSignal: signal,
      // Prompts, page text and outputs must never reach global telemetry integrations.
      telemetry: { isEnabled: false },
    });
    if (result.finishReason === "length") return outcome({ status: "failed", error: "truncated" });
    if (result.finishReason === "content-filter")
      return outcome({ status: "failed", error: "refused" });
    return outcome(config.interpret(result.output));
  } catch (error) {
    return outcome({
      status: "failed",
      error: classifyInferenceError(error, { timeout, caller: config.abortSignal }),
    });
  }
}
