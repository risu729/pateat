import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { evaluationCorpus } from "./corpus/cases";
import { slots } from "./corpus/slots";
import { evaluateRole } from "./evaluate";
import { createRecipeGenerator } from "./generation";
import {
  generationRequest,
  oracleGenerator,
  textModel,
  textResult,
  usage,
} from "./testing/fake-models";

const page = evaluationCorpus[0]!;
const limits = { timeoutMs: 1_000, maxInputBytes: 16_384 };
const plan = (fields: [string, string][], action = "sign-in", purpose = "submit") =>
  JSON.stringify({
    result: {
      decision: "plan",
      fields: fields.map(([slot, candidate]) => ({ slot, candidate })),
      action: { candidate: action, purpose },
    },
  });
const request = { observation: page.observation, slots: page.slots };

function generatorReturning(text: string, options?: Parameters<typeof textResult>[1]) {
  const model = textModel(async () => textResult(text, options));
  return { model, generate: createRecipeGenerator({ model, limits, maxOutputTokens: 512 }) };
}

describe("recipe generation role", () => {
  it("scores the oracle fake as fully correct on the corpus", async () => {
    const model = oracleGenerator();
    const generate = createRecipeGenerator({ model, limits, maxOutputTokens: 512 });
    const report = await evaluateRole({
      cases: evaluationCorpus,
      run: (entry) => generate({ observation: entry.observation, slots: entry.slots }),
    });
    expect(report.semanticAccuracy).toBe(1);
    expect(report.falseSubmits).toBe(0);
    expect(report.calls).toBe(evaluationCorpus.length);
    expect(report.usage.inputTokens).toBe(120 * evaluationCorpus.length);
  });

  it("returns locally validated recipe steps and records usage", async () => {
    const { generate } = generatorReturning(
      plan([
        ["email", "email"],
        ["password", "password"],
      ]),
    );
    const outcome = await generate(request);
    expect(outcome).toMatchObject({
      status: "ok",
      calls: 1,
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    if (outcome.status !== "ok") throw new Error("expected a plan");
    expect(outcome.value.steps).toEqual([
      {
        kind: "fill",
        path: "/login",
        effect: "prepare",
        fields: [
          { slot: "email", target: { by: "id", value: "email" } },
          { slot: "password", target: { by: "id", value: "password" } },
        ],
      },
      { kind: "click", path: "/login", target: { by: "id", value: "sign-in" }, purpose: "submit" },
    ]);
  });

  it("sends only the bounded observation, slot meanings and instructions", async () => {
    const { model, generate } = generatorReturning(plan([["email", "email"]]));
    await generate(request);
    const call = model.doGenerateCalls[0]!;
    expect(generationRequest(call)).toEqual({
      task: "generate",
      slots: page.slots,
      observation: page.observation,
    });
    expect(call.responseFormat).toMatchObject({ type: "json", name: "login_page_plan" });
    expect(call.maxOutputTokens).toBe(512);
  });

  it("passes explicit abstention through", async () => {
    const { generate } = generatorReturning(
      JSON.stringify({ result: { decision: "abstain", reason: "unsafe-instructions" } }),
    );
    expect(await generate(request)).toMatchObject({
      status: "abstained",
      reason: "unsafe-instructions",
    });
  });

  it.each([
    ["nonexistent candidate", plan([["email", "missing"]]), "unknown-candidate"],
    ["unrequested slot", plan([["otp", "email"]]), "unknown-slot"],
    ["secret into a visible text field", plan([["password", "email"]]), "incompatible-role"],
    ["identifier into a password field", plan([["email", "password"]]), "incompatible-role"],
    ["link as a fill target", plan([["email", "forgot"]]), "incompatible-role"],
    ["field reused as the action", plan([["email", "email"]], "email"), "duplicate-candidate"],
    [
      "one element for two slots",
      plan([
        ["password", "password"],
        ["email", "password"],
      ]),
      "duplicate-candidate",
    ],
    ["no fields", plan([]), "empty-plan"],
  ])("rejects %s as invalid output", async (_name, text, detail) => {
    const { generate } = generatorReturning(text);
    expect(await generate(request)).toMatchObject({
      status: "failed",
      error: "invalid-output",
      detail,
    });
  });

  it.each([
    ["malformed JSON", '{"result":', undefined, "invalid-output"],
    [
      "schema violation",
      JSON.stringify({ result: { decision: "click-all" } }),
      undefined,
      "invalid-output",
    ],
    [
      "extra properties",
      JSON.stringify({ result: { decision: "abstain", reason: "ambiguous", note: "x" } }),
      undefined,
      "invalid-output",
    ],
    ["truncation", '{"result":{"decision":"pl', "length", "truncated"],
    ["provider content filter", "", "content-filter", "refused"],
  ] as const)("maps %s to %s and keeps reported usage", async (_name, text, finish, error) => {
    const { generate } = generatorReturning(text, finish ? { finish } : {});
    expect(await generate(request)).toMatchObject({
      status: "failed",
      error,
      calls: 1,
      usage: { inputTokens: 120, outputTokens: 30 },
    });
  });

  it("treats missing usage as unknown, not free", async () => {
    const { generate } = generatorReturning(plan([["email", "email"]]), { usage: usage() });
    expect(await generate(request)).toMatchObject({
      status: "ok",
      usage: { inputTokens: null, outputTokens: null },
    });
  });

  it("does not retry by default and bounds explicit retries", async () => {
    const rateLimited = () =>
      new APICallError({
        message: "rate limited",
        url: "https://fake.invalid",
        requestBodyValues: {},
        statusCode: 429,
        responseHeaders: { "retry-after-ms": "1" },
        isRetryable: true,
      });
    const model = textModel(async () => {
      throw rateLimited();
    });
    const once = createRecipeGenerator({ model, limits, maxOutputTokens: 512 });
    expect(await once(request)).toMatchObject({
      status: "failed",
      error: "rate-limited",
      calls: 1,
    });
    const twice = createRecipeGenerator({
      model,
      limits: { ...limits, maxRetries: 1 },
      maxOutputTokens: 512,
    });
    expect(await twice(request)).toMatchObject({
      status: "failed",
      error: "rate-limited",
      calls: 2,
    });
    expect(() =>
      createRecipeGenerator({ model, limits: { ...limits, maxRetries: 3 }, maxOutputTokens: 512 }),
    ).toThrow();
  });

  it("reports provider errors without falling back to another model", async () => {
    const failing = textModel(async () => {
      throw new APICallError({
        message: "unavailable",
        url: "https://fake.invalid",
        requestBodyValues: {},
        statusCode: 503,
        isRetryable: false,
      });
    });
    const other = oracleGenerator();
    const generate = createRecipeGenerator({ model: failing, limits, maxOutputTokens: 512 });
    expect(await generate(request)).toMatchObject({
      status: "failed",
      error: "provider-error",
      calls: 1,
    });
    expect(other.doGenerateCalls).toHaveLength(0);
  });

  it("times out a transport that never answers and distinguishes cancellation", async () => {
    const model = textModel(() => new Promise(() => {}));
    const generate = createRecipeGenerator({
      model,
      limits: { ...limits, timeoutMs: 100 },
      maxOutputTokens: 512,
    });
    expect(await generate(request)).toMatchObject({ status: "failed", error: "timeout", calls: 1 });
    const controller = new AbortController();
    const pending = generate({ ...request, abortSignal: controller.signal });
    controller.abort();
    expect(await pending).toMatchObject({ status: "failed", error: "cancelled" });
  });

  it("rejects incomplete, invalid and oversized requests before any model call", async () => {
    const { model, generate } = generatorReturning(plan([["email", "email"]]));
    expect(
      await generate({ ...request, observation: { ...page.observation, complete: false } }),
    ).toMatchObject({ status: "failed", error: "incomplete-observation", calls: 0 });
    expect(await generate({ ...request, slots: [] })).toMatchObject({ error: "invalid-request" });
    expect(await generate({ ...request, repair: { reason: "unknown" } })).toMatchObject({
      error: "invalid-request",
    });
    const small = createRecipeGenerator({
      model,
      limits: { ...limits, maxInputBytes: 1_024 },
      maxOutputTokens: 512,
    });
    expect(await small(request)).toMatchObject({
      status: "failed",
      error: "input-too-large",
      calls: 0,
    });
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("includes locator-only previous steps for a repair request", async () => {
    const { model, generate } = generatorReturning(plan([["email", "email"]]));
    const repair = {
      reason: "structural-mismatch",
      previousSteps: [
        {
          kind: "fill",
          path: "/login",
          fields: [{ slot: "email", target: { by: "name", value: "mail" } }],
        },
      ],
    };
    expect(await generate({ ...request, repair })).toMatchObject({ status: "ok" });
    expect(generationRequest(model.doGenerateCalls[0]!)).toMatchObject({ task: "repair", repair });
  });

  it("refuses model identifiers that would resolve through a global default provider", () => {
    expect(() =>
      createRecipeGenerator({
        model: "some-provider/some-model" as never,
        limits,
        maxOutputTokens: 512,
      }),
    ).toThrow(TypeError);
    expect(slots.password.kind).toBe("secret");
  });
});
