import { describe, expect, it } from "vitest";
import { runClaudeBenchmark, runClaudeJudgeBenchmark } from "./bench";
import { evaluationCorpus, expectedFields } from "./corpus/cases";
import { judgeCorpus } from "./corpus/judge";
import { claudeBenchmarkModels, claudeFastModeRates } from "./providers/claude";
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
            pageKind: "sign-in",
            irreversible: "no",
            fields: expectedFields(expected),
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
    // (65,536 input bytes x $4 + 1,024 output tokens x $20) per million, per call.
    expect(result.report.total).toBe(3);
    expect(result.estimatedCostUsd).toBeCloseTo(3 * 0.282_6, 3);
  });

  it("reports the refusal category of a refused case", async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return Response.json({
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: "refusal",
        stop_sequence: null,
        stop_details: { type: "refusal", category: "cyber", explanation: "synthetic" },
        usage: { input_tokens: 1_000, output_tokens: 0 },
      });
    }) as typeof globalThis.fetch;
    const result = await runClaudeBenchmark({
      apiKey: "sk-ant-test-synthetic",
      maxCostUsd: 2,
      cases: evaluationCorpus.slice(0, 1),
      fetch,
    });
    expect(calls).toBe(1);
    expect(result.report.errors).toEqual({ refused: 1 });
    expect(result.report.cases[0]).toMatchObject({ reason: "refused", refusalCategory: "cyber" });
  });

  it("runs another model and effort at that model's rates", async () => {
    const sent: { model: string; effort: unknown }[] = [];
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      sent.push({ model: body.model, effort: body.output_config?.effort });
      return Response.json({
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [
          {
            type: "text",
            text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }),
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1_000_000, output_tokens: 0 },
      });
    }) as typeof globalThis.fetch;
    const result = await runClaudeBenchmark({
      apiKey: "sk-ant-test-synthetic",
      maxCostUsd: 2,
      cases: evaluationCorpus.slice(0, 1),
      choice: {
        modelId: "claude-haiku-5-5",
        effort: "medium",
        rates: claudeBenchmarkModels["claude-haiku-5-5"],
      },
      fetch,
    });
    expect(sent).toEqual([{ model: "claude-haiku-5-5", effort: "medium" }]);
    expect(result).toMatchObject({ model: "claude-haiku-5-5", effort: "medium" });
    expect(result.servedModels).toEqual(["claude-haiku-5-5"]);
    expect(result.estimatedCostUsd).toBeCloseTo(0.1);
  });

  it("asks for fast mode and reports the speed served", async () => {
    const sent: { speed: unknown; beta: string | null }[] = [];
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      sent.push({ speed: body.speed, beta: new Headers(init?.headers).get("anthropic-beta") });
      return Response.json({
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [
          {
            type: "text",
            text: JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }),
          },
        ],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1_000_000, output_tokens: 0, speed: "fast" },
      });
    }) as typeof globalThis.fetch;
    const result = await runClaudeBenchmark({
      apiKey: "sk-ant-test-synthetic",
      maxCostUsd: 9,
      cases: evaluationCorpus.slice(0, 1),
      choice: {
        modelId: "claude-opus-5-5",
        effort: "low",
        rates: claudeFastModeRates["claude-opus-5-5"],
        speed: "fast",
      },
      fetch,
    });
    expect(sent).toEqual([
      { speed: "fast", beta: expect.stringContaining("fast-mode-2026-02-01") },
    ]);
    expect(result).toMatchObject({ speed: "fast", servedSpeeds: ["fast"] });
    expect(result.estimatedCostUsd).toBeCloseTo(8);
  });

  it("scores the judge on its own answers", async () => {
    const fetch = (async () =>
      Response.json({
        id: "msg_synthetic",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [{ type: "text", text: JSON.stringify({ result: { decision: "unclear" } }) }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 2_000, output_tokens: 100 },
      })) as typeof globalThis.fetch;
    const result = await runClaudeJudgeBenchmark({
      apiKey: "sk-ant-test-synthetic",
      maxCostUsd: 2,
      fetch,
    });
    const unclear = judgeCorpus.filter((entry) => entry.expected.decisions.includes("unclear"));
    expect(result.report.total).toBe(judgeCorpus.length);
    expect(result.report.verdicts.correct).toBe(unclear.length);
    expect(result.report.verdicts["wrong-decision"]).toBe(judgeCorpus.length - unclear.length);
    expect(result.estimatedCostUsd).toBeCloseTo(judgeCorpus.length * 0.01);
  });

  it.each([0, Number.NaN, 11])("refuses the cap %s", async (maxCostUsd) => {
    await expect(
      runClaudeBenchmark({ apiKey: "sk-ant-test-synthetic", maxCostUsd }),
    ).rejects.toThrow(RangeError);
  });
});
