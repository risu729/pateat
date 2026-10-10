import { wrapLanguageModel } from "ai";
import { evaluationCorpus, type EvaluationCase } from "./corpus/cases";
import { evaluateRole, type EvaluationReport } from "./evaluate";
import { createRecipeGenerator } from "./generation";
import {
  claudeGeneration,
  createClaudeGenerationModel,
  estimateClaudeCostUsd,
} from "./providers/claude";

const limits = { timeoutMs: 60_000, maxInputBytes: 64 * 1024, maxRetries: 0 };
// Thinking counts toward this bound, so it leaves room beyond the JSON plan itself.
const maxOutputTokens = 8_192;
// Charged for each call whose usage was not reported, so the cap still holds. Treats
// every input byte as a token, which overstates real token counts.
const worstCaseCallUsd =
  (limits.maxInputBytes * claudeGeneration.rates.input +
    maxOutputTokens * claudeGeneration.rates.output) /
  1_000_000;
const maxCallsPerCase = limits.maxRetries + 1;

export type ClaudeBenchmarkReport = {
  model: typeof claudeGeneration.modelId;
  effort: typeof claudeGeneration.effort;
  rates: typeof claudeGeneration.rates;
  /** Model IDs the API reported serving, to show that no other model answered. */
  servedModels: string[];
  /** Estimated from reported usage; calls without usage count at the worst case. */
  estimatedCostUsd: number;
  report: EvaluationReport;
};

/**
 * Runs the owner-approved paid benchmark (ADR 0014): the generation role over the
 * synthetic corpus, sequentially, with the local value check. Stops before a case whose
 * calls could take the estimated spend past `maxCostUsd` and returns what already ran.
 */
export async function runClaudeBenchmark(options: {
  apiKey: string;
  maxCostUsd: number;
  cases?: readonly EvaluationCase[];
  /** Test seam only. */
  fetch?: typeof globalThis.fetch;
}): Promise<ClaudeBenchmarkReport> {
  if (!(options.maxCostUsd > 0 && options.maxCostUsd <= 10))
    throw new RangeError("Set a cost cap between 0 and 10 USD");
  const servedModels = new Set<string>();
  const model = wrapLanguageModel({
    model: createClaudeGenerationModel({
      apiKey: options.apiKey,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        servedModels.add(result.response?.modelId ?? "unreported");
        return result;
      },
    },
  });
  const generate = createRecipeGenerator({ model, limits, maxOutputTokens });
  let spent = 0;
  const report = await evaluateRole({
    cases: options.cases ?? evaluationCorpus,
    checkValues: true,
    shouldRun: () => spent + maxCallsPerCase * worstCaseCallUsd <= options.maxCostUsd,
    run: async (testCase) => {
      const outcome = await generate({ observation: testCase.observation, slots: testCase.slots });
      spent += estimateClaudeCostUsd(outcome.usage) ?? outcome.calls * worstCaseCallUsd;
      return outcome;
    },
  });
  return {
    model: claudeGeneration.modelId,
    effort: claudeGeneration.effort,
    rates: claudeGeneration.rates,
    servedModels: [...servedModels],
    estimatedCostUsd: spent,
    report,
  };
}
