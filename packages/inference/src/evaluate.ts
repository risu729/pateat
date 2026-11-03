import type { PageKind } from "@pateat/contracts";
import type { EvaluationCase, ExpectedResult, ScoredResult } from "./corpus/cases";
import type { AbstentionReason, InferenceErrorCode, InferenceOutcome } from "./outcome";
import type { GeneratedPageRejection, ValidatedPagePlan } from "./plan";
import { checkPlanValues } from "./values";

export type Verdict = "correct" | "correct-abstention" | "missed" | "false-submit" | "failed";
/**
 * A scored plan; a generated one may also name the passkey sign-in button (ADR 0027) and
 * answer the page's kind (ADR 0035).
 */
type ScoredPlan = ValidatedPagePlan & { passkeyButton?: string | undefined; pageKind?: PageKind };
/**
 * A role's answer for a page that lists accounts (ADR 0028) or for a page's sign-in entry
 * (ADR 0031), in candidate IDs.
 */
export type ScoredListOrEntry =
  | { accountList: true; other?: string; continue?: string; passkeyButton?: string }
  | { entry: string };
/** Any answer the evaluation scores. */
export type ScoredAnswer = ScoredPlan | ScoredListOrEntry;
const isPlan = (answer: ScoredAnswer): answer is ScoredPlan => "fields" in answer;

export type CaseResult = {
  id: string;
  locale: EvaluationCase["locale"];
  verdict: Verdict;
  /** The ground truth's kind, so results can be grouped by kind of page. */
  expected: ScoredResult["kind"];
  /** Who labelled a request-log page's truth, so scores can be reported per source. */
  labelSource?: string;
  status: InferenceOutcome<ValidatedPagePlan>["status"];
  reason?: AbstentionReason | InferenceErrorCode;
  /** Why the plan check rejected an `invalid-output` plan, so a failure can be read. */
  detail?: GeneratedPageRejection;
  /** The provider's refusal category code for a `refused` case, when reported. */
  refusalCategory?: string;
  /** The executable plan in candidate IDs, so a wrong answer can be read against the truth. */
  plan?: {
    fields: Record<string, string>;
    action: string;
    purpose: "advance" | "submit";
    accountSwitch?: string;
    passkeyButton?: string;
    pageKind?: PageKind;
  };
  /** The answered list of accounts, in candidate IDs. */
  list?: { other?: string; continue?: string; passkeyButton?: string };
  /** The answered sign-in entry's candidate ID. */
  entry?: string;
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
  /**
   * The passkey sign-in button (ADR 0027), scored apart from the verdicts over the plans
   * returned: of the plans for cases whose truth names one (`expected`), how many named it
   * (`correct`) or none (`missed`); `wrong` counts plans that named another button, or one
   * where the truth names none.
   */
  passkeyButtons: SideScore;
  /**
   * The control that uses another account (ADR 0027), scored the same way over the plans
   * returned for cases whose truth is a plan.
   */
  accountSwitches: SideScore;
  /**
   * The page kind each returned plan answered (ADR 0035), apart from the verdicts. Every
   * corpus page is a sign-in page, so `confirm` and `unclear` count pages whose recipe
   * would never log in.
   */
  pageKinds: Record<PageKind, number>;
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

/** A control scored apart from the verdicts: see `passkeyButtons`. */
export type SideScore = { expected: number; correct: number; missed: number; wrong: number };

function scoreSide(score: SideScore, truth: string | undefined, named: string | undefined) {
  if (truth !== undefined) score.expected += 1;
  if (named === undefined) score.missed += truth === undefined ? 0 : 1;
  else if (named === truth) score.correct += 1;
  else score.wrong += 1;
}

const sameSet = (
  set: { fields: Record<string, string>; action: string },
  plan: ValidatedPagePlan,
) =>
  plan.action.candidate === set.action &&
  plan.fields.length === Object.keys(set.fields).length &&
  plan.fields.every((field) => set.fields[field.slot] === field.candidate);

/**
 * The plan fills the truth's fields and presses its action, or one of the truth's
 * alternative identifier sets (ADR 0027): each signs in to the same account, so a plan
 * whose main set is another of the page's sets logs in as well.
 */
const matches = (expected: Extract<ExpectedResult, { kind: "plan" }>, plan: ValidatedPagePlan) =>
  plan.action.purpose === expected.purpose &&
  [expected, ...(expected.alternatives ?? [])].some((set) => sameSet(set, plan));

/**
 * Scores one outcome. Any answer other than the truth's own decision is a false submit:
 * a form plan on a list of accounts, a list or an entry on a sign-in form.
 */
export function judge(expected: ScoredResult, outcome: InferenceOutcome<ScoredAnswer>): Verdict {
  if (outcome.status === "failed") return "failed";
  if (outcome.status === "abstained")
    return expected.kind === "abstain" ? "correct-abstention" : "missed";
  const answer = outcome.value;
  if (isPlan(answer))
    return expected.kind === "plan" && matches(expected, answer) ? "correct" : "false-submit";
  if ("accountList" in answer)
    return expected.kind === "account-list" &&
      answer.other === expected.other &&
      answer.continue === expected.continue
      ? "correct"
      : "false-submit";
  return expected.kind === "entry" && answer.entry === expected.entry ? "correct" : "false-submit";
}

/** Nearest-rank percentile; 0 for an empty sample. */
export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;
}

function withValueCheck(
  testCase: EvaluationCase<ScoredResult>,
  outcome: InferenceOutcome<ScoredAnswer>,
  enabled: boolean | undefined,
): InferenceOutcome<ScoredAnswer> {
  // A mismatch on an expected-abstain case would score as a correct abstention; such
  // cases should not carry values unless that is the point of the case.
  if (
    !enabled ||
    outcome.status !== "ok" ||
    !isPlan(outcome.value) ||
    testCase.values === undefined
  )
    return outcome;
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
export async function evaluateRole<Case extends EvaluationCase<ScoredResult>>(options: {
  cases: readonly Case[];
  run: (testCase: Case) => Promise<InferenceOutcome<ScoredAnswer>>;
  now?: () => number;
  /**
   * Apply the local value check to plans for cases that carry synthetic values, as the
   * trusted side would before filling. A mismatch is scored as a value-mismatch abstention.
   */
  checkValues?: boolean;
  /** Return false to stop before this case, for example at a spending cap. */
  shouldRun?: (testCase: Case) => boolean;
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
    passkeyButtons: { expected: 0, correct: 0, missed: 0, wrong: 0 },
    accountSwitches: { expected: 0, correct: 0, missed: 0, wrong: 0 },
    pageKinds: { "sign-in": 0, confirm: 0, unclear: 0 },
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
    const answer = outcome.status === "ok" ? outcome.value : undefined;
    const plan = answer !== undefined && isPlan(answer) ? answer : undefined;
    const list = answer !== undefined && "accountList" in answer ? answer : undefined;
    if (plan !== undefined && testCase.expected.kind === "plan") {
      scoreSide(report.passkeyButtons, testCase.expected.passkeyButton, plan.passkeyButton);
      scoreSide(report.accountSwitches, testCase.expected.accountSwitch, plan.accountSwitch);
    }
    if (list !== undefined && testCase.expected.kind === "account-list")
      scoreSide(report.passkeyButtons, testCase.expected.passkeyButton, list.passkeyButton);
    if (plan?.pageKind !== undefined) report.pageKinds[plan.pageKind] += 1;
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
      expected: testCase.expected.kind,
      ...("labelSource" in testCase && typeof testCase.labelSource === "string"
        ? { labelSource: testCase.labelSource }
        : {}),
      status: outcome.status,
      ...(reason === undefined ? {} : { reason }),
      ...(outcome.status === "failed" && outcome.detail !== undefined
        ? { detail: outcome.detail }
        : {}),
      ...(outcome.status === "failed" && outcome.refusalCategory !== undefined
        ? { refusalCategory: outcome.refusalCategory }
        : {}),
      ...(plan === undefined
        ? {}
        : {
            plan: {
              fields: Object.fromEntries(plan.fields.map((field) => [field.slot, field.candidate])),
              action: plan.action.candidate,
              purpose: plan.action.purpose,
              ...(plan.accountSwitch === undefined ? {} : { accountSwitch: plan.accountSwitch }),
              ...(plan.passkeyButton === undefined ? {} : { passkeyButton: plan.passkeyButton }),
              ...(plan.pageKind === undefined ? {} : { pageKind: plan.pageKind }),
            },
          }),
      ...(list === undefined
        ? {}
        : {
            list: {
              ...(list.other === undefined ? {} : { other: list.other }),
              ...(list.continue === undefined ? {} : { continue: list.continue }),
              ...(list.passkeyButton === undefined ? {} : { passkeyButton: list.passkeyButton }),
            },
          }),
      ...(answer !== undefined && "entry" in answer ? { entry: answer.entry } : {}),
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
