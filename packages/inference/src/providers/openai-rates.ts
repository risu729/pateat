import { modelEfforts, openAIModelIds, type ModelEffort, type ModelSpeed } from "@pateat/contracts";
import type { InferenceUsage } from "../outcome";

export type OpenAIRates = {
  input: number;
  output: number;
  cachedInput: number;
  cacheWrite30m: number;
  cacheWrite12h: number;
};

/** Public standard rates, checked 2026-11-11 against each model's official page. */
const prices = {
  "gpt-6-astra": { displayName: "GPT-6 Astra", input: 10, output: 50, cachedInput: 1 },
  "gpt-6.1-sol": { displayName: "GPT-6.1 Sol", input: 2, output: 10, cachedInput: 0.1 },
  "gpt-6.1-terra": { displayName: "GPT-6.1 Terra", input: 1, output: 5, cachedInput: 0.05 },
  "gpt-6-luna": { displayName: "GPT-6 Luna", input: 0.1, output: 0.5, cachedInput: 0.01 },
} as const;

export function openAIModelRates(
  modelId: string,
  speed: ModelSpeed = "standard",
): OpenAIRates | undefined {
  if (!Object.hasOwn(prices, modelId)) return undefined;
  const price = prices[modelId as keyof typeof prices];
  const multiplier = speed === "fast" ? 2 : 1;
  return {
    input: price.input * multiplier,
    output: price.output * multiplier,
    cachedInput: price.cachedInput * multiplier,
    cacheWrite30m: price.input * 1.25 * multiplier,
    cacheWrite12h: price.input * 2.5 * multiplier,
  };
}

/** Static catalogue: setup and model selection never contact the paid API. */
export function openAIPricedModels() {
  return openAIModelIds.map((modelId) => ({
    provider: "openai" as const,
    modelId,
    displayName: prices[modelId].displayName,
    efforts: [...modelEfforts] as ModelEffort[],
    rates: openAIModelRates(modelId)!,
    fast: openAIModelRates(modelId, "fast")!,
  }));
}

const validCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Raw Responses usage for either the SDK transport or the device's pinned transport. */
export function normalizeOpenAIUsage(raw: unknown): InferenceUsage {
  const usage = object(raw);
  const details = object(usage["input_tokens_details"]);
  const writes = object(details["cache_write_tokens_details"]);
  const inputTokens = validCount(usage["input_tokens"]) ? usage["input_tokens"] : null;
  const outputTokens = validCount(usage["output_tokens"]) ? usage["output_tokens"] : null;
  const read = details["cached_tokens"];
  const write = details["cache_write_tokens"];
  const short = writes["ttl_30m_tokens"];
  const long = writes["ttl_12h_tokens"];
  // Missing cache fields remain unknown. An explicit zero total proves both writes zero.
  const cache = {
    read: validCount(read) ? read : null,
    write30m: write === 0 ? 0 : validCount(short) ? short : null,
    write12h: write === 0 ? 0 : validCount(long) ? long : null,
  };
  if (
    !validCount(write) ||
    (write === 0 && ((validCount(short) && short !== 0) || (validCount(long) && long !== 0))) ||
    (cache.write30m !== null &&
      cache.write12h !== null &&
      cache.write30m + cache.write12h !== write)
  ) {
    cache.write30m = null;
    cache.write12h = null;
  }
  return { inputTokens, outputTokens, openaiCache: cache };
}

function effectiveRates(rates: OpenAIRates, inputTokens: number): OpenAIRates {
  if (inputTokens <= 272_000) return rates;
  return {
    input: rates.input * 2,
    output: rates.output * 1.5,
    cachedInput: rates.cachedInput * 2,
    cacheWrite30m: rates.cacheWrite30m * 2,
    cacheWrite12h: rates.cacheWrite12h * 2,
  };
}

/** Highest cache-write rate bounds incomplete cache reporting; unknown totals stay unknown. */
export function estimateOpenAICostUsd(
  usage: InferenceUsage,
  rates: OpenAIRates,
): number | undefined {
  if (!validCount(usage.inputTokens) || !validCount(usage.outputTokens)) return undefined;
  const price = effectiveRates(rates, usage.inputTokens);
  const cache = usage.openaiCache;
  const counts = cache === undefined ? [] : [cache.read, cache.write30m, cache.write12h];
  const complete = counts.length === 3 && counts.every(validCount);
  const cachedTotal = complete ? cache!.read! + cache!.write30m! + cache!.write12h! : 0;
  const inputCost =
    complete && cachedTotal <= usage.inputTokens
      ? (usage.inputTokens - cachedTotal) * price.input +
        cache!.read! * price.cachedInput +
        cache!.write30m! * price.cacheWrite30m +
        cache!.write12h! * price.cacheWrite12h
      : usage.inputTokens * Math.max(price.input, price.cacheWrite30m, price.cacheWrite12h);
  return (inputCost + usage.outputTokens * price.output) / 1_000_000;
}

/** Input includes possible writes at either lifetime; output already includes reasoning. */
export function openAIWorstCaseRates(rates: OpenAIRates, maxInputTokens: number) {
  const price = effectiveRates(rates, maxInputTokens);
  return {
    input: Math.max(price.input, price.cacheWrite30m, price.cacheWrite12h),
    output: price.output,
  };
}
