import { createAnthropic } from "@ai-sdk/anthropic";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import * as v from "valibot";
import type { InferenceUsage } from "../outcome";

/** The owner-selected generation configuration (ADR 0014). */
export const claudeGeneration = {
  modelId: "claude-opus-5-5",
  effort: "low",
  /** USD per million tokens, as published on the date checked; output includes thinking. */
  rates: { input: 4, output: 20, checked: "2026-10-10" },
} as const;

// Pinned so ANTHROPIC_BASE_URL in the environment can never redirect the key elsewhere.
const anthropicBaseUrl = "https://api.anthropic.com/v1";

/**
 * Builds the Claude model for `createRecipeGenerator`. The key is passed explicitly and
 * never read from the environment. Server-side `fallbacks` stay unset: a failure of
 * this model is returned as an error, never retried on another model.
 */
export function createClaudeGenerationModel(options: {
  apiKey: string;
  /** Test seam only. */
  fetch?: typeof globalThis.fetch;
}) {
  const apiKey = v.parse(v.pipe(v.string(), v.trim(), v.nonEmpty()), options.apiKey);
  const provider = createAnthropic({
    apiKey,
    baseURL: anthropicBaseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  return wrapLanguageModel({
    model: provider(claudeGeneration.modelId),
    middleware: defaultSettingsMiddleware({
      settings: {
        providerOptions: {
          anthropic: {
            effort: claudeGeneration.effort,
            // Opus 5.5 rejects the forced tool call of the JSON-tool mode.
            structuredOutputMode: "outputFormat",
          },
        },
      },
    }),
  });
}

/** Estimated cost from reported usage at the checked rates; undefined when usage is unknown. */
export function estimateClaudeCostUsd(usage: InferenceUsage): number | undefined {
  if (usage.inputTokens === null || usage.outputTokens === null) return undefined;
  const { input, output } = claudeGeneration.rates;
  return (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000;
}
