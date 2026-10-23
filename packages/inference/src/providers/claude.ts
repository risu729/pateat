import { createAnthropic } from "@ai-sdk/anthropic";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import * as v from "valibot";
import type { InferenceUsage } from "../outcome";
import pricing from "./claude-pricing.json";
import {
  claudePricingName,
  type ClaudeModelPricing,
  type ClaudePricing,
  type ClaudeTokenRates,
} from "./claude-pricing";

/**
 * Rates committed from the public pricing page by `mise run //packages/inference:pricing`;
 * the scheduled pricing workflow proposes each change (ADR 0014).
 */
const claudePricing: ClaudePricing = pricing;

/** USD per million tokens; output includes thinking. */
export type ClaudeRates = Omit<ClaudeModelPricing, "fast">;

/** A model's published rates at a speed; undefined when the pricing page lists no such price. */
export function claudeModelRates(
  modelId: string,
  speed: "standard" | "fast" = "standard",
): ClaudeRates | undefined {
  const name = claudePricingName(modelId);
  if (name === undefined || !Object.hasOwn(claudePricing.models, name)) return undefined;
  const { fast, ...standard } = claudePricing.models[name]!;
  // Fast mode's price applies across the whole context window.
  return speed === "fast" ? fast : standard;
}

/**
 * Every model the pricing page prices, with the model ID its name reads as
 * (`Claude Opus 5.5` is `claude-opus-5-5`), its line (`opus`) and its version, newest
 * versions first within the page's order.
 */
export function claudePricedModels() {
  return Object.entries(claudePricing.models).flatMap(([displayName, { fast, ...rates }]) => {
    const match = /^Claude ([A-Z][a-z]+) (\d+)(?:\.(\d+))?$/.exec(displayName);
    if (match === null) return [];
    const [, family, major, minor] = match;
    const line = family!.toLowerCase();
    return [
      {
        modelId: `claude-${line}-${major}${minor === undefined ? "" : `-${minor}`}`,
        displayName,
        line,
        version: Number(major) + Number(minor ?? 0) / 100,
        rates: rates as ClaudeRates,
        ...(fast === undefined ? {} : { fast }),
      },
    ];
  });
}

function publishedRates(modelId: string): ClaudeRates {
  const rates = claudeModelRates(modelId);
  if (rates === undefined) throw new Error(`The pricing page lists no price for ${modelId}.`);
  return rates;
}

/**
 * The benchmark's default model: the first choice of the service's default configuration
 * (`DEFAULT_MODEL_CONFIG`, ADR 0014). The service asks each owner's own configuration.
 */
export const claudeGeneration = {
  modelId: "claude-opus-5-5",
  effort: "low",
  rates: publishedRates("claude-opus-5-5"),
} as const;

/**
 * The highest per-token rates a call of at most `maxInputTokens` prompt tokens can be
 * charged, for spend bounds: long-prompt rates only when such a prompt can exceed their
 * threshold.
 */
export function claudeWorstCaseRates(rates: ClaudeRates, maxInputTokens: number): ClaudeTokenRates {
  const { longPrompt } = rates;
  return longPrompt !== undefined && maxInputTokens > longPrompt.overInputTokens
    ? { input: longPrompt.input, output: longPrompt.output }
    : { input: rates.input, output: rates.output };
}

export const claudeEfforts = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof claudeEfforts)[number];
export const claudeSpeeds = ["standard", "fast"] as const;
export type ClaudeSpeed = (typeof claudeSpeeds)[number];

/** A model and effort to run, with its rates at that speed; `fast` runs it in fast mode. */
export type ClaudeModelChoice = {
  modelId: string;
  effort: ClaudeEffort;
  rates: ClaudeRates;
  speed?: ClaudeSpeed;
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
 * failure of this model is returned as an error, and only the service asks another model,
 * the owner's next choice (ADR 0014).
 */
export function createClaudeGenerationModel(
  options: ClaudeCredential & {
    /** Another model: the benchmark's, or one of the owner's choices in the service. */
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
            ...("speed" in choice && choice.speed === "fast" ? { speed: "fast" } : {}),
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

/** Estimated cost from reported usage at the published rates; undefined when usage is unknown. */
export function estimateClaudeCostUsd(
  usage: InferenceUsage,
  rates: ClaudeRates = claudeGeneration.rates,
): number | undefined {
  if (usage.inputTokens === null || usage.outputTokens === null) return undefined;
  const { longPrompt } = rates;
  const { input, output } =
    longPrompt !== undefined && usage.inputTokens > longPrompt.overInputTokens ? longPrompt : rates;
  return (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000;
}
