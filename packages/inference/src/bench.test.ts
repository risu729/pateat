import { describe, expect, it } from "vitest";
import { runClaudeBenchmark } from "./bench";
import { evaluationCorpus } from "./corpus/cases";
import { caseFor } from "./testing/fake-models";

// Answers every corpus page with its ground truth, shaped like the Messages API.
function oracleClaude(
  usage: Record<string, number> = { input_tokens: 3_000, output_tokens: 1_000 },
) {
  let calls = 0;
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    const text = body.messages
      .at(-1)
      .content.find((part: { type: string }) => part.type === "text").text;
    const expected = caseFor(JSON.parse(text).observation).expected;
    const result =
      expected.kind === "abstain"
        ? { decision: "abstain", reason: "ambiguous" }
        : {
            decision: "plan",
            fields: Object.entries(expected.fields).map(([slot, candidate]) => ({
              slot,
              candidate,
            })),
            action: { candidate: expected.action, purpose: expected.purpose },
          };
    return Response.json({
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [{ type: "text", text: JSON.stringify({ result }) }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls: () => calls };
}

describe("Claude benchmark runner", () => {
  it("scores the corpus and estimates spend from reported usage", async () => {
    const claude = oracleClaude();
    const result = await runClaudeBenchmark({
      apiKey: "sk-ant-test-synthetic",
      maxCostUsd: 2,
      fetch: claude.fetch,
    });
    expect(claude.calls()).toBe(evaluationCorpus.length);
    expect(result).toMatchObject({
      model: "claude-opus-5-5",
      effort: "low",
      servedModels: ["claude-opus-5-5"],
    });
    expect(result.report.stoppedBefore).toBeUndefined();
    expect(result.report.semanticAccuracy).toBe(1);
    expect(result.estimatedCostUsd).toBeCloseTo(evaluationCorpus.length * 0.032);
  });

  it("stops before a call that could exceed the cap and keeps the finished cases", async () => {
    const claude = oracleClaude({ input_tokens: 200_000, output_tokens: 10_000 });
    const result = await runClaudeBenchmark({
      apiKey: "sk-ant-test-synthetic",
      maxCostUsd: 1,
      fetch: claude.fetch,
    });
    expect(claude.calls()).toBe(1);
    expect(result.report.total).toBe(1);
    expect(result.report.verdicts.correct).toBe(1);
    expect(result.report.stoppedBefore).toBe(evaluationCorpus[1]!.id);
    expect(result.estimatedCostUsd).toBeCloseTo(1);
  });

  it("charges a call without reported usage at the worst case", async () => {
    const claude = oracleClaude({});
    const result = await runClaudeBenchmark({
      apiKey: "sk-ant-test-synthetic",
      maxCostUsd: 1,
      fetch: claude.fetch,
    });
    // (65,536 input bytes x $4 + 8,192 output tokens x $20) per million, per call.
    expect(result.report.total).toBe(2);
    expect(result.estimatedCostUsd).toBeCloseTo(2 * 0.426_0, 3);
  });

  it.each([0, Number.NaN, 11])("refuses the cap %s", async (maxCostUsd) => {
    await expect(
      runClaudeBenchmark({ apiKey: "sk-ant-test-synthetic", maxCostUsd }),
    ).rejects.toThrow(RangeError);
  });
});
