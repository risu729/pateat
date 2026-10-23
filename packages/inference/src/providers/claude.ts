import { createAnthropic } from "@ai-sdk/anthropic";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";
import * as v from "valibot";
import type { InferenceUsage } from "../outcome";

/** USD per million tokens, as published on the date checked; output includes thinking. */
export type ClaudeRates = { input: number; output: number; checked: string };

/** The owner-selected model, effort and rates of each role (ADR 0014). */
export const claudeRoles = {
  generate: {
    modelId: "claude-sonnet-5-5",
    effort: "low",
    rates: { input: 2, output: 10, checked: "2026-10-23" },
  },
  judge: {
    modelId: "claude-opus-5-5",
    effort: "low",
    rates: { input: 4, output: 20, checked: "2026-10-10" },
  },
} as const satisfies Record<string, { modelId: string; effort: string; rates: ClaudeRates }>;

export type ClaudeRole = keyof typeof claudeRoles;

// Pinned so ANTHROPIC_BASE_URL in the environment can never redirect the key elsewhere.
const anthropicBaseUrl = "https://api.anthropic.com/v1";

const credentialValue = v.pipe(v.string(), v.trim(), v.nonEmpty());

/**
 * How the adapter authenticates: an API key (the benchmark), or a short-lived access
 * token from a Workload Identity Federation exchange (the service, ADR 0015).
 */
export type ClaudeCredential = { apiKey: string } | { authToken: string };

/**
 * Builds the Claude model of one role, for `createRecipeGenerator` (`generate`) or
 * `createCompletionJudge` (`judge`). The credential is passed explicitly and never read
 * from the environment. Server-side `fallbacks` stay unset: a failure of this model is
 * returned as an error, never retried on another model.
 */
export function createClaudeModel(
  options: ClaudeCredential & {
    role: ClaudeRole;
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
  const { modelId, effort } = claudeRoles[options.role];
  return wrapLanguageModel({
    model: provider(modelId),
    middleware: defaultSettingsMiddleware({
      settings: {
        providerOptions: {
          anthropic: {
            effort,
            // Opus 5.5 and Sonnet 5.5 reject the forced tool call of the JSON-tool mode.
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

/**
 * Estimated cost from reported usage at the role's checked rates; undefined when usage is
 * unknown.
 */
export function estimateClaudeCostUsd(usage: InferenceUsage, role: ClaudeRole): number | undefined {
  if (usage.inputTokens === null || usage.outputTokens === null) return undefined;
  const { input, output } = claudeRoles[role].rates;
  return (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000;
}
