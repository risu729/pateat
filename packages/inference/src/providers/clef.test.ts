import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { evaluationCorpus } from "../corpus/cases";
import { createFieldMappingDecider } from "../decision";
import { fakeClef, type Sent } from "../testing/fake-clef";
import { createClefDecisionModel, estimateClefCostUsd } from "./clef";

const accountId = "0123456789abcdef0123456789abcdef";
const apiToken = "synthetic-cloudflare-token";
const limits = { timeoutMs: 1_000, maxInputBytes: 16_384 };

const page = evaluationCorpus.find((entry) => entry.id === "en-basic")!;
const decider = (fetch: typeof globalThis.fetch, minProbability = 0.7) =>
  createFieldMappingDecider({
    model: createClefDecisionModel({ accountId, apiToken, modelId: "clef-flash", fetch }),
    limits,
    minProbability,
  });

describe("Clef adapter", () => {
  it("asks the pinned endpoint with Clef-safe question IDs and maps the answers back", async () => {
    const clef = fakeClef();
    const outcome = await decider(clef.fetch)({
      observation: page.observation,
      slots: page.slots,
    });
    if (page.expected.kind !== "plan") throw new Error("en-basic expects a plan");
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.value.action.candidate).toBe(page.expected.action);
    expect(
      Object.fromEntries(outcome.value.fields.map((field) => [field.slot, field.candidate])),
    ).toEqual(page.expected.fields);
    expect(outcome.usage).toEqual({ inputTokens: 1_000, outputTokens: 0 });

    const [request] = clef.sent;
    expect(request!.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/cloudflare/clef-flash`,
    );
    expect(request!.headers.get("authorization")).toBe(`Bearer ${apiToken}`);
    expect(request!.body["model"]).toBe("clef-flash");
    expect(request!.body["state"].page.origin).toBe(page.observation.origin);
    const ids = Object.keys(request!.body["questions"]);
    expect(ids).toContain("action");
    expect(ids.every((id) => /^[A-Za-z0-9_.-]{1,100}$/.test(id))).toBe(true);
    expect(ids.some((id) => id.startsWith("slot."))).toBe(true);
    // Option IDs are free strings for Clef and stay as the role names them.
    expect(Object.keys(request!.body["questions"]["action"].criteria)).toContain("none");
  });

  it("abstains on low probabilities", async () => {
    const outcome = await decider(fakeClef({ confidence: 0.6 }).fetch)({
      observation: page.observation,
      slots: page.slots,
    });
    expect(outcome).toMatchObject({ status: "abstained", reason: "low-confidence" });
  });

  it("maps yes/no and score questions and their answers", async () => {
    const sent: Sent[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json({
        success: true,
        result: {
          model: "clef",
          answers: {
            "is.login": { type: "noul", noul: 0.9554 },
            rating: {
              type: "score",
              score: 0.8,
              legend: { "0": "low", "1": "high" },
              probabilities: { "0": 0.2, "1": 0.8 },
              confidence: 0.4,
            },
          },
          usage: { input_tokens: 20, output_tokens: 0 },
        },
      });
    }) as typeof globalThis.fetch;
    const model = createClefDecisionModel({ accountId, apiToken, modelId: "clef", fetch });
    const result = await model.doDecide({
      state: [{ type: "text", text: "A sign-in page." }],
      questions: {
        "is:login": { type: "boolean", instructions: "Is this a sign-in page?" },
        rating: { type: "score", instructions: "How clear is it?", criteria: ["low", "high"] },
      },
    });
    expect(sent[0]!.body["state"]).toBe("A sign-in page.");
    expect(sent[0]!.body["questions"]["is.login"]).toEqual({
      type: "noul",
      instructions: "Is this a sign-in page?",
    });
    expect(result.answers).toEqual({
      "is:login": { type: "boolean", probability: 0.9554 },
      rating: { type: "score", score: 0.8, probabilities: { "0": 0.2, "1": 0.8 } },
    });
    expect(result.rounding).toEqual({ probabilityDecimals: 4, scoreDecimals: 4 });
    expect(result.response?.modelId).toBe("clef");
  });

  it("reports an error by status and codes only", async () => {
    const { fetch } = fakeClef({
      status: 422,
      body: {
        success: false,
        errors: [{ code: 3030, message: "Request body failed validation: page text" }],
      },
    });
    const model = createClefDecisionModel({ accountId, apiToken, modelId: "clef", fetch });
    const error = await model
      .doDecide({
        state: [{ type: "text", text: "page text" }],
        questions: { a: { type: "boolean", instructions: "?" } },
      })
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );
    expect(APICallError.isInstance(error)).toBe(true);
    expect((error as APICallError).statusCode).toBe(422);
    expect((error as Error).message).toBe("Workers AI answered 422 (codes 3030).");
  });

  it("classifies rate limits, provider errors and malformed answers", async () => {
    const request = { observation: page.observation, slots: page.slots };
    await expect(
      decider(fakeClef({ status: 429, body: { success: false, errors: [] } }).fetch)(request),
    ).resolves.toMatchObject({ status: "failed", error: "rate-limited", calls: 1 });
    await expect(
      decider(fakeClef({ status: 500, body: { success: false } }).fetch)(request),
    ).resolves.toMatchObject({ status: "failed", error: "provider-error" });
    await expect(
      decider(fakeClef({ body: { success: true, result: { answers: [] } } }).fetch)(request),
    ).resolves.toMatchObject({ status: "failed", error: "invalid-output" });
    await expect(
      decider(
        fakeClef({
          body: {
            success: true,
            result: { model: "clef-flash", answers: { unasked: { type: "noul", noul: 1 } } },
          },
        }).fetch,
      )(request),
    ).resolves.toMatchObject({ status: "failed", error: "invalid-output" });
  });

  it("counts usage Workers AI did not report as unknown", async () => {
    const outcome = await decider(fakeClef({ usage: {} }).fetch)({
      observation: page.observation,
      slots: page.slots,
    });
    expect(outcome.usage).toEqual({ inputTokens: null, outputTokens: null });
  });

  it("refuses a malformed account, an empty token and an unknown model", () => {
    const fetch = fakeClef().fetch;
    expect(() =>
      createClefDecisionModel({ accountId: "../x", apiToken, modelId: "clef", fetch }),
    ).toThrow();
    expect(() =>
      createClefDecisionModel({ accountId, apiToken: " ", modelId: "clef", fetch }),
    ).toThrow();
    expect(() =>
      createClefDecisionModel({ accountId, apiToken, modelId: "jev" as "clef", fetch }),
    ).toThrow();
  });

  it("prices input tokens at the published rate", () => {
    expect(estimateClefCostUsd(1_000_000, "clef-flash")).toBeCloseTo(0.038);
    expect(estimateClefCostUsd(1_000_000, "clef")).toBeCloseTo(0.24);
    expect(estimateClefCostUsd(null, "clef-omni")).toBeUndefined();
  });
});
