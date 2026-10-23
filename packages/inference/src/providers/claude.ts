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

function publishedRates(modelId: string): ClaudeRates {
  const rates = claudeModelRates(modelId);
  if (rates === undefined) throw new Error(`The pricing page lists no price for ${modelId}.`);
  return rates;
}

/** The owner-selected generation configuration (ADR 0014). */
export const claudeGeneration = {
  modelId: "claude-opus-5-5",
  effort: "low",
  rates: publishedRates("claude-opus-5-5"),
} as const;

/**
 * The model the service asks once more when `claudeGeneration` refuses a request (owner
 * decision, 2026-10-23 11:04 UTC). Its own refusal ends the request.
 */
export const claudeRefusalFallback = {
  modelId: "claude-sonnet-5-5",
  effort: "low",
  rates: publishedRates("claude-sonnet-5-5"),
} as const;

/** The highest per-token rates a call can be charged, for spend bounds. */
export function claudeWorstCaseRates(rates: ClaudeRates): ClaudeTokenRates {
  return {
    input: Math.max(rates.input, rates.longPrompt?.input ?? 0),
    output: Math.max(rates.output, rates.longPrompt?.output ?? 0),
  };
}

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
 * failure of this model is returned as an error, and only the service's own retry of a
 * refusal on `claudeRefusalFallback` asks another model.
 */
export function createClaudeGenerationModel(
  options: ClaudeCredential & {
    /** Another model: the benchmark's, or the service's `claudeRefusalFallback`. */
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
