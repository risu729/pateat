import { describe, expect, it } from "vitest";
import { evaluationCorpus, type EvaluationCase } from "./corpus/cases";
import { evaluateRole, judge, percentile } from "./evaluate";
import type { InferenceOutcome } from "./outcome";
import { isActionRole, slotFitsRole, validatePagePlan, type ValidatedPagePlan } from "./plan";

const usage = { inputTokens: 10, outputTokens: null };

/** A naive baseline: first compatible field per slot and the first action element. */
function firstMatch(entry: EvaluationCase): InferenceOutcome<ValidatedPagePlan> {
  const used = new Set<string>();
  const fields = entry.slots.flatMap((slot) => {
    const candidate = entry.observation.candidates.find(
      (item) => slotFitsRole(slot.kind, item.role) && !used.has(item.id),
    );
    if (candidate === undefined) return [];
    used.add(candidate.id);
    return [{ slot: slot.id, candidate: candidate.id }];
  });
  const action = entry.observation.candidates.find((item) => isActionRole(item.role));
  const result = validatePagePlan(entry.observation, entry.slots, {
    fields,
    action: { candidate: action?.id ?? "", purpose: "submit" },
  });
  return result.ok
    ? { status: "ok", value: result.plan, calls: 1, usage }
    : { status: "failed", error: "invalid-output", detail: result.reason, calls: 1, usage };
}

describe("evaluation harness", () => {
  it("counts the decoy pages a naive mapping would submit wrongly", async () => {
    const report = await evaluateRole({
      cases: evaluationCorpus,
      run: async (entry) => firstMatch(entry),
    });
    const byId = Object.fromEntries(report.cases.map((result) => [result.id, result.verdict]));
    expect(byId["en-basic"]).toBe("correct");
    // Local same-form validation rejects the search box paired with the login password.
    expect(byId["en-search-decoy"]).toBe("failed");
    expect(byId["en-label-injection"]).toBe("false-submit");
    expect(byId["ja-bank-branch-account"]).toBe("false-submit");
    expect(byId["en-newsletter-only"]).toBe("false-submit");
    expect(report.falseSubmits).toBeGreaterThanOrEqual(3);
    expect(report.jointMappingRejections).toBeGreaterThanOrEqual(1);
    expect(report.semanticAccuracy).toBeLessThan(1);
    expect(report.usage).toEqual({
      inputTokens: 10 * evaluationCorpus.length,
      outputTokens: 0,
      unknownInputCases: 0,
      unknownOutputCases: evaluationCorpus.length,
    });
  });

  it("turns plans that contradict the real values into value-mismatch abstentions", async () => {
    const bank = evaluationCorpus.find((item) => item.id === "ja-bank-unlabeled-lengths")!;
    const unchecked = await evaluateRole({
      cases: [bank],
      run: async (entry) => firstMatch(entry),
    });
    expect(unchecked.cases[0]!.verdict).toBe("false-submit");
    const checked = await evaluateRole({
      cases: [bank],
      run: async (entry) => firstMatch(entry),
      checkValues: true,
    });
    expect(checked.cases[0]).toMatchObject({ verdict: "missed", reason: "value-mismatch" });
    expect(checked.abstentions).toEqual({ "value-mismatch": 1 });
    expect(checked.falseSubmits).toBe(0);
  });

  it("keeps every ground-truth plan consistent with its synthetic values", async () => {
    const report = await evaluateRole({
      cases: evaluationCorpus,
      checkValues: true,
      run: async (entry) => {
        if (entry.expected.kind === "abstain")
          return { status: "abstained", reason: "ambiguous", calls: 0, usage };
        const result = validatePagePlan(entry.observation, entry.slots, {
          fields: Object.entries(entry.expected.fields).map(([slot, candidate]) => ({
            slot,
            candidate,
          })),
          action: { candidate: entry.expected.action, purpose: entry.expected.purpose },
        });
        if (!result.ok) throw new Error(entry.id);
        return { status: "ok", value: result.plan, calls: 0, usage };
      },
    });
    expect(report.semanticAccuracy).toBe(1);
  });

  it("separates abstentions, misses and failures", async () => {
    const plain = evaluationCorpus.find((item) => item.id === "en-basic")!;
    const ambiguous = evaluationCorpus.find((item) => item.id === "ja-unlabeled-ambiguous")!;
    const outcomes: InferenceOutcome<ValidatedPagePlan>[] = [
      { status: "abstained", reason: "ambiguous", calls: 1, usage },
      { status: "abstained", reason: "low-confidence", calls: 1, usage },
      { status: "failed", error: "timeout", calls: 2, usage },
    ];
    const cases = [ambiguous, plain, plain];
    let index = 0;
    const report = await evaluateRole({ cases, run: async () => outcomes[index++]! });
    expect(report.verdicts).toEqual({
      correct: 0,
      "correct-abstention": 1,
      missed: 1,
      "false-submit": 0,
      failed: 1,
    });
    expect(report.abstentions).toEqual({ ambiguous: 1, "low-confidence": 1 });
    expect(report.errors).toEqual({ timeout: 1 });
    expect(report.calls).toBe(4);
    expect(report.semanticAccuracy).toBeCloseTo(1 / 3);
  });

  it("measures latency with the supplied clock", async () => {
    let clock = 0;
    const durations = [5, 50, 10, 20, 400];
    let index = 0;
    const report = await evaluateRole({
      cases: evaluationCorpus.slice(0, 5),
      now: () => clock,
      run: async () => {
        clock += durations[index++]!;
        return { status: "abstained", reason: "ambiguous", calls: 1, usage };
      },
    });
    expect(report.latencyMs).toEqual({ p50: 20, p95: 400 });
  });

  it("judges a plan with the right fields but wrong purpose as a false submit", () => {
    const entry = evaluationCorpus.find((item) => item.id === "en-identifier-first")!;
    const result = validatePagePlan(entry.observation, entry.slots, {
      fields: [{ slot: "email", candidate: "identifier" }],
      action: { candidate: "next", purpose: "submit" },
    });
    if (!result.ok) throw new Error("expected a valid plan");
    expect(judge(entry.expected, { status: "ok", value: result.plan, calls: 1, usage })).toBe(
      "false-submit",
    );
  });

  it("uses nearest-rank percentiles", () => {
    expect(percentile([], 0.5)).toBe(0);
    expect(percentile([3, 1, 2], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
  });
});
