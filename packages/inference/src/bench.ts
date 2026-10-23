import { wrapLanguageModel } from "ai";
import { createCompletionJudge } from "./completion";
import { evaluationCorpus, type EvaluationCase } from "./corpus/cases";
import { judgeCorpus, type JudgeCase } from "./corpus/judge";
import { evaluateRole, type EvaluationReport } from "./evaluate";
import { asPagePlan, createRecipeGenerator } from "./generation";
import { heuristicPlan } from "./heuristic";
import { evaluateJudge, type JudgeEvaluationReport } from "./judge-evaluate";
import {
  claudeGeneration,
  claudeRefusalCategory,
  claudeWorstCaseRates,
  createClaudeGenerationModel,
  estimateClaudeCostUsd,
  type ClaudeModelChoice,
  type ClaudeRates,
} from "./providers/claude";

// The service's bounds (`ROLE_LIMITS` and `MAX_OUTPUT_TOKENS` in services/api).
const limits = { timeoutMs: 10_000, maxInputBytes: 64 * 1024, maxRetries: 0 };
// Thinking counts toward this bound, so it leaves room beyond the JSON plan itself.
const maxOutputTokens = 1_024;
// Charged for each call whose usage was not reported, so the cap still holds. Treats
// every input byte as a token, which overstates real token counts.
const worstCaseCallUsd = (rates: ClaudeRates) => {
  const { input, output } = claudeWorstCaseRates(rates, limits.maxInputBytes);
  return (limits.maxInputBytes * input + maxOutputTokens * output) / 1_000_000;
};
const maxCallsPerCase = limits.maxRetries + 1;

// The model, recording each model ID and speed the API reports serving.
function benchmarkModel(
  options: { apiKey: string; fetch?: typeof globalThis.fetch },
  choice: ClaudeModelChoice,
) {
  const servedModels = new Set<string>();
  const servedSpeeds = new Set<string>();
  const model = wrapLanguageModel({
    model: createClaudeGenerationModel({
      apiKey: options.apiKey,
      choice,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        servedModels.add(result.response?.modelId ?? "unreported");
        const usage = result.providerMetadata?.["anthropic"]?.["usage"] as
          | { speed?: unknown }
          | undefined;
        servedSpeeds.add(typeof usage?.speed === "string" ? usage.speed : "unreported");
        return result;
      },
    },
  });
  return { model, servedModels, servedSpeeds };
}

export type ClaudeBenchmarkReport = {
  model: string;
  effort: ClaudeModelChoice["effort"];
  speed: "fast" | "standard";
  rates: ClaudeRates;
  /** Model IDs the API reported serving, to show that no other model answered. */
  servedModels: string[];
  /** Speeds the API reported serving at, to show that fast mode ran when asked. */
  servedSpeeds: string[];
  /** Estimated from reported usage; calls without usage count at the worst case. */
  estimatedCostUsd: number;
  report: EvaluationReport;
};

/**
 * Runs the owner-approved paid benchmark (ADR 0014): the generation role over the
 * synthetic corpus, sequentially, with the local value check. Stops before a case whose
 * calls could take the estimated spend past `maxCostUsd` and returns what already ran.
 * `choice` compares another model or effort; the service's own is the default.
 */
export async function runClaudeBenchmark(options: {
  apiKey: string;
  maxCostUsd: number;
  cases?: readonly EvaluationCase[];
  choice?: ClaudeModelChoice;
  /** Test seam only. */
  fetch?: typeof globalThis.fetch;
}): Promise<ClaudeBenchmarkReport> {
  if (!(options.maxCostUsd > 0 && options.maxCostUsd <= 10))
    throw new RangeError("Set a cost cap between 0 and 10 USD");
  const choice = options.choice ?? claudeGeneration;
  const callUsd = worstCaseCallUsd(choice.rates);
  const { model, servedModels, servedSpeeds } = benchmarkModel(options, choice);
  const generate = createRecipeGenerator({
    model,
    limits,
    maxOutputTokens,
    refusalCategory: claudeRefusalCategory,
  });
  let spent = 0;
  const report = await evaluateRole({
    cases: options.cases ?? evaluationCorpus,
    checkValues: true,
    shouldRun: () => spent + maxCallsPerCase * callUsd <= options.maxCostUsd,
    run: async (testCase) => {
      const outcome = await generate({ observation: testCase.observation, slots: testCase.slots });
      spent += estimateClaudeCostUsd(outcome.usage, choice.rates) ?? outcome.calls * callUsd;
      return asPagePlan(outcome);
    },
  });
  return {
    model: choice.modelId,
    effort: choice.effort,
    speed: "speed" in choice && choice.speed ? choice.speed : "standard",
    rates: choice.rates,
    servedModels: [...servedModels],
    servedSpeeds: [...servedSpeeds],
    estimatedCostUsd: spent,
    report,
  };
}

export type ClaudeJudgeBenchmarkReport = Omit<ClaudeBenchmarkReport, "report"> & {
  report: JudgeEvaluationReport;
};

/**
 * The same paid run for the sign-in judge over the synthetic judged pages, scored on the
 * model's own answers in candidate IDs.
 */
export async function runClaudeJudgeBenchmark(options: {
  apiKey: string;
  maxCostUsd: number;
  cases?: readonly JudgeCase[];
  choice?: ClaudeModelChoice;
  /** Test seam only. */
  fetch?: typeof globalThis.fetch;
}): Promise<ClaudeJudgeBenchmarkReport> {
  if (!(options.maxCostUsd > 0 && options.maxCostUsd <= 10))
    throw new RangeError("Set a cost cap between 0 and 10 USD");
  const choice = options.choice ?? claudeGeneration;
  const callUsd = worstCaseCallUsd(choice.rates);
  const { model, servedModels, servedSpeeds } = benchmarkModel(options, choice);
  const judge = createCompletionJudge({
    model,
    limits,
    maxOutputTokens,
    refusalCategory: claudeRefusalCategory,
  });
  let spent = 0;
  const report = await evaluateJudge({
    cases: options.cases ?? judgeCorpus,
    shouldRun: () => spent + maxCallsPerCase * callUsd <= options.maxCostUsd,
    run: async (request) => {
      const outcome = await judge(request);
      spent += estimateClaudeCostUsd(outcome.usage, choice.rates) ?? outcome.calls * callUsd;
      return outcome;
    },
  });
  return {
    model: choice.modelId,
    effort: choice.effort,
    speed: "speed" in choice && choice.speed ? choice.speed : "standard",
    rates: choice.rates,
    servedModels: [...servedModels],
    servedSpeeds: [...servedSpeeds],
    estimatedCostUsd: spent,
    report,
  };
}

/** Scores the model-free comparator on the same cases; free, so it needs no approval. */
export function runHeuristicBenchmark(cases: readonly EvaluationCase[]): Promise<EvaluationReport> {
  return evaluateRole({
    cases,
    checkValues: true,
    run: async (testCase) => heuristicPlan(testCase.observation, testCase.slots),
  });
}
