import type { EvaluationCase, ExpectedResult } from "./corpus/cases";
import type { AbstentionReason, InferenceErrorCode, InferenceOutcome } from "./outcome";
import type { ValidatedPagePlan } from "./plan";
import { checkPlanValues } from "./values";

export type Verdict = "correct" | "correct-abstention" | "missed" | "false-submit" | "failed";

export type CaseResult = {
  id: string;
  locale: EvaluationCase["locale"];
  verdict: Verdict;
  status: InferenceOutcome<ValidatedPagePlan>["status"];
  reason?: AbstentionReason | InferenceErrorCode;
  latencyMs: number;
  calls: number;
};

export type EvaluationReport = {
  total: number;
  verdicts: Record<Verdict, number>;
  /** Correct plans plus correct abstentions, over the cases attempted. */
  semanticAccuracy: number;
  /** Executable plans that would fill or click something other than the ground truth. */
  falseSubmits: number;
  abstentions: Partial<Record<AbstentionReason, number>>;
  errors: Partial<Record<InferenceErrorCode, number>>;
  /** Outputs rejected because slots or the action shared one element or spanned forms. */
  jointMappingRejections: number;
  latencyMs: { p50: number; p95: number };
  calls: number;
  /** Known token sums; cases whose usage was not reported are counted, not treated as zero. */
  usage: {
    inputTokens: number;
    outputTokens: number;
    unknownInputCases: number;
    unknownOutputCases: number;
  };
  cases: CaseResult[];
  /** Set when `shouldRun` stopped the run; later cases were not attempted. */
  stoppedBefore?: string;
};

const matches = (expected: Extract<ExpectedResult, { kind: "plan" }>, plan: ValidatedPagePlan) =>
  plan.action.candidate === expected.action &&
  plan.action.purpose === expected.purpose &&
  plan.fields.length === Object.keys(expected.fields).length &&
  plan.fields.every((field) => expected.fields[field.slot] === field.candidate);

export function judge(
  expected: ExpectedResult,
  outcome: InferenceOutcome<ValidatedPagePlan>,
): Verdict {
  if (outcome.status === "failed") return "failed";
  if (outcome.status === "abstained")
    return expected.kind === "abstain" ? "correct-abstention" : "missed";
  return expected.kind === "plan" && matches(expected, outcome.value) ? "correct" : "false-submit";
}

/** Nearest-rank percentile; 0 for an empty sample. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

function withValueCheck(
  testCase: EvaluationCase,
  outcome: InferenceOutcome<ValidatedPagePlan>,
  enabled: boolean | undefined,
): InferenceOutcome<ValidatedPagePlan> {
  // A mismatch on an expected-abstain case would score as a correct abstention; such
  // cases should not carry values unless that is the point of the case.
  if (!enabled || outcome.status !== "ok" || testCase.values === undefined) return outcome;
  const values = new Map(Object.entries(testCase.values));
  if (checkPlanValues(testCase.observation, outcome.value, values).ok) return outcome;
  return {
    status: "abstained",
    reason: "value-mismatch",
    calls: outcome.calls,
    usage: outcome.usage,
  };
}

/**
 * Runs one role over the corpus sequentially and scores it. The role closure owns
 * its configured model; the harness never selects or falls back between providers.
 */
export async function evaluateRole(options: {
  cases: readonly EvaluationCase[];
  run: (testCase: EvaluationCase) => Promise<InferenceOutcome<ValidatedPagePlan>>;
  now?: () => number;
  /**
   * Apply the local value check to plans for cases that carry synthetic values, as the
   * trusted side would before filling. A mismatch is scored as a value-mismatch abstention.
   */
  checkValues?: boolean;
  /** Return false to stop before this case, for example at a spending cap. */
  shouldRun?: (testCase: EvaluationCase) => boolean;
}): Promise<EvaluationReport> {
  const now = options.now ?? (() => performance.now());
  const results: CaseResult[] = [];
  const report: EvaluationReport = {
    total: 0,
    verdicts: { correct: 0, "correct-abstention": 0, missed: 0, "false-submit": 0, failed: 0 },
    semanticAccuracy: 0,
    falseSubmits: 0,
    abstentions: {},
    errors: {},
    jointMappingRejections: 0,
    latencyMs: { p50: 0, p95: 0 },
    calls: 0,
    usage: { inputTokens: 0, outputTokens: 0, unknownInputCases: 0, unknownOutputCases: 0 },
    cases: results,
  };
  for (const testCase of options.cases) {
    if (options.shouldRun?.(testCase) === false) {
      report.stoppedBefore = testCase.id;
      break;
    }
    const started = now();
    // Sequential on purpose: concurrent calls would distort latency and rate limits.
    // oxlint-disable-next-line no-await-in-loop
    const outcome = withValueCheck(testCase, await options.run(testCase), options.checkValues);
    const latencyMs = now() - started;
    const verdict = judge(testCase.expected, outcome);
    report.verdicts[verdict] += 1;
    report.calls += outcome.calls;
    const { inputTokens, outputTokens } = outcome.usage;
    if (inputTokens === null) report.usage.unknownInputCases += 1;
    else report.usage.inputTokens += inputTokens;
    if (outputTokens === null) report.usage.unknownOutputCases += 1;
    else report.usage.outputTokens += outputTokens;
    let reason: CaseResult["reason"];
    if (outcome.status === "abstained") {
      reason = outcome.reason;
      report.abstentions[reason] = (report.abstentions[reason] ?? 0) + 1;
      if (reason === "inconsistent-mapping") report.jointMappingRejections += 1;
    } else if (outcome.status === "failed") {
      reason = outcome.error;
      report.errors[reason] = (report.errors[reason] ?? 0) + 1;
      if (
        outcome.detail === "duplicate-candidate" ||
        outcome.detail === "duplicate-slot" ||
        outcome.detail === "mixed-groups"
      )
        report.jointMappingRejections += 1;
    }
    results.push({
      id: testCase.id,
      locale: testCase.locale,
      verdict,
      status: outcome.status,
      ...(reason === undefined ? {} : { reason }),
      latencyMs,
      calls: outcome.calls,
    });
  }
  report.total = results.length;
  report.falseSubmits = report.verdicts["false-submit"];
  report.semanticAccuracy =
    report.total === 0
      ? 0
      : (report.verdicts.correct + report.verdicts["correct-abstention"]) / report.total;
  const latencies = results.map((result) => result.latencyMs);
  report.latencyMs = { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) };
  return report;
}
