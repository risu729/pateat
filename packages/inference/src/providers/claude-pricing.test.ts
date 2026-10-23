import { describe, expect, it } from "vitest";
import { claudePricingName, parseClaudePricing } from "./claude-pricing";

// Shaped like the published page (2026-10-23), cut to a few rows of each kind.
const page = `---
title: Pricing
---

## Model pricing

| Model | Base input tokens | 5m cache writes | 1h cache writes | Cache hits and refreshes | Output tokens |
| ----- | ----------------- | --------------- | --------------- | ------------------------ | ------------- |
| Claude Mythos 5.1 ([limited availability](https://support.claude.com/en/articles/1)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $0.25 / MTok<sup>1</sup> | $50 / MTok |
| Claude Opus 5.5 | $4 / MTok | $5 / MTok | $8 / MTok | $0.20 / MTok<sup>2</sup> | $20 / MTok |
| Claude Opus 4.8 | $5 / MTok | $6.25 / MTok | $10 / MTok | $0.50 / MTok | $25 / MTok |
| Claude Opus 4.1 ([retired, except on Bedrock](https://platform.claude.com/docs/en/x)) | $15 / MTok | $18.75 / MTok | $30 / MTok | $1.50 / MTok | $75 / MTok |
| Claude Sonnet 5 | $2 / MTok<sup>3</sup> | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok<sup>3</sup> |
| Claude Haiku 5.5 (for prompts up to 100,000 tokens) | $0.10 / MTok | $0.125 / MTok | $0.20 / MTok | $0.01 / MTok | $0.50 / MTok |
| Claude Haiku 5.5 (for prompts over 100,000 tokens) | $0.50 / MTok | $0.625 / MTok | $1 / MTok | $0.05 / MTok | $2.50 / MTok |

*<sup>1 A footnote.</sup>*

## Feature-specific pricing

### Fast mode pricing

| Model | Input | Output |
| ----- | ----- | ------ |
| Claude Opus 5.5 | $8 USD / MTok | $40 USD / MTok |
| Claude Opus 4.8 | $10 USD / MTok | $50 USD / MTok |

### Batch processing

| Model | Batch input | Batch output |
| ----- | ----------- | ------------ |
| Claude Opus 5.5 | $2 / MTok | $10 / MTok |
`;

describe("parseClaudePricing", () => {
  it("reads the model and fast mode rates and skips retired models", () => {
    expect(parseClaudePricing(page).models).toEqual({
      "Claude Mythos 5.1": { input: 10, output: 50 },
      "Claude Opus 5.5": { input: 4, output: 20, fast: { input: 8, output: 40 } },
      "Claude Opus 4.8": { input: 5, output: 25, fast: { input: 10, output: 50 } },
      "Claude Sonnet 5": { input: 2, output: 10 },
      "Claude Haiku 5.5": {
        input: 0.1,
        output: 0.5,
        longPrompt: { input: 0.5, output: 2.5, overInputTokens: 100_000 },
      },
    });
  });

  it("splits a fast mode row shared by several models", () => {
    const shared = page.replace(
      "| Claude Opus 4.8 | $10 USD / MTok | $50 USD / MTok |",
      "| Claude Opus 5.5 / Claude Opus 4.8 | $10 USD / MTok | $50 USD / MTok |",
    );
    expect(parseClaudePricing(shared).models["Claude Opus 4.8"]?.fast).toEqual({
      input: 10,
      output: 50,
    });
  });

  it.each([
    [
      "a price it cannot read",
      page.replace("$4 / MTok |", "$4 per MTok |"),
      /Cannot read the price/,
    ],
    [
      "a renamed column",
      page.replace("Base input tokens", "Input"),
      /no "Base input tokens" column/,
    ],
    [
      "a missing section",
      page.replace("### Fast mode pricing", "### Fast"),
      /no "### Fast mode pricing"/,
    ],
    [
      "an unknown status",
      page.replace("[limited availability]", "[preview]"),
      /Unknown model status/,
    ],
    [
      "a fast mode model without a price",
      page.replace("| Claude Opus 4.8 | $10 USD", "| Claude Opus 9 | $10 USD"),
      /"Claude Opus 9", which has no model price/,
    ],
    [
      "a row of the wrong width",
      page.replace("| Claude Opus 4.8 | $5 / MTok |", "| Claude Opus 4.8 | $5 / MTok | x |"),
      /wrong number of cells/,
    ],
  ])("stops on %s", (_name, markdown, error) => {
    expect(() => parseClaudePricing(markdown)).toThrow(error);
  });
});

describe("claudePricingName", () => {
  it.each([
    ["claude-opus-5-5", "Claude Opus 5.5"],
    ["claude-opus-5", "Claude Opus 5"],
    ["claude-haiku-4-5-20251001", "Claude Haiku 4.5"],
    ["claude-fable-5-1", "Claude Fable 5.1"],
  ])("names %s as %s", (modelId, name) => {
    expect(claudePricingName(modelId)).toBe(name);
  });

  it("names no other shape of ID", () => {
    expect(claudePricingName("gpt-5")).toBeUndefined();
    expect(claudePricingName("claude-opus-5-5-fast")).toBeUndefined();
  });
});
