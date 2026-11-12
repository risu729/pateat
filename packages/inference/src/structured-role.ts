import type { LanguageModel } from "ai";
import * as v from "valibot";
import {
  noUsage,
  requestBytes,
  roleLimitsSchema,
  type InferenceOutcome,
  type RoleLimits,
} from "./outcome";
import { runStructuredRole, type Interpreted } from "./structured";

export type StructuredRoleConfig = {
  model: Exclude<LanguageModel, string>;
  limits: RoleLimits;
  maxOutputTokens: number;
  /** Reads the provider's refusal category code from the last attempt's metadata. */
  refusalCategory?: (providerMetadata: unknown) => string | undefined;
};

/** Configures a structured role; callers validate requests before checking their size. */
export function createStructuredRole<O>(
  config: StructuredRoleConfig,
  format: { schema: v.GenericSchema<unknown, O>; schemaJson: string; name: string },
) {
  // A string would resolve through the SDK's global default provider.
  if (typeof config.model !== "object" || config.model === null)
    throw new TypeError("Pass a configured model instance");
  const limits = v.parse(roleLimitsSchema, config.limits);
  const maxOutputTokens = v.parse(
    v.pipe(v.number(), v.integer(), v.minValue(16), v.maxValue(16_384)),
    config.maxOutputTokens,
  );

  return async <T>(call: {
    instructions: string;
    prompt: string;
    abortSignal: AbortSignal | undefined;
    interpret: (output: O) => Interpreted<T>;
    answer: (output: O) => unknown;
  }): Promise<InferenceOutcome<T>> => {
    if (requestBytes([call.instructions, call.prompt, format.schemaJson]) > limits.maxInputBytes)
      return { status: "failed", error: "input-too-large", calls: 0, usage: noUsage };
    // Limits are captured at creation; the configured model and refusal reader stay live.
    return runStructuredRole({
      ...call,
      model: config.model,
      schema: format.schema,
      name: format.name,
      limits,
      maxOutputTokens,
      refusalCategory: config.refusalCategory,
    });
  };
}
