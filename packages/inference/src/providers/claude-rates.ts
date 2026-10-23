import type { InferenceUsage } from "../outcome";
import pricing from "./claude-pricing.json";
import { claudePricingName, type ClaudeModelPricing, type ClaudePricing } from "./claude-pricing";

// The published Claude rates alone, without the provider adapter, for a device that counts
// what its own key spends (ADR 0040).

/**
 * Rates committed from the public pricing page by `mise run //packages/inference:pricing`;
 * the scheduled pricing workflow proposes each change (ADR 0014).
 */
export const claudePricing: ClaudePricing = pricing;

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

/** Estimated cost from reported usage at the published rates; undefined when usage is unknown. */
export function estimateClaudeCost(usage: InferenceUsage, rates: ClaudeRates): number | undefined {
  if (usage.inputTokens === null || usage.outputTokens === null) return undefined;
  const { longPrompt } = rates;
  const { input, output } =
    longPrompt !== undefined && usage.inputTokens > longPrompt.overInputTokens ? longPrompt : rates;
  return (usage.inputTokens * input + usage.outputTokens * output) / 1_000_000;
}
