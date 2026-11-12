import { describe, expect, it } from "vitest";
import { createUsageMeter, unknownUsage } from "../outcome";
import { modelRates, estimateModelCostUsd, modelWorstCaseRates } from "./model-rates";
import {
  normalizeOpenAIUsage,
  estimateOpenAICostUsd,
  openAIModelRates,
  openAIPricedModels,
  openAIWorstCaseRates,
} from "./openai-rates";

const raw = {
  input_tokens: 12_000,
  output_tokens: 100,
  input_tokens_details: {
    cached_tokens: 4_000,
    cache_write_tokens: 7_000,
    cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 4_000 },
  },
  output_tokens_details: { reasoning_tokens: 80 },
};
const rates = openAIModelRates("gpt-6.1-sol")!;
describe("OpenAI accounting", () => {
  it("charges disjoint reads, both write lifetimes and all output including reasoning", () => {
    const usage = normalizeOpenAIUsage(raw);
    expect(usage).toEqual({
      inputTokens: 12_000,
      outputTokens: 100,
      openaiCache: { read: 4_000, write30m: 3_000, write12h: 4_000 },
    });
    // 1000*2 + 4000*.1 + 3000*2.5 + 4000*5 + 100*10; reasoning is already in output.
    expect(estimateOpenAICostUsd(usage, rates)).toBeCloseTo(0.0309, 10);
    expect(estimateModelCostUsd("openai", usage, rates)).toBeCloseTo(0.0309, 10);
    expect(estimateOpenAICostUsd(usage, openAIModelRates("gpt-6.1-sol", "fast")!)).toBeCloseTo(
      0.0618,
      10,
    );
  });

  it("uses the highest possible write price when cache details are absent", () => {
    const usage = normalizeOpenAIUsage({ input_tokens: 12_000, output_tokens: 100 });
    expect(usage.openaiCache).toEqual({ read: null, write30m: null, write12h: null });
    expect(estimateOpenAICostUsd(usage, rates)).toBeCloseTo((12_000 * 5 + 100 * 10) / 1e6, 10);
  });

  it.each([
    { cached_tokens: 4_000 },
    { cached_tokens: 4_000, cache_write_tokens: -1 },
    {
      cached_tokens: 4_000,
      cache_write_tokens: 7_000,
      cache_write_tokens_details: { ttl_30m_tokens: 3_000 },
    },
    {
      cached_tokens: 4_000,
      cache_write_tokens: 7_000,
      cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 3_000 },
    },
    {
      cached_tokens: 4_000,
      cache_write_tokens: 0,
      cache_write_tokens_details: { ttl_30m_tokens: 1 },
    },
    { cached_tokens: 12_001, cache_write_tokens: 0 },
    { cached_tokens: -1, cache_write_tokens: 0 },
    { cached_tokens: 0.5, cache_write_tokens: 0 },
  ])("bounds incomplete, contradictory or impossible cache reporting %#", (details) => {
    const usage = normalizeOpenAIUsage({ ...raw, input_tokens_details: details });
    expect(estimateOpenAICostUsd(usage, rates)).toBeCloseTo(0.061, 10);
  });

  it("accepts an explicit zero write total without inventing unknown writes", () => {
    const usage = normalizeOpenAIUsage({
      ...raw,
      input_tokens_details: { cached_tokens: 4_000, cache_write_tokens: 0 },
    });
    expect(usage.openaiCache).toEqual({ read: 4_000, write30m: 0, write12h: 0 });
    expect(estimateOpenAICostUsd(usage, rates)).toBeCloseTo(0.0174, 10);
  });

  it.each([
    undefined,
    null,
    {},
    { input_tokens: -1, output_tokens: 100 },
    { input_tokens: 12_000, output_tokens: 0.5 },
    { input_tokens: Number.MAX_SAFE_INTEGER + 1, output_tokens: 100 },
  ])("keeps missing or malformed totals unknown %#", (value) => {
    expect(estimateOpenAICostUsd(normalizeOpenAIUsage(value), rates)).toBeUndefined();
  });

  it("applies the long-context threshold to exact and conservative accounting", () => {
    expect(openAIWorstCaseRates(rates, 272_000)).toEqual({ input: 5, output: 10 });
    expect(openAIWorstCaseRates(rates, 272_001)).toEqual({ input: 10, output: 15 });
    expect(modelWorstCaseRates("openai", rates, 272_001)).toEqual({ input: 10, output: 15 });
    expect(estimateOpenAICostUsd({ inputTokens: 272_001, outputTokens: 100 }, rates)).toBeCloseTo(
      2.72151,
      10,
    );
  });

  it("sums metered attempts without converting a missing attempt into zero", () => {
    const meter = createUsageMeter();
    meter.record(normalizeOpenAIUsage(raw));
    meter.record(normalizeOpenAIUsage(raw));
    expect(meter.total()).toEqual({
      inputTokens: 24_000,
      outputTokens: 200,
      openaiCache: { read: 8_000, write30m: 6_000, write12h: 8_000 },
    });
    meter.record(unknownUsage);
    expect(meter.total()).toEqual({
      inputTokens: null,
      outputTokens: null,
      openaiCache: { read: null, write30m: null, write12h: null },
    });
  });

  it("keeps provider-specific catalogues bounded and never prices an unknown model", () => {
    expect(openAIPricedModels().map((model) => model.modelId)).toEqual([
      "gpt-6-astra",
      "gpt-6.1-sol",
      "gpt-6.1-terra",
      "gpt-6-luna",
    ]);
    for (const model of ["gpt-unknown", "gpt-6.1-sol-2026-11-11", "claude-opus-5-5", "constructor"])
      expect(openAIModelRates(model)).toBeUndefined();
    expect(modelRates("anthropic", "gpt-6.1-sol")).toBeUndefined();
    expect(modelRates("openai", "claude-opus-5-5")).toBeUndefined();
    expect(modelRates("anthropic", "claude-opus-5-5")).toEqual({ input: 4, output: 20 });
  });
});
