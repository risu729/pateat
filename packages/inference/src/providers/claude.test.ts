import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluationCorpus } from "../corpus/cases";
import { createRecipeGenerator } from "../generation";
import { claudeGeneration, createClaudeGenerationModel, estimateClaudeCostUsd } from "./claude";

const page = evaluationCorpus.find((entry) => entry.id === "en-basic")!;
const limits = { timeoutMs: 1_000, maxInputBytes: 16_384 };
const syntheticKey = "sk-ant-test-synthetic";

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };

// Answers like the Messages API without any network I/O.
function fakeClaude(reply: { text: string; stopReason?: string }) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({
      id: "msg_synthetic",
      type: "message",
      role: "assistant",
      model: claudeGeneration.modelId,
      content: [
        { type: "thinking", thinking: "", signature: "synthetic" },
        { type: "text", text: reply.text },
      ],
      stop_reason: reply.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 3_000, output_tokens: 900 },
    });
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

const groundTruth = () => {
  if (page.expected.kind !== "plan") throw new Error("en-basic expects a plan");
  const { fields, action, purpose } = page.expected;
  return JSON.stringify({
    result: {
      decision: "plan",
      fields: Object.entries(fields).map(([slot, candidate]) => ({ slot, candidate })),
      action: { candidate: action, purpose },
    },
  });
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Claude generation adapter", () => {
  it("sends the ADR 0014 configuration to the pinned API host", async () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://proxy.example.test/v1");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-environment");
    const { sent, fetch } = fakeClaude({ text: groundTruth() });
    const generate = createRecipeGenerator({
      model: createClaudeGenerationModel({ apiKey: syntheticKey, fetch }),
      limits,
      maxOutputTokens: 4_096,
    });

    const outcome = await generate({ observation: page.observation, slots: page.slots });

    expect(outcome.status).toBe("ok");
    expect(outcome.usage).toEqual({ inputTokens: 3_000, outputTokens: 900 });
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(request!.headers.get("x-api-key")).toBe(syntheticKey);
    expect(request!.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 4_096,
      output_config: { effort: "low", format: { type: "json_schema" } },
    });
    for (const absent of ["fallbacks", "temperature", "top_p", "top_k", "tools", "tool_choice"])
      expect(request!.body).not.toHaveProperty(absent);
  });

  it("returns a refusal as refused without another attempt", async () => {
    const { sent, fetch } = fakeClaude({ text: "", stopReason: "refusal" });
    const generate = createRecipeGenerator({
      model: createClaudeGenerationModel({ apiKey: syntheticKey, fetch }),
      limits,
      maxOutputTokens: 4_096,
    });

    const outcome = await generate({ observation: page.observation, slots: page.slots });

    expect(outcome).toMatchObject({ status: "failed", error: "refused", calls: 1 });
    expect(sent).toHaveLength(1);
  });

  it("requires an explicit key", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-environment");
    expect(() => createClaudeGenerationModel({ apiKey: " " })).toThrow();
  });

  it("estimates cost only from fully reported usage", () => {
    expect(estimateClaudeCostUsd({ inputTokens: 3_000, outputTokens: 1_000 })).toBeCloseTo(0.032);
    expect(estimateClaudeCostUsd({ inputTokens: 3_000, outputTokens: null })).toBeUndefined();
  });
});
