import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { evaluationCorpus } from "./corpus/cases";
import { evaluateRole } from "./evaluate";
import { createRecipeGenerator, generationInstructions } from "./generation";
import {
  generationRequest,
  oracleGenerator,
  textModel,
  textResult,
  usage,
} from "./testing/fake-models";

const page = evaluationCorpus[0]!;
const limits = { timeoutMs: 1_000, maxInputBytes: 16_384 };
const plan = (
  fields: [string, string][],
  action = "sign-in",
  purpose = "submit",
  accountSwitch?: string,
) =>
  JSON.stringify({
    result: {
      decision: "plan",
      fields: fields.map(([slot, candidate]) => ({ slot, candidate })),
      action: { candidate: action, purpose },
      ...(accountSwitch === undefined ? {} : { accountSwitch }),
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

  it("returns the account switch a plan names as its locator", async () => {
    // The corpus page has no switch; a link stands in for one.
    const { generate } = generatorReturning(
      plan([["password", "password"]], "sign-in", "submit", "register"),
    );
    const outcome = await generate(request);
    if (outcome.status !== "ok") throw new Error("expected a plan");
    expect(outcome.value).toMatchObject({
      accountSwitch: "register",
      switchTarget: { by: "id", value: "register" },
    });
    const { generate: plain } = generatorReturning(plan([["password", "password"]]));
    const without = await plain(request);
    if (without.status !== "ok") throw new Error("expected a plan");
    expect(without.value).not.toHaveProperty("switchTarget");
  });

  it("sends only the bounded observation, slots and instructions", async () => {
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

  it("sends field names, value shapes and input constraints but never values", async () => {
    const bank = evaluationCorpus.find((item) => item.id === "ja-bank-unlabeled-lengths")!;
    const model = oracleGenerator();
    const generate = createRecipeGenerator({ model, limits, maxOutputTokens: 512 });
    expect(await generate({ observation: bank.observation, slots: bank.slots })).toMatchObject({
      status: "ok",
    });
    const call = model.doGenerateCalls[0]!;
    expect(generationRequest(call)).toMatchObject({
      slots: bank.slots,
      observation: bank.observation,
    });
    const sent = JSON.stringify(call.prompt);
    expect(sent).toContain("口座番号");
    expect(sent).toContain('\\"maxLength\\":7');
    for (const value of Object.values(bank.values!)) expect(sent).not.toContain(value);
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
    ["link as the page action", plan([["email", "email"]], "forgot"), "incompatible-role"],
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
    [
      "the action as the account switch",
      plan([["email", "email"]], "sign-in", "submit", "sign-in"),
      "duplicate-candidate",
    ],
    [
      "a field as the account switch",
      plan([["email", "email"]], "sign-in", "submit", "email"),
      "duplicate-candidate",
    ],
    [
      "an unknown account switch",
      plan([["email", "email"]], "sign-in", "submit", "elsewhere"),
      "unknown-candidate",
    ],
    [
      "an input as the account switch",
      plan([["email", "email"]], "sign-in", "submit", "password"),
      "incompatible-role",
    ],
  ])("rejects %s as invalid output", async (_name, text, detail) => {
    const { generate } = generatorReturning(text);
    expect(await generate(request)).toMatchObject({
      status: "failed",
      error: "invalid-output",
      detail,
    });
  });

  it("rejects plans that cross forms or fill a registration password", async () => {
    const signup = evaluationCorpus.find((entry) => entry.id === "ja-signup-adjacent")!;
    const signupRequest = { observation: signup.observation, slots: signup.slots };
    const check = async (fields: [string, string][], action: string, detail: string) => {
      const model = textModel(async () => textResult(plan(fields, action)));
      const generate = createRecipeGenerator({ model, limits, maxOutputTokens: 512 });
      expect(await generate(signupRequest)).toMatchObject({ status: "failed", detail });
    };
    await check(
      [
        ["email", "login-email"],
        ["password", "reg-pass"],
      ],
      "login-submit",
      "incompatible-role",
    );
    await check(
      [
        ["email", "reg-email"],
        ["password", "login-pass"],
      ],
      "login-submit",
      "mixed-groups",
    );
    await check(
      [
        ["email", "login-email"],
        ["password", "login-pass"],
      ],
      "reg-submit",
      "mixed-groups",
    );
  });

  it("returns the other identifier sets a page shows as validated alternatives", async () => {
    const twoSets = evaluationCorpus.find((entry) => entry.id === "ja-bank-two-identifier-sets")!;
    const twoRequest = { observation: twoSets.observation, slots: twoSets.slots };
    const answer = (alternative: Record<string, unknown>) => {
      const model = textModel(async () =>
        textResult(
          JSON.stringify({
            result: {
              decision: "plan",
              fields: [
                { slot: "custom-1", candidate: "branch", name: "branch-number" },
                { slot: "custom-2", candidate: "account", name: "account-number" },
                { slot: "password", candidate: "pin" },
              ],
              action: { candidate: "login", purpose: "submit" },
              alternatives: [alternative],
            },
          }),
        ),
      );
      return createRecipeGenerator({ model, limits, maxOutputTokens: 512 })(twoRequest);
    };
    const byContract = {
      fields: [
        { slot: "custom-3", candidate: "contract", name: "contract-number" },
        { slot: "password", candidate: "pin" },
      ],
      action: { candidate: "login", purpose: "submit" },
    };
    const outcome = await answer(byContract);
    if (outcome.status !== "ok") throw new Error("expected a plan");
    expect(outcome.value.alternatives?.map((entry) => entry.steps)).toEqual([
      [
        {
          kind: "fill",
          path: "/login",
          effect: "prepare",
          fields: [
            { slot: "contract-number", target: { by: "id", value: "contract" } },
            { slot: "password", target: { by: "id", value: "pin" } },
          ],
        },
        { kind: "click", path: "/login", target: { by: "id", value: "login" }, purpose: "submit" },
      ],
    ]);
    // An alternative that fails a check refuses the whole plan.
    expect(
      await answer({ ...byContract, action: { candidate: "login", purpose: "advance" } }),
    ).toMatchObject({ status: "failed", error: "invalid-output", detail: "variant-advance" });
    expect(
      await answer({
        ...byContract,
        fields: [{ slot: "custom-3", candidate: "first-time", name: "contract-number" }],
      }),
    ).toMatchObject({ status: "failed", error: "invalid-output", detail: "incompatible-role" });
  });

  it("asks for alternatives only for identifier sets the page shows now", () => {
    expect(generationInstructions).toContain("alternatives");
    expect(generationInstructions).toContain("never a sign-up, recovery, registration or");
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
    [
      "four alternatives",
      JSON.stringify({
        result: {
          decision: "plan",
          fields: [{ slot: "password", candidate: "password" }],
          action: { candidate: "sign-in", purpose: "submit" },
          alternatives: Array.from({ length: 4 }, () => ({
            fields: [{ slot: "email", candidate: "email" }],
            action: { candidate: "sign-in", purpose: "submit" },
          })),
        },
      }),
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
    const fallback = oracleGenerator();
    const global = globalThis as { AI_SDK_DEFAULT_PROVIDER?: unknown };
    global.AI_SDK_DEFAULT_PROVIDER = { languageModel: () => fallback };
    try {
      const generate = createRecipeGenerator({ model: failing, limits, maxOutputTokens: 512 });
      expect(await generate(request)).toMatchObject({
        status: "failed",
        error: "provider-error",
        calls: 1,
      });
    } finally {
      delete global.AI_SDK_DEFAULT_PROVIDER;
    }
    expect(fallback.doGenerateCalls).toHaveLength(0);
  });

  it("counts a retried attempt without usage as unknown", async () => {
    let attempt = 0;
    const model = textModel(async () => {
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
      return textResult(plan([["email", "email"]]));
    });
    const generate = createRecipeGenerator({
      model,
      limits: { ...limits, maxRetries: 1 },
      maxOutputTokens: 512,
    });
    expect(await generate(request)).toMatchObject({
      status: "ok",
      calls: 2,
      usage: { inputTokens: null, outputTokens: null },
    });
  });

  it("never reports prompts or outputs to global telemetry integrations", async () => {
    const seen: unknown[] = [];
    const spy = new Proxy({}, { get: () => (event: unknown) => void seen.push(event) });
    const global = globalThis as { AI_SDK_TELEMETRY_INTEGRATIONS?: unknown };
    global.AI_SDK_TELEMETRY_INTEGRATIONS = [spy];
    try {
      const { generate } = generatorReturning(plan([["email", "email"]]));
      expect(await generate(request)).toMatchObject({ status: "ok" });
    } finally {
      delete global.AI_SDK_TELEMETRY_INTEGRATIONS;
    }
    expect(seen).toEqual([]);
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
  });
});
