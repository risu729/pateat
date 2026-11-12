import { afterEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import { generateText, streamText } from "ai";
import { runStructuredRole } from "../structured";
import { createRecipeGenerator } from "../generation";
import { evaluationCorpus } from "../corpus/cases";
import { createOpenAIGenerationModel, openAIGeneration } from "./openai";
import { openAIModelRates } from "./openai-rates";

const schema = v.strictObject({ answer: v.string(), note: v.optional(v.string()) });
const reportedUsage = {
  input_tokens: 12_000,
  output_tokens: 100,
  total_tokens: 12_100,
  input_tokens_details: {
    cached_tokens: 4_000,
    cache_write_tokens: 7_000,
    cache_write_tokens_details: { ttl_30m_tokens: 3_000, ttl_12h_tokens: 4_000 },
  },
  output_tokens_details: { reasoning_tokens: 80 },
};
const usage = {
  inputTokens: 12_000,
  outputTokens: 100,
  openaiCache: { read: 4_000, write30m: 3_000, write12h: 4_000 },
};
function response(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_synthetic",
    model: openAIGeneration.modelId,
    output: [
      {
        type: "message",
        id: "msg_synthetic",
        role: "assistant",
        content: [{ type: "output_text", text: '{"answer":"accepted"}', annotations: [] }],
      },
    ],
    usage: reportedUsage,
    ...overrides,
  };
}
function transport(replies: Response[] = [Response.json(response())]) {
  const sent: Request[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    sent.push(new Request(input, init));
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected mocked HTTP call");
    return reply;
  });
  return { fetch, sent };
}
const run = (
  model: ReturnType<typeof createOpenAIGenerationModel>,
  maxRetries = 0,
  abortSignal?: AbortSignal,
) =>
  runStructuredRole({
    model,
    instructions: "Return the requested answer.",
    prompt: "Synthetic page only.",
    schema,
    name: "synthetic_answer",
    limits: { maxRetries, timeoutMs: 5_000 },
    maxOutputTokens: 512,
    abortSignal,
    interpret: (value) => ({ status: "ok", value }),
  });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("OpenAI Responses transport through the actual SDK", () => {
  it("runs the recipe role on a synthetic observed page through OpenAI", async () => {
    const page = evaluationCorpus.find((entry) => entry.id === "en-basic")!;
    if (page.expected.kind !== "plan") throw new Error("Synthetic page must expect a plan");
    const expected = page.expected;
    const text = JSON.stringify({
      result: {
        decision: "plan",
        pageKind: "sign-in",
        irreversible: "no",
        fields: Object.entries(expected.fields).map(([slot, candidate]) => ({ slot, candidate })),
        action: { candidate: expected.action, purpose: expected.purpose },
      },
    });
    const { fetch } = transport([
      Response.json(
        response({
          output: [
            {
              type: "message",
              id: "msg_synthetic",
              role: "assistant",
              content: [{ type: "output_text", text, annotations: [] }],
            },
          ],
        }),
      ),
    ]);
    const beforeRequest = vi.fn(async () => {});
    const model = createOpenAIGenerationModel({ apiKey: "synthetic", fetch, beforeRequest });
    const request = { observation: page.observation, slots: page.slots };
    const small = createRecipeGenerator({
      model,
      limits: { timeoutMs: 1_000, maxInputBytes: 1_024 },
      maxOutputTokens: 4_096,
    });
    expect(await small(request)).toMatchObject({
      status: "failed",
      error: "input-too-large",
      calls: 0,
    });
    expect(beforeRequest).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    const generate = createRecipeGenerator({
      model,
      limits: { timeoutMs: 1_000, maxInputBytes: 16_384 },
      maxOutputTokens: 4_096,
    });
    expect(await generate(request)).toMatchObject({ status: "ok", calls: 1, usage });
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it.each(["standard", "fast"] as const)(
    "pins the endpoint, key, privacy and %s settings",
    async (speed) => {
      vi.stubEnv("OPENAI_API_KEY", "synthetic-environment-key");
      vi.stubEnv("OPENAI_BASE_URL", "https://proxy.example.test/v1");
      const { fetch, sent } = transport();
      const model = createOpenAIGenerationModel({
        apiKey: " synthetic-explicit-key ",
        fetch,
        choice: {
          modelId: "gpt-6.1-sol",
          effort: "high",
          speed,
          rates: openAIModelRates("gpt-6.1-sol", speed)!,
        },
      });
      expect(await run(model)).toEqual({
        status: "ok",
        value: { answer: "accepted" },
        calls: 1,
        usage,
      });
      expect(sent).toHaveLength(1);
      const request = sent[0]!;
      expect(request.url).toBe("https://api.openai.com/v1/responses");
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-explicit-key");
      const body = (await request.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        model: "gpt-6.1-sol",
        store: false,
        service_tier: speed === "fast" ? "fast" : "default",
        reasoning: { effort: "high" },
        max_output_tokens: 512,
        text: {
          format: {
            type: "json_schema",
            name: "synthetic_answer",
            strict: false,
            schema: {
              type: "object",
              required: ["answer"],
              properties: { note: { type: "string" } },
            },
          },
        },
      });
      expect(body["reasoning"]).not.toHaveProperty("summary");
      for (const key of ["tools", "tool_choice", "temperature", "top_p", "previous_response_id"])
        expect(body).not.toHaveProperty(key);
    },
  );

  it("refuses missing credentials and unsupported models locally despite environment credentials", () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-environment-key");
    const { fetch } = transport();
    for (const apiKey of ["", " ", undefined])
      expect(() => createOpenAIGenerationModel({ apiKey: apiKey as string, fetch })).toThrow();
    expect(() =>
      createOpenAIGenerationModel({
        apiKey: "synthetic",
        fetch,
        choice: {
          ...openAIGeneration,
          modelId: "gpt-unknown",
        },
      }),
    ).toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("runs the reservation before HTTP and sends nothing when it fails", async () => {
    const { fetch } = transport();
    const beforeRequest = vi.fn(async () => {
      throw new Error("Synthetic reservation denied");
    });
    const result = await run(
      createOpenAIGenerationModel({ apiKey: "synthetic", fetch, beforeRequest }),
    );
    expect(result).toMatchObject({
      status: "failed",
      error: "provider-error",
      calls: 1,
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(beforeRequest).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["bad JSON", "not json"],
    ["wrong type", '{"answer":42}'],
    ["unknown property", '{"answer":"accepted","unexpected":"synthetic"}'],
  ])("validates %s locally even with non-strict provider JSON Schema", async (_, text) => {
    const reply = response({
      output: [
        {
          type: "message",
          id: "msg_synthetic",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
    });
    const { fetch } = transport([Response.json(reply)]);
    expect(await run(createOpenAIGenerationModel({ apiKey: "synthetic", fetch }))).toMatchObject({
      status: "failed",
      error: "invalid-output",
      calls: 1,
      usage,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "refused",
      {
        output: [
          {
            type: "message",
            id: "msg_synthetic",
            role: "assistant",
            content: [{ type: "refusal", refusal: "Synthetic refusal text" }],
          },
        ],
      },
    ],
    ["truncated", { output: [], incomplete_details: { reason: "max_output_tokens" } }],
  ])("retains usage for a %s response without leaking provider text", async (error, overrides) => {
    const { fetch } = transport([Response.json(response(overrides))]);
    const result = await run(createOpenAIGenerationModel({ apiKey: "synthetic", fetch }));
    expect(result).toMatchObject({ status: "failed", error, calls: 1, usage });
    expect(JSON.stringify(result)).not.toContain("Synthetic refusal text");
  });

  it.each([
    [429, "rate-limited"],
    [500, "provider-error"],
    [401, "provider-error"],
  ])("classifies HTTP %s without retrying by default", async (status, error) => {
    const { fetch } = transport([
      Response.json({ error: { message: "Synthetic failure", type: "api_error" } }, { status }),
    ]);
    expect(await run(createOpenAIGenerationModel({ apiKey: "synthetic", fetch }))).toMatchObject({
      status: "failed",
      error,
      calls: 1,
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("bounds retries and keeps totals unknown after an unmetered failed call", async () => {
    const { fetch } = transport([
      Response.json(
        { error: { message: "Synthetic retry", type: "api_error" } },
        { status: 429, headers: { "retry-after-ms": "1" } },
      ),
      Response.json(response()),
    ]);
    expect(await run(createOpenAIGenerationModel({ apiKey: "synthetic", fetch }), 1)).toMatchObject(
      {
        status: "ok",
        calls: 2,
        usage: {
          inputTokens: null,
          outputTokens: null,
          openaiCache: { read: null, write30m: null, write12h: null },
        },
      },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps missing usage unknown instead of treating it as free", async () => {
    const { fetch } = transport([Response.json(response({ usage: null }))]);
    expect(await run(createOpenAIGenerationModel({ apiKey: "synthetic", fetch }))).toMatchObject({
      status: "ok",
      usage: {
        inputTokens: null,
        outputTokens: null,
        openaiCache: { read: null, write30m: null, write12h: null },
      },
    });
  });

  it("stops after the configured retry limit when rate limiting persists", async () => {
    const limited = () =>
      Response.json(
        { error: { message: "Synthetic retry", type: "api_error" } },
        {
          status: 429,
          headers: { "retry-after-ms": "1" },
        },
      );
    const { fetch } = transport([limited(), limited(), Response.json(response())]);
    expect(await run(createOpenAIGenerationModel({ apiKey: "synthetic", fetch }), 1)).toMatchObject(
      {
        status: "failed",
        error: "rate-limited",
        calls: 2,
        usage: { inputTokens: null, outputTokens: null },
      },
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("refuses tools, assistant history and streaming before HTTP", async () => {
    const { fetch } = transport();
    const model = createOpenAIGenerationModel({ apiKey: "synthetic", fetch });
    await expect(
      generateText({
        model,
        messages: [{ role: "assistant", content: "Synthetic history" }],
        maxRetries: 0,
      }),
    ).rejects.toThrow();
    await expect(
      generateText({
        model,
        prompt: "Synthetic",
        tools: { synthetic: { inputSchema: schema } },
        maxRetries: 0,
      }),
    ).rejects.toThrow();
    await expect(
      generateText({
        model,
        messages: [
          {
            role: "user",
            content: [{ type: "file", data: new Uint8Array([0]), mediaType: "image/png" }],
          },
        ],
        maxRetries: 0,
      }),
    ).rejects.toThrow();
    const onError = vi.fn();
    const stream = streamText({ model, prompt: "Synthetic", maxRetries: 0, onError });
    await expect(stream.text).rejects.toThrow();
    expect(onError).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honors caller cancellation while a mocked transport ignores the signal", async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      controller.abort();
      return new Promise<Response>(() => {});
    });
    expect(
      await run(createOpenAIGenerationModel({ apiKey: "synthetic", fetch }), 0, controller.signal),
    ).toMatchObject({
      status: "failed",
      error: "cancelled",
      calls: 1,
      usage: { inputTokens: null, outputTokens: null },
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
});
