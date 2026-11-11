import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MODEL_CONFIG,
  DEFAULT_OPENAI_MODEL_CONFIG,
  type ModelConfig,
} from "@pateat/contracts";
import { choiceAttempts, nextAttempt, roleChoices, servedModel } from "@pateat/generation";

afterEach(() => {
  vi.restoreAllMocks();
});
const fastOpenAI = { ...DEFAULT_OPENAI_MODEL_CONFIG.generate[0]!, speed: "fast" as const };
const config: ModelConfig = { generate: [fastOpenAI], judge: DEFAULT_MODEL_CONFIG.judge };
describe("provider-aware inference choices", () => {
  it("uses provider-qualified fast failures and preserves the fallback provider", () => {
    const unaffected = roleChoices(config, "generate", new Set(["anthropic:gpt-6.1-sol"]));
    expect(unaffected[0]).toMatchObject({ provider: "openai", speed: "fast" });
    const choices = roleChoices(config, "generate", new Set(["openai:gpt-6.1-sol"]));
    expect(choices[0]).toMatchObject({
      provider: "openai",
      speed: "standard",
      rates: { input: 2, output: 10 },
    });
    const attempts = choiceAttempts(unaffected[0]!);
    expect(attempts.map((entry) => [entry.provider, entry.modelId, entry.speed])).toEqual([
      ["openai", "gpt-6.1-sol", "fast"],
      ["openai", "gpt-6.1-sol", "standard"],
    ]);
    expect(attempts.map(servedModel)).toEqual([
      { provider: "openai", model: "gpt-6.1-sol", effort: "low", speed: "fast" },
      { provider: "openai", model: "gpt-6.1-sol", effort: "low", speed: "standard" },
    ]);
  });

  it("uses supplied OpenAI defaults when every configured model is unpriced", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bad = { ...fastOpenAI, model: "gpt-unpriced" };
    const choices = roleChoices(
      { ...config, generate: [bad as never] },
      "generate",
      new Set(),
      DEFAULT_OPENAI_MODEL_CONFIG,
    );
    expect(choices.map((entry) => [entry.provider, entry.modelId])).toEqual([
      ["openai", "gpt-6.1-sol"],
      ["openai", "gpt-6.1-terra"],
    ]);
    expect(warn).toHaveBeenCalledWith("Configured model has no price", {
      role: "generate",
      provider: "openai",
      model: "gpt-unpriced",
      speed: "fast",
    });
  });

  it.each(["rate-limited", "provider-error", "timeout"] as const)(
    "retries %s at standard speed only for the same provider and model",
    (error) => {
      const [fast, standard] = choiceAttempts(roleChoices(config, "generate")[0]!);
      const last = {
        outcome: {
          status: "failed" as const,
          error,
          calls: 1,
          usage: { inputTokens: null, outputTokens: null },
        },
        served: servedModel(fast!),
      };
      expect(nextAttempt(last, standard!)).toBe("ask");
      const otherProvider = { ...standard!, provider: "anthropic" as const };
      expect(nextAttempt(last, otherProvider as never)).toBe("stop");
      expect(nextAttempt(last, { ...standard!, modelId: "gpt-6.1-terra" })).toBe("stop");
    },
  );

  it("skips same-model standard mode after refusal and asks the next configured choice", () => {
    const [fast, standard] = choiceAttempts(roleChoices(config, "generate")[0]!);
    const next = roleChoices(DEFAULT_OPENAI_MODEL_CONFIG, "generate")[1]!;
    const last = {
      outcome: {
        status: "failed" as const,
        error: "refused" as const,
        calls: 1,
        usage: { inputTokens: 100, outputTokens: 0 },
      },
      served: servedModel(fast!),
    };
    expect(nextAttempt(last, standard!)).toBe("skip");
    expect(nextAttempt(last, next)).toBe("ask");
    expect(
      nextAttempt({ ...last, outcome: { ...last.outcome, error: "invalid-output" } }, next),
    ).toBe("stop");
  });
});
