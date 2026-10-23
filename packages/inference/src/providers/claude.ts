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

/** USD per million tokens; output includes thinking. */
export type ClaudeRates = { input: number; output: number; checked: string };

/**
 * Models the benchmark may compare with the service's, at their published rates. Only the
 * benchmark takes them: the service always runs `claudeGeneration` (ADR 0014).
 */
export const claudeBenchmarkModels = {
  "claude-opus-5-5": claudeGeneration.rates,
  "claude-fable-5-1": { input: 10, output: 50, checked: "2026-10-23" },
  "claude-opus-5": { input: 5, output: 25, checked: "2026-10-23" },
  "claude-sonnet-5-5": { input: 2, output: 10, checked: "2026-10-23" },
  // Prompts above 100K tokens cost more; the role's input bound keeps them far below.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, checked: "2026-10-23" },
} as const satisfies Record<string, ClaudeRates>;

export type ClaudeBenchmarkModel = keyof typeof claudeBenchmarkModels;

/**
 * Fast mode's rates (Claude API research preview: the same model, faster output), for the
 * models that offer it.
 */
export const claudeFastModeRates = {
  "claude-opus-5-5": { input: 8, output: 40, checked: "2026-10-23" },
  "claude-opus-5": { input: 10, output: 50, checked: "2026-10-23" },
} as const satisfies Partial<Record<ClaudeBenchmarkModel, ClaudeRates>>;

export const claudeEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof claudeEfforts)[number];

/** A model and effort to run, with its rates; `fast` runs it in fast mode. */
export type ClaudeModelChoice = {
  modelId: string;
  effort: ClaudeEffort;
  rates: ClaudeRates;
  speed?: "fast";
};

// Pinned so ANTHROPIC_BASE_URL in the environment can never redirect the key elsewhere.
const anthropicBaseUrl = "https://api.anthropic.com/v1";

const credentialValue = v.pipe(v.string(), v.trim(), v.nonEmpty());

/**
 * How the adapter authenticates: an API key (the benchmark), or a short-lived access
 * token from a Workload Identity Federation exchange (the service, ADR 0015).
 */
export type ClaudeCredential = { apiKey: string } | { authToken: string };

/**
 * Builds the Claude model for `createRecipeGenerator`. The credential is passed
 * explicitly and never read from the environment. Server-side `fallbacks` stay unset: a
 * failure of this model is returned as an error, never retried on another model.
 */
export function createClaudeGenerationModel(
  options: ClaudeCredential & {
    /** Another model for the benchmark; the service never passes one. */
    choice?: ClaudeModelChoice;
    /** Test seam only. */
    fetch?: typeof globalThis.fetch;
  },
) {
  // Exactly one non-empty credential, so the provider never falls back to the environment.
  if ("authToken" in options && "apiKey" in options)
    throw new TypeError("Pass either apiKey or authToken, not both.");
  const credential =
    "authToken" in options
      ? { authToken: v.parse(credentialValue, options.authToken) }
      : { apiKey: v.parse(credentialValue, options.apiKey) };
  const provider = createAnthropic({
    ...credential,
    baseURL: anthropicBaseUrl,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const choice = options.choice ?? claudeGeneration;
  return wrapLanguageModel({
    model: provider(choice.modelId),
    middleware: defaultSettingsMiddleware({
      settings: {
        providerOptions: {
          anthropic: {
            effort: choice.effort,
            ...("speed" in choice && choice.speed ? { speed: choice.speed } : {}),
            // Opus 5.5 rejects the forced tool call of the JSON-tool mode.
            structuredOutputMode: "outputFormat",
          },
        },
      },
    }),
  });
}

/** The `stop_details.category` of a Claude refusal, such as `cyber`, when reported. */
export function claudeRefusalCategory(providerMetadata: unknown): string | undefined {
  const anthropic = (providerMetadata as { anthropic?: { stopDetails?: { category?: unknown } } })
    ?.anthropic;
  const category = anthropic?.stopDetails?.category;
  return typeof category === "string" ? category : undefined;
}

/** Estimated cost from reported usage at the checked rates; undefined when usage is unknown. */
export function estimateClaudeCostUsd(
  usage: InferenceUsage,
  rates: ClaudeRates = claudeGeneration.rates,
): number | undefined {
  if (usage.inputTokens === null || usage.outputTokens === null) return undefined;
  const { input, output } = rates;
  return (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000;
}
