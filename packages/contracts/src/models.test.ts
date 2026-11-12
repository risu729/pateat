import { describe, expect, it } from "vitest";
import * as v from "valibot";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_OPENAI_MODEL_CONFIG,
  modelChoiceSchema,
  modelConfigSchema,
  manageModelOptionSchema,
} from "./models";

const openai = {
  provider: "openai",
  model: "gpt-6.1-sol",
  effort: "low",
  speed: "standard",
} as const;
describe("provider-bound model contracts", () => {
  it("keeps Anthropic defaults unchanged and OpenAI defaults within OpenAI", () => {
    const claude = [
      { provider: "anthropic", model: "claude-opus-5-5", effort: "low", speed: "standard" },
      { provider: "anthropic", model: "claude-sonnet-5-5", effort: "low", speed: "standard" },
    ];
    expect(DEFAULT_MODEL_CONFIG).toEqual({ generate: claude, judge: claude });
    expect(v.parse(modelConfigSchema, DEFAULT_OPENAI_MODEL_CONFIG)).toEqual({
      generate: [openai, { ...openai, model: "gpt-6.1-terra" }],
      judge: [openai, { ...openai, model: "gpt-6.1-terra" }],
    });
  });

  it.each(["gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-luna"])(
    "accepts the explicitly supported OpenAI model %s",
    (model) => {
      expect(
        v.parse(modelChoiceSchema, { ...openai, model, effort: "max", speed: "fast" }),
      ).toEqual({
        ...openai,
        model,
        effort: "max",
        speed: "fast",
      });
    },
  );

  it.each([
    { ...openai, model: "gpt-unknown" },
    { ...openai, model: "claude-opus-5-5" },
    { ...openai, provider: "anthropic" },
    { ...openai, provider: "proxy" },
    { ...openai, provider: undefined },
    { ...openai, model: "gpt-6.1-sol-2026-11-11" },
    { ...openai, effort: "auto" },
    { ...openai, speed: "priority" },
  ])("rejects unsupported or mismatched provider model settings %#", (choice) => {
    expect(v.safeParse(modelChoiceSchema, choice).success).toBe(false);
  });

  it("accepts ordered explicit cross-provider fallback but refuses duplicate models", () => {
    const generate = [openai, DEFAULT_MODEL_CONFIG.generate[0]!];
    expect(v.parse(modelConfigSchema, { generate, judge: [openai] }).generate).toEqual(generate);
    expect(
      v.safeParse(modelConfigSchema, {
        generate: [openai, { ...openai, speed: "fast" }],
        judge: [openai],
      }).success,
    ).toBe(false);
  });

  it("checks catalogue provider and model together", () => {
    const option = {
      provider: "openai",
      id: "gpt-6.1-sol",
      displayName: "GPT-6.1 Sol",
      efforts: ["low"],
      rates: { input: 2, output: 10 },
      fast: "available",
      fastRates: { input: 4, output: 20 },
    };
    expect(v.safeParse(manageModelOptionSchema, option).success).toBe(true);
    expect(v.safeParse(manageModelOptionSchema, { ...option, provider: "anthropic" }).success).toBe(
      false,
    );
    expect(v.safeParse(manageModelOptionSchema, { ...option, id: "gpt-unknown" }).success).toBe(
      false,
    );
  });
});
