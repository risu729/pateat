import { splitCodeInputs } from "@pateat/contracts";
import type { CompletionRequest, SignInJudgement } from "./completion";
import type { JudgeCase, JudgeExpected } from "./corpus/judge";
import { percentile } from "./evaluate";
import type { InferenceOutcome } from "./outcome";

/**
 * `false-signed-in` is an answer of signed-in where the truth is not: the worst mistake in
 * judgement, since a marker for a page that is no signed-in page would be stored unless a
 * local check refuses it.
 */
export type JudgeVerdict =
  | "correct"
  | "wrong-detail"
  | "wrong-decision"
  | "false-signed-in"
  | "failed";

/** The judge's own answer in candidate IDs, as `loggedAnswer` keeps it. */
type JudgeAnswer = {
  decision: JudgeExpected["decisions"][number];
  marker?: string;
  passkeyButton?: string;
  passwordButton?: string;
  authenticatorButton?: string;
  code?: { field: string; submit: string; source: string };
};

export type JudgeCaseResult = {
  id: string;
  verdict: JudgeVerdict;
  status: InferenceOutcome<SignInJudgement>["status"];
  reason?: string;
  refusalCategory?: string;
  /** The model's answer in candidate IDs, so a wrong one can be read against the truth. */
  answer?: JudgeAnswer;
  latencyMs: number;
  calls: number;
};

export type JudgeEvaluationReport = {
  total: number;
  verdicts: Record<JudgeVerdict, number>;
  /** Correct answers over the cases attempted. */
  accuracy: number;
  latencyMs: { p50: number; p95: number };
  calls: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    unknownInputCases: number;
    unknownOutputCases: number;
  };
  cases: JudgeCaseResult[];
  stoppedBefore?: string;
};

const detailMatches = (expected: string | null | undefined, named: string | undefined) =>
  expected === undefined || (expected === null ? named === undefined : named === expected);

/** Scores one answer: the decision first, then each detail the truth names. */
export function judgeVerdict(testCase: JudgeCase, answer: JudgeAnswer | undefined): JudgeVerdict {
  if (answer === undefined) return "failed";
  const { expected } = testCase;
  if (!expected.decisions.includes(answer.decision))
    return answer.decision === "signed-in" ? "false-signed-in" : "wrong-decision";
  if (answer.decision === "signed-in")
    return expected.markers?.includes(answer.marker ?? "") ? "correct" : "wrong-detail";
  if (answer.decision !== "challenge") return "correct";
  if (!detailMatches(expected.passkeyButton, answer.passkeyButton)) return "wrong-detail";
  if (!detailMatches(expected.passwordButton, answer.passwordButton)) return "wrong-detail";
  if (!detailMatches(expected.authenticatorButton, answer.authenticatorButton))
    return "wrong-detail";
  if (expected.code === undefined) return "correct";
  if (expected.code === null) return answer.code === undefined ? "correct" : "wrong-detail";
  if (answer.code === undefined) return "wrong-detail";
  // A split code is named by any of its boxes; the judge keeps the first.
  const page = testCase.observation;
  const named = page.candidates.find((candidate) => candidate.id === answer.code!.field);
  const field = named && (splitCodeInputs(page, named)?.[0] ?? named);
  return field?.id === expected.code.field &&
    answer.code.submit === expected.code.submit &&
    expected.code.sources.includes(answer.code.source)
    ? "correct"
    : "wrong-detail";
}

/** Runs the judge over the corpus sequentially and scores the model's own answers. */
export async function evaluateJudge(options: {
  cases: readonly JudgeCase[];
  run: (request: CompletionRequest) => Promise<InferenceOutcome<SignInJudgement>>;
  now?: () => number;
  shouldRun?: (testCase: JudgeCase) => boolean;
}): Promise<JudgeEvaluationReport> {
  const now = options.now ?? (() => performance.now());
  const results: JudgeCaseResult[] = [];
  const report: JudgeEvaluationReport = {
    total: 0,
    verdicts: {
      correct: 0,
      "wrong-detail": 0,
      "wrong-decision": 0,
      "false-signed-in": 0,
      failed: 0,
    },
    accuracy: 0,
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
    // Sequential on purpose, as in `evaluateRole`.
    // oxlint-disable-next-line no-await-in-loop
    const outcome = await options.run({
      observation: testCase.observation,
      loginPaths: testCase.loginPaths,
      ...(testCase.stop ? { stop: true } : {}),
    });
    const latencyMs = now() - started;
    const answer = outcome.answer as JudgeAnswer | undefined;
    const verdict = judgeVerdict(testCase, answer);
    report.verdicts[verdict] += 1;
    report.calls += outcome.calls;
    const { inputTokens, outputTokens } = outcome.usage;
    if (inputTokens === null) report.usage.unknownInputCases += 1;
    else report.usage.inputTokens += inputTokens;
    if (outputTokens === null) report.usage.unknownOutputCases += 1;
    else report.usage.outputTokens += outputTokens;
    results.push({
      id: testCase.id,
      verdict,
      status: outcome.status,
      ...(outcome.status === "abstained" ? { reason: outcome.reason } : {}),
      ...(outcome.status === "failed" ? { reason: outcome.error } : {}),
      ...(outcome.status === "failed" && outcome.refusalCategory !== undefined
        ? { refusalCategory: outcome.refusalCategory }
        : {}),
      ...(answer === undefined ? {} : { answer }),
      latencyMs,
      calls: outcome.calls,
    });
  }
  report.total = results.length;
  report.accuracy = report.total === 0 ? 0 : report.verdicts.correct / report.total;
  const latencies = results.map((result) => result.latencyMs);
  report.latencyMs = { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) };
  return report;
}
