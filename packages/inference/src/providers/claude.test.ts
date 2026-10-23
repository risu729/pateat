import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluationCorpus } from "../corpus/cases";
import { createRecipeGenerator } from "../generation";
import {
  claudeGeneration,
  claudeModelRates,
  claudeRefusalCategory,
  claudeRefusalFallback,
  claudeWorstCaseRates,
  createClaudeGenerationModel,
  estimateClaudeCostUsd,
} from "./claude";

const page = evaluationCorpus.find((entry) => entry.id === "en-basic")!;
const limits = { timeoutMs: 1_000, maxInputBytes: 16_384 };
const syntheticKey = "sk-ant-test-synthetic";

type Sent = { url: string; headers: Headers; body: Record<string, unknown> };

// Answers like the Messages API without any network I/O.
function fakeClaude(reply: { text: string; stopReason?: string; stopDetails?: unknown }) {
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
      ...(reply.stopDetails === undefined ? {} : { stop_details: reply.stopDetails }),
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
      pageKind: "sign-in",
      irreversible: "no",
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

  it("returns a refusal as refused with its category code and no other attempt", async () => {
    const generateWith = (stopDetails: unknown) => {
      const claude = fakeClaude({ text: "", stopReason: "refusal", stopDetails });
      const generate = createRecipeGenerator({
        model: createClaudeGenerationModel({ apiKey: syntheticKey, fetch: claude.fetch }),
        limits,
        maxOutputTokens: 4_096,
        refusalCategory: claudeRefusalCategory,
      });
      return { claude, outcome: generate({ observation: page.observation, slots: page.slots }) };
    };

    const cyber = generateWith({
      type: "refusal",
      category: "cyber",
      explanation: "Declined: synthetic explanation text",
    });
    const outcome = await cyber.outcome;
    expect(outcome).toEqual({
      status: "failed",
      error: "refused",
      refusalCategory: "cyber",
      calls: 1,
      usage: { inputTokens: 3_000, outputTokens: 900 },
    });
    expect(cyber.claude.sent).toHaveLength(1);
    // Only a short code is kept; free text from the provider never enters the outcome.
    const others = await Promise.all(
      [null, "Declined because of page text", undefined].map(
        (category) =>
          generateWith(category === undefined ? undefined : { type: "refusal", category }).outcome,
      ),
    );
    for (const other of others) {
      expect(other).toMatchObject({ status: "failed", error: "refused" });
      expect(other).not.toHaveProperty("refusalCategory");
    }
  });

  it("tells the model whose credentials these are and that values stay local", async () => {
    const { sent, fetch } = fakeClaude({ text: groundTruth() });
    const generate = createRecipeGenerator({
      model: createClaudeGenerationModel({ apiKey: syntheticKey, fetch }),
      limits,
      maxOutputTokens: 4_096,
    });
    await generate({ observation: page.observation, slots: page.slots });
    const system = JSON.stringify(sent[0]!.body["system"]);
    expect(system).toContain("password manager");
    expect(system).toContain("their own account");
    expect(system).toContain(
      "You never see values; the extension fills them after checking your plan.",
    );
  });

  it("sends a federated access token as a bearer token instead of a key", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-environment");
    const { sent, fetch } = fakeClaude({ text: groundTruth() });
    const generate = createRecipeGenerator({
      model: createClaudeGenerationModel({ authToken: "sk-ant-oat01-synthetic", fetch }),
      limits,
      maxOutputTokens: 4_096,
    });

    expect((await generate({ observation: page.observation, slots: page.slots })).status).toBe(
      "ok",
    );
    expect(sent[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer sk-ant-oat01-synthetic");
    expect(sent[0]!.headers.has("x-api-key")).toBe(false);
  });

  it("requires exactly one non-empty credential", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-from-environment");
    expect(() => createClaudeGenerationModel({ apiKey: " " })).toThrow();
    expect(() => createClaudeGenerationModel({ authToken: " " })).toThrow();
    expect(() =>
      createClaudeGenerationModel({
        authToken: "sk-ant-oat01-synthetic",
        apiKey: syntheticKey,
      } as unknown as { authToken: string }),
    ).toThrow(TypeError);
  });

  it("estimates cost only from fully reported usage", () => {
    expect(estimateClaudeCostUsd({ inputTokens: 3_000, outputTokens: 1_000 })).toBeCloseTo(0.032);
    expect(estimateClaudeCostUsd({ inputTokens: 3_000, outputTokens: null })).toBeUndefined();
  });

  it("charges a long prompt the higher rates the pricing page lists", () => {
    const haiku = claudeModelRates("claude-haiku-5-5")!;
    expect(estimateClaudeCostUsd({ inputTokens: 100_000, outputTokens: 0 }, haiku)).toBeCloseTo(
      0.01,
    );
    expect(estimateClaudeCostUsd({ inputTokens: 100_001, outputTokens: 0 }, haiku)).toBeCloseTo(
      0.05,
    );
    expect(claudeWorstCaseRates(haiku)).toEqual({ input: 0.5, output: 2.5 });
  });

  it("prices the service's models from the committed pricing page", () => {
    expect(claudeGeneration.rates).toEqual({ input: 4, output: 20 });
    expect(claudeRefusalFallback.rates).toEqual({ input: 2, output: 10 });
    expect(claudeModelRates("claude-opus-5-5", "fast")).toEqual({ input: 8, output: 40 });
    expect(claudeModelRates("claude-sonnet-5-5", "fast")).toBeUndefined();
    expect(claudeModelRates("claude-opus-9")).toBeUndefined();
  });
});
