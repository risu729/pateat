import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { evaluationCorpus } from "./corpus/cases";
import { slots } from "./corpus/slots";
import { buildFieldQuestions, createFieldMappingDecider } from "./decision";
import { evaluateRole } from "./evaluate";
import type { LoginObservation } from "./observation";
import { decisionModel, distribution, oracleDecider } from "./testing/fake-models";

const page = evaluationCorpus[0]!;
const limits = { timeoutMs: 1_000, maxInputBytes: 16_384 };
const request = { observation: page.observation, slots: page.slots };
type Answers = Awaited<ReturnType<Parameters<typeof decisionModel>[0]>>["answers"];

/** Answers each question with the given choice (or none) and a complete distribution. */
const answering = (
  choices: Record<string, string>,
  confidence = 0.9,
  extra: Partial<Answers> = {},
) =>
  decisionModel(async (options) => {
    const answers: Answers = {};
    for (const [id, question] of Object.entries(options.questions)) {
      if (question.type !== "choice") throw new Error("unexpected");
      const choice = choices[id] ?? "none";
      answers[id] = {
        type: "choice",
        choice,
        probabilities: distribution(Object.keys(question.criteria), choice, confidence),
      };
    }
    return {
      answers: { ...answers, ...extra } as Answers,
      usage: { inputTokens: 200 },
      warnings: [],
    };
  });
const decider = (model: ReturnType<typeof decisionModel>, minProbability = 0.7) =>
  createFieldMappingDecider({ model, limits, minProbability });
const correct = { "slot:email": "c:email", "slot:password": "c:password", action: "c:sign-in" };

describe("finite-choice decision role", () => {
  it("scores the oracle fake as fully correct on the corpus", async () => {
    const decide = decider(oracleDecider());
    const report = await evaluateRole({
      cases: evaluationCorpus,
      run: (entry) => decide({ observation: entry.observation, slots: entry.slots }),
    });
    expect(report.semanticAccuracy).toBe(1);
    expect(report.falseSubmits).toBe(0);
    expect(report.usage).toMatchObject({
      inputTokens: 300 * evaluationCorpus.length,
      unknownOutputCases: evaluationCorpus.length,
    });
  });

  it("asks only role-compatible options and always offers none", () => {
    const questions = buildFieldQuestions(page.observation, page.slots);
    expect(Object.keys(questions)).toEqual(["slot:email", "slot:password", "action"]);
    expect(Object.keys(questions["slot:email"]!.criteria)).toEqual(["c:email", "none"]);
    expect(Object.keys(questions["slot:password"]!.criteria)).toEqual(["c:password", "none"]);
    expect(Object.keys(questions["action"]!.criteria)).toEqual([
      "c:sign-in",
      "c:forgot",
      "c:register",
      "none",
    ]);
  });

  it("returns a validated plan and derives the submit purpose locally", async () => {
    const model = answering(correct);
    const outcome = await decider(model)(request);
    expect(outcome).toMatchObject({
      status: "ok",
      calls: 1,
      usage: { inputTokens: 200, outputTokens: null },
      value: { action: { candidate: "sign-in", purpose: "submit" } },
    });
    expect(model.calls[0]!.state).toEqual([
      {
        type: "json",
        value: {
          page: {
            origin: page.observation.origin,
            path: "/login",
            language: "en",
            title: "Sign in",
          },
          slots: page.slots,
        },
      },
    ]);
  });

  it.each([
    ["an unknown option", { ...correct, action: "c:delete" }],
    ["a raw candidate ID without the option prefix", { ...correct, action: "sign-in" }],
  ])("rejects %s through the SDK contract", async (_name, choices) => {
    const model = decisionModel(async (options) => {
      const answers: Answers = {};
      for (const id of Object.keys(options.questions))
        answers[id] = { type: "choice", choice: choices[id as keyof typeof choices] ?? "none" };
      return { answers, warnings: [] };
    });
    expect(await decider(model)(request)).toMatchObject({
      status: "failed",
      error: "invalid-output",
    });
  });

  it.each([
    ["probabilities that do not sum to one", { "c:email": 0.9, none: 0.3 }],
    ["a probability outside [0, 1]", { "c:email": 1.2, none: -0.2 }],
    ["an incomplete distribution", { "c:email": 1 }],
    ["a choice that is not the most probable option", { "c:email": 0.2, none: 0.8 }],
  ])("rejects %s", async (_name, probabilities) => {
    const model = answering(correct, 0.9, {
      "slot:email": { type: "choice", choice: "c:email", probabilities },
    });
    expect(await decider(model)(request)).toMatchObject({
      status: "failed",
      error: "invalid-output",
    });
  });

  it("abstains on missing distributions, low confidence and absent actions", async () => {
    const missing = answering(correct, 0.9, {
      "slot:email": { type: "choice", choice: "c:email" },
    });
    expect(await decider(missing)(request)).toMatchObject({
      status: "abstained",
      reason: "missing-probabilities",
    });
    expect(await decider(answering(correct, 0.6))(request)).toMatchObject({
      status: "abstained",
      reason: "low-confidence",
    });
    expect(await decider(answering({ ...correct, action: "none" }))(request)).toMatchObject({
      status: "abstained",
      reason: "no-action",
    });
    expect(await decider(answering({ action: "c:sign-in" }))(request)).toMatchObject({
      status: "abstained",
      reason: "no-login-form",
    });
  });

  it("abstains when two slots choose the same element", async () => {
    const both = {
      observation: page.observation,
      slots: [slots.username, slots.email, slots.password],
    };
    const model = answering({
      "slot:username": "c:email",
      "slot:email": "c:email",
      "slot:password": "c:password",
      action: "c:sign-in",
    });
    const outcome = await decider(model)(both);
    expect(outcome).toMatchObject({ status: "abstained", reason: "inconsistent-mapping" });
    const report = await evaluateRole({
      cases: [{ ...page, slots: both.slots }],
      run: () => decider(model)(both),
    });
    expect(report.jointMappingRejections).toBe(1);
  });

  it("hides registration passwords and abstains on cross-form mappings", async () => {
    const signup = evaluationCorpus.find((entry) => entry.id === "ja-signup-adjacent")!;
    const questions = buildFieldQuestions(signup.observation, signup.slots);
    expect(Object.keys(questions["slot:password"]!.criteria)).toEqual(["c:login-pass", "none"]);
    const crossForm = answering({
      "slot:email": "c:reg-email",
      "slot:password": "c:login-pass",
      action: "c:login-submit",
    });
    expect(
      await decider(crossForm)({ observation: signup.observation, slots: signup.slots }),
    ).toMatchObject({ status: "abstained", reason: "inconsistent-mapping" });
  });

  it("maps refusal, rate limits and timeouts to explicit failures", async () => {
    const refusing = answering(correct, 0.9, { action: { type: "refusal" } });
    expect(await decider(refusing)(request)).toMatchObject({ status: "failed", error: "refused" });
    const limited = decisionModel(async () => {
      throw new APICallError({
        message: "rate limited",
        url: "https://fake.invalid",
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: true,
      });
    });
    expect(await decider(limited)(request)).toMatchObject({
      status: "failed",
      error: "rate-limited",
      calls: 1,
    });
    const silent = decisionModel(() => new Promise(() => {}));
    const slow = createFieldMappingDecider({
      model: silent,
      limits: { ...limits, timeoutMs: 100 },
      minProbability: 0.7,
    });
    expect(await slow(request)).toMatchObject({ status: "failed", error: "timeout", calls: 1 });
  });

  it("rejects incomplete, oversized and action-free pages before any call", async () => {
    const model = answering(correct);
    const decide = decider(model);
    expect(
      await decide({ ...request, observation: { ...page.observation, complete: false } }),
    ).toMatchObject({ status: "failed", error: "incomplete-observation" });
    const small = createFieldMappingDecider({
      model,
      limits: { ...limits, maxInputBytes: 512 },
      minProbability: 0.7,
    });
    expect(await small(request)).toMatchObject({ status: "failed", error: "input-too-large" });
    const formless: LoginObservation = {
      ...page.observation,
      candidates: page.observation.candidates.filter(
        (candidate) => candidate.role !== "button" && candidate.role !== "link",
      ),
    };
    expect(await decide({ ...request, observation: formless })).toMatchObject({
      status: "abstained",
      reason: "no-login-form",
      calls: 0,
    });
    expect(model.calls).toHaveLength(0);
    expect(() => createFieldMappingDecider({ model, limits, minProbability: 0.3 })).toThrow();
  });
});

describe("finite-choice usage and telemetry", () => {
  it("counts a retried attempt without usage as unknown", async () => {
    let attempt = 0;
    const model = decisionModel(async (options) => {
      attempt += 1;
      if (attempt === 1)
        throw new APICallError({
          message: "unavailable",
          url: "https://fake.invalid",
          requestBodyValues: {},
          statusCode: 503,
          responseHeaders: { "retry-after-ms": "1" },
          isRetryable: true,
        });
      return answering(correct).doDecide(options);
    });
    const decide = createFieldMappingDecider({
      model,
      limits: { ...limits, maxRetries: 1 },
      minProbability: 0.7,
    });
    expect(await decide(request)).toMatchObject({
      status: "ok",
      calls: 2,
      usage: { inputTokens: null, outputTokens: null },
    });
  });

  it("never reports state or answers to global telemetry integrations", async () => {
    const seen: unknown[] = [];
    const spy = new Proxy({}, { get: () => (event: unknown) => void seen.push(event) });
    const global = globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown };
    global.AI_SDK_TELEMETRY_INTEGRATIONS = [spy];
    try {
      expect(await decider(answering(correct))(request)).toMatchObject({ status: "ok" });
    } finally {
      delete global.AI_SDK_TELEMETRY_INTEGRATIONS;
    }
    expect(seen).toEqual([]);
  });
});
