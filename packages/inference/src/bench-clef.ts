import { evaluationCorpus, type EvaluationCase, type ScoredResult } from "./corpus/cases";
import { createFieldMappingDecider, type FiniteChoiceModel } from "./decision";
import { evaluateRole, type EvaluationReport } from "./evaluate";
import {
  clefModels,
  createClefDecisionModel,
  estimateClefCostUsd,
  type ClefModelId,
} from "./providers/clef";

type DecideResult = Awaited<ReturnType<FiniteChoiceModel["doDecide"]>>;

// Room left in each model's context for what Clef adds around the state and questions.
const contextMargin = 2_048;
/**
 * The bounds of a Clef run: the service's own for generation, with the input capped below
 * the model's context. Bytes stand in for tokens, which they overstate for this content.
 */
export function clefLimits(modelId: ClefModelId) {
  return {
    timeoutMs: 10_000,
    maxInputBytes: Math.min(64 * 1024, clefModels[modelId].contextTokens - contextMargin),
    maxRetries: 0,
  };
}

/**
 * Whether Clef's questions can express the case's truth: a sign-in form's fields and
 * action, or an abstention, on a request with slots to map. Lists of accounts (ADR 0028),
 * sign-in entries (ADR 0031), passkey-only pages (ADR 0053) and other requests without
 * slots still run, to count the plans Clef would wrongly submit; a request without slots
 * fails as `invalid-request` before any call.
 */
export function clefCanAnswer(testCase: EvaluationCase<ScoredResult>): boolean {
  const { request, expected } = testCase;
  return (
    (expected.kind === "plan" || expected.kind === "abstain") &&
    testCase.slots.length > 0 &&
    request?.entry !== true &&
    request?.passkeyOnly !== true
  );
}

/** Reverses each choice question's option order, to see whether the order sways answers. */
function reversingOptions(model: FiniteChoiceModel): FiniteChoiceModel {
  return {
    ...model,
    doDecide: (options) =>
      model.doDecide({
        ...options,
        questions: Object.fromEntries(
          Object.entries(options.questions).map(([id, question]) => [
            id,
            question.type === "choice"
              ? {
                  ...question,
                  criteria: Object.fromEntries(Object.entries(question.criteria).reverse()),
                }
              : question,
          ]),
        ),
      }),
  };
}

export type ClefBenchmarkReport = {
  model: ClefModelId;
  /** Model names Workers AI reported serving, to show that no other model answered. */
  servedModels: string[];
  minProbability: number;
  reverseOptions: boolean;
  /** Estimated from reported input tokens; calls without usage count at the worst case. */
  estimatedCostUsd: number;
  /** Cases whose truth Clef's questions cannot express; see `clefCanAnswer`. */
  notApplicable: string[];
  /**
   * Every answer each case's call returned, under the role's question IDs, with each
   * option's probability, so a threshold can be chosen later without another run.
   */
  answers: Record<string, DecideResult["answers"]>;
  report: EvaluationReport;
};

/**
 * Runs the finite-choice role on Clef over the cases, sequentially, with the local value
 * check, and stops before a case whose call could take the estimated spend past
 * `maxCostUsd`. Workers AI bills the owner's Cloudflare account, so a run needs the owner's
 * approval like a Claude run (ADR 0014).
 */
export async function runClefBenchmark(options: {
  accountId: string;
  apiToken: string;
  modelId: ClefModelId;
  maxCostUsd: number;
  cases?: readonly EvaluationCase<ScoredResult>[];
  /** The role's threshold; every probability is kept, so later thresholds need no run. */
  minProbability?: number;
  reverseOptions?: boolean;
  /** Test seam only. */
  fetch?: typeof globalThis.fetch;
}): Promise<ClefBenchmarkReport> {
  if (!(options.maxCostUsd > 0 && options.maxCostUsd <= 10))
    throw new RangeError("Set a cost cap between 0 and 10 USD");
  const { modelId } = options;
  const limits = clefLimits(modelId);
  // Each input byte charged as a token, the most a call within the limits can cost.
  const worstCaseCallUsd = estimateClefCostUsd(limits.maxInputBytes, modelId)!;
  const minProbability = options.minProbability ?? 0.5;
  const reverseOptions = options.reverseOptions ?? false;
  const clef = createClefDecisionModel({
    accountId: options.accountId,
    apiToken: options.apiToken,
    modelId,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const servedModels = new Set<string>();
  const answers: ClefBenchmarkReport["answers"] = {};
  let current = "";
  const recording: FiniteChoiceModel = {
    ...clef,
    doDecide: async (call) => {
      const result = await clef.doDecide(call);
      servedModels.add(result.response?.modelId ?? "unreported");
      // The role asks each page in two calls; both answers stay under the page.
      answers[current] = { ...answers[current], ...result.answers };
      return result;
    },
  };
  const decide = createFieldMappingDecider({
    model: reverseOptions ? reversingOptions(recording) : recording,
    limits,
    minProbability,
  });
  const cases = options.cases ?? evaluationCorpus;
  let spent = 0;
  const report = await evaluateRole({
    cases,
    checkValues: true,
    shouldRun: () => spent + (limits.maxRetries + 1) * worstCaseCallUsd <= options.maxCostUsd,
    run: async (testCase) => {
      current = testCase.id;
      // As the service asks: a later page and the signed-in hint as the log recorded them.
      const { startPage, signedIn } = testCase.request ?? {};
      const outcome = await decide({
        observation: testCase.observation,
        slots: testCase.slots,
        ...(startPage === undefined ? {} : { startPage }),
        ...(signedIn === undefined ? {} : { signedIn }),
      });
      spent +=
        estimateClefCostUsd(outcome.usage.inputTokens, modelId) ?? outcome.calls * worstCaseCallUsd;
      return outcome;
    },
  });
  return {
    model: modelId,
    servedModels: [...servedModels],
    minProbability,
    reverseOptions,
    estimatedCostUsd: spent,
    notApplicable: cases.filter((testCase) => !clefCanAnswer(testCase)).map(({ id }) => id),
    answers,
    report,
  };
}
