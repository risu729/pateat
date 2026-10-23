import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { evaluationCorpus } from "./corpus/cases";
import { japanesePageCorpus } from "./corpus/real";
import { evaluateRole } from "./evaluate";
import { toJsonSchema } from "@valibot/to-json-schema";
import {
  accountListGenerationInstructions,
  accountListInstruction,
  asPagePlan,
  createRecipeGenerator,
  generatedPlanSchema,
  generationInstructions,
} from "./generation";
import {
  generationRequest,
  oracleGenerator,
  textModel,
  textResult,
  usage,
} from "./testing/fake-models";

const page = evaluationCorpus[0]!;
// The description the response format gives a field of the plan answer.
type Described = {
  description?: string;
  properties?: Record<string, Described>;
  oneOf?: Described[];
};
const planDescription = (field: string) =>
  (toJsonSchema(generatedPlanSchema) as Described).properties?.["result"]?.oneOf?.[1]?.properties?.[
    field
  ]?.description;
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
      pageKind: "sign-in",
      irreversible: "no",
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
      run: async (entry) =>
        asPagePlan(await generate({ observation: entry.observation, slots: entry.slots })),
    });
    expect(report.semanticAccuracy).toBe(1);
    expect(report.falseSubmits).toBe(0);
    expect(report.calls).toBe(evaluationCorpus.length);
    expect(report.usage.inputTokens).toBe(120 * evaluationCorpus.length);
    // Every corpus page is a sign-in page (ADR 0035).
    expect(report.pageKinds).toEqual({
      "sign-in": evaluationCorpus.filter((entry) => entry.expected.kind === "plan").length,
      confirm: 0,
      unclear: 0,
    });
    expect(report.cases.find((entry) => entry.plan)?.plan).toMatchObject({ pageKind: "sign-in" });
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
    if (outcome.status !== "ok" || "accountList" in outcome.value)
      throw new Error("expected a plan");
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

  it("answers the page's kind and whether its submission cannot be undone (ADR 0035)", async () => {
    const answer = (pageKind: string, irreversible: string) =>
      JSON.stringify({
        result: {
          ...JSON.parse(plan([["password", "password"]])).result,
          pageKind,
          irreversible,
        },
      });
    const { model, generate } = generatorReturning(answer("confirm", "yes"));
    const outcome = await generate({ ...request, signedIn: true });
    if (outcome.status !== "ok" || "accountList" in outcome.value)
      throw new Error("expected a plan");
    expect(outcome.value).toMatchObject({ pageKind: "confirm", irreversible: "yes" });
    // The request log keeps both with the model's own answer.
    expect(outcome.answer).toMatchObject({ pageKind: "confirm", irreversible: "yes" });
    // The device's hint reaches the model beside the page.
    expect(generationRequest(model.doGenerateCalls[0]!)).toMatchObject({ signedIn: true });
    for (const [pageKind, irreversible] of [
      ["personal-details", "no"],
      ["sign-in", "maybe"],
    ]) {
      const { generate: refused } = generatorReturning(answer(pageKind!, irreversible!));
      // oxlint-disable-next-line no-await-in-loop -- Each answer is checked on its own.
      expect(await refused(request)).toMatchObject({ status: "failed", error: "invalid-output" });
    }
    // The same valid plan without its page kind is refused.
    const { pageKind: _pageKind, ...valid } = JSON.parse(answer("sign-in", "no")).result;
    const { generate: kinded } = generatorReturning(answer("sign-in", "no"));
    expect(await kinded(request)).toMatchObject({ status: "ok" });
    const { generate: kindless } = generatorReturning(JSON.stringify({ result: valid }));
    expect(await kindless(request)).toMatchObject({ status: "failed", error: "invalid-output" });
    expect(planDescription("pageKind")).toMatch(
      /^sign-in: a login .* confirm: a user already signed in/u,
    );
    expect(planDescription("irreversible")).toMatch(/cannot be undone/u);
    expect(generationInstructions).toContain("a sign-in form shown again after a session");
  });

  it("returns the account switch a plan names as its locator", async () => {
    // The corpus page has no switch; a link stands in for one.
    const { generate } = generatorReturning(
      plan([["password", "password"]], "sign-in", "submit", "register"),
    );
    const outcome = await generate(request);
    if (outcome.status !== "ok" || "accountList" in outcome.value)
      throw new Error("expected a plan");
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
    // A request without the signedIn hint, as a continuation, sends none (ADR 0035).
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
              pageKind: "sign-in",
              irreversible: "no",
              fields: [
                { slot: "custom-1", candidate: "branch" },
                { slot: "custom-2", candidate: "account" },
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
        { slot: "custom-3", candidate: "contract" },
        { slot: "password", candidate: "pin" },
      ],
      action: { candidate: "login", purpose: "submit" },
    };
    const outcome = await answer(byContract);
    if (outcome.status !== "ok" || "accountList" in outcome.value)
      throw new Error("expected a plan");
    expect(outcome.value.alternatives?.map((entry) => entry.steps)).toEqual([
      [
        {
          kind: "fill",
          path: "/login",
          effect: "prepare",
          fields: [
            // The page's label for the field, never the vault field's name (ADR 0027).
            { slot: "または契約者番号", target: { by: "id", value: "contract" } },
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
        fields: [{ slot: "custom-3", candidate: "first-time" }],
      }),
    ).toMatchObject({ status: "failed", error: "invalid-output", detail: "incompatible-role" });
  });

  it("bounds the alternatives in the response format the provider receives", async () => {
    const { model, generate } = generatorReturning(plan([["email", "email"]]));
    await generate(request);
    const format = model.doGenerateCalls[0]!.responseFormat as { schema?: unknown };
    const find = (value: unknown): unknown => {
      if (!value || typeof value !== "object") return undefined;
      const record = value as Record<string, unknown>;
      const properties = record["properties"] as Record<string, unknown> | undefined;
      if (properties?.["alternatives"]) return properties["alternatives"];
      for (const entry of Object.values(record)) {
        const found = find(entry);
        if (found) return found;
      }
      return undefined;
    };
    expect(find(format.schema)).toMatchObject({
      type: "array",
      maxItems: 3,
      items: {
        properties: {
          fields: { type: "array", maxItems: 8 },
          action: { properties: { purpose: { enum: ["advance", "submit"] } } },
        },
      },
    });
    // A fourth alternative fails the response format itself, before any plan check names a
    // reason.
    const four = generatorReturning(
      JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [
            { slot: "email", candidate: "email" },
            { slot: "password", candidate: "password" },
          ],
          action: { candidate: "sign-in", purpose: "submit" },
          alternatives: Array.from({ length: 4 }, () => ({
            fields: [{ slot: "email", candidate: "email" }],
            action: { candidate: "sign-in", purpose: "submit" },
          })),
        },
      }),
    );
    const outcome = await four.generate(request);
    expect(outcome).toMatchObject({ status: "failed", error: "invalid-output" });
    expect(outcome).not.toHaveProperty("detail");
  });

  it("returns the start page's passkey button as its locator, or drops it (ADR 0027)", async () => {
    const myjcb = japanesePageCorpus.find((entry) => entry.id === "ja-myjcb")!;
    const answer = (passkeyButton: string) =>
      JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [
            { slot: "username", candidate: "c1" },
            { slot: "password", candidate: "c2" },
          ],
          action: { candidate: "c3", purpose: "submit" },
          passkeyButton,
        },
      });
    const sign = { observation: myjcb.observation, slots: myjcb.slots };
    const named = await generatorReturning(answer("c5")).generate(sign);
    if (named.status !== "ok" || "accountList" in named.value) throw new Error("expected a plan");
    expect(named.value).toMatchObject({
      passkeyButton: "c5",
      passkeyTarget: { by: "id", value: "passkeyLoginButtonAD" },
    });
    // A link about passkeys is not a sign-in button; the plan stays and the button goes.
    const link = await generatorReturning(answer("c6")).generate(sign);
    if (link.status !== "ok" || "accountList" in link.value) throw new Error("expected a plan");
    expect(link.value).not.toHaveProperty("passkeyButton");
    expect(link.value.steps).toEqual(named.value.steps);
  });

  it("asks for the passkey sign-in button and never a registration button", () => {
    expect(generationInstructions).toContain(
      "Never name a button that registers, creates, adds or sets up a passkey or security key, or one the plan uses, as passkeyButton",
    );
    expect(planDescription("passkeyButton")).toMatch(/signs in with a passkey instead of/u);
  });

  it("asks for alternatives only for identifier sets the page shows now", () => {
    const alternatives = planDescription("alternatives");
    expect(alternatives).toContain("the page shows now");
    expect(alternatives).toContain("never another form or one behind a tab or link");
    expect(alternatives).toContain("every set's action, the main one too, is a submit");
    expect(alternatives).toContain("Each element fills one slot");
    expect(alternatives).toContain("no set's slots equal or are a subset of another's");
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

// Owner, 2026-10-18: the request log keeps the model's own answer beside the result.
describe("the answer kept for the request log (ADR 0012)", () => {
  it("keeps a passkey button the local checks drop", async () => {
    const myjcb = japanesePageCorpus.find((entry) => entry.id === "ja-myjcb")!;
    const answer = {
      decision: "plan",
      pageKind: "sign-in",
      irreversible: "no",
      fields: [
        { slot: "username", candidate: "c1" },
        { slot: "password", candidate: "c2" },
      ],
      action: { candidate: "c3", purpose: "submit" },
      // A link about passkeys, which the plan check drops.
      passkeyButton: "c6",
    };
    const outcome = await generatorReturning(JSON.stringify({ result: answer })).generate({
      observation: myjcb.observation,
      slots: myjcb.slots,
    });
    if (outcome.status !== "ok" || "accountList" in outcome.value)
      throw new Error("expected a plan");
    expect(outcome.value).not.toHaveProperty("passkeyButton");
    expect(outcome.answer).toEqual(answer);
  });

  it("keeps the alternatives and passkey button a later page's result drops", async () => {
    const twoSets = evaluationCorpus.find((entry) => entry.id === "ja-bank-two-identifier-sets")!;
    const sets = {
      decision: "plan",
      pageKind: "sign-in",
      irreversible: "no",
      fields: [
        { slot: "custom-1", candidate: "branch" },
        { slot: "custom-2", candidate: "account" },
        { slot: "password", candidate: "pin" },
      ],
      action: { candidate: "login", purpose: "submit" },
      alternatives: [
        {
          fields: [
            { slot: "custom-3", candidate: "contract" },
            { slot: "password", candidate: "pin" },
          ],
          action: { candidate: "login", purpose: "submit" },
        },
      ],
    };
    const later = await generatorReturning(JSON.stringify({ result: sets })).generate({
      observation: twoSets.observation,
      slots: twoSets.slots,
      startPage: false,
    });
    if (later.status !== "ok" || "accountList" in later.value) throw new Error("expected a plan");
    expect(later.value).not.toHaveProperty("alternatives");
    expect(later.answer).toEqual(sets);
    // A sign-in button the start page keeps (see above).
    const myjcb = japanesePageCorpus.find((entry) => entry.id === "ja-myjcb")!;
    const passkey = {
      decision: "plan",
      pageKind: "sign-in",
      irreversible: "no",
      fields: [
        { slot: "username", candidate: "c1" },
        { slot: "password", candidate: "c2" },
      ],
      action: { candidate: "c3", purpose: "submit" },
      passkeyButton: "c5",
    };
    const next = await generatorReturning(JSON.stringify({ result: passkey })).generate({
      observation: myjcb.observation,
      slots: myjcb.slots,
      startPage: false,
    });
    if (next.status !== "ok" || "accountList" in next.value) throw new Error("expected a plan");
    expect(next.value).not.toHaveProperty("passkeyButton");
    expect(next.value).not.toHaveProperty("passkeyTarget");
    expect(next.answer).toEqual(passkey);
  });

  it("reduces IDs the request does not hold to ?", async () => {
    const outcome = await generatorReturning(
      JSON.stringify({
        result: {
          decision: "plan",
          pageKind: "sign-in",
          irreversible: "no",
          fields: [
            { slot: "email", candidate: "email" },
            { slot: "Customer password", candidate: "password" },
          ],
          action: { candidate: "Sign in now", purpose: "submit" },
          accountSwitch: "Use another account",
          alternatives: [
            {
              fields: [{ slot: "email", candidate: "Email box" }],
              action: { candidate: "sign-in", purpose: "submit" },
            },
          ],
          passkeyButton: "Passkey",
        },
      }),
    ).generate(request);
    expect(outcome).toMatchObject({ status: "failed", error: "invalid-output" });
    expect(outcome.answer).toEqual({
      decision: "plan",
      pageKind: "sign-in",
      irreversible: "no",
      fields: [
        { slot: "email", candidate: "email" },
        { slot: "?", candidate: "password" },
      ],
      action: { candidate: "?", purpose: "submit" },
      accountSwitch: "?",
      alternatives: [
        {
          fields: [{ slot: "email", candidate: "?" }],
          action: { candidate: "sign-in", purpose: "submit" },
        },
      ],
      passkeyButton: "?",
    });
    expect(JSON.stringify(outcome.answer)).not.toMatch(
      /Member|Customer|Sign in|another|box|Passkey/u,
    );
  });

  it("keeps an abstention and an account list, and no answer the format refused", async () => {
    const abstained = await generatorReturning(
      JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } }),
    ).generate(request);
    expect(abstained.answer).toEqual({ decision: "abstain", reason: "ambiguous" });
    const list = await generatorReturning(
      JSON.stringify({ result: { decision: "account-list", other: "Another account" } }),
    ).generate(request);
    expect(list).toMatchObject({ status: "failed", detail: "unexpected-account-list" });
    expect(list.answer).toEqual({ decision: "account-list", other: "?" });
    const text = await generatorReturning("Sign in with the email field.").generate(request);
    expect(text).toMatchObject({ status: "failed", error: "invalid-output" });
    expect(text).not.toHaveProperty("answer");
  });
});

describe("account lists (ADR 0028)", () => {
  const list = {
    version: 1,
    origin: "https://dash.example.test",
    path: "/login",
    language: "en",
    complete: true,
    candidates: [
      { id: "c1", role: "button", target: { by: "text", value: "Sign in with another profile" } },
      { id: "c2", role: "button", target: { by: "text", value: "Log back in" } },
      { id: "c3", role: "link", target: { by: "text", value: "Help" } },
    ],
    accounts: ["[email] Last used", "[masked]"],
  };
  const answer = (controls: Record<string, string>) =>
    JSON.stringify({ result: { decision: "account-list", ...controls } });
  // A list is sent without slots (owner 2026-10-23 11:48 UTC); a form with its own.
  const run = (observation: object, text: string) =>
    generatorReturning(text).generate({
      observation,
      slots: "accounts" in observation ? [] : page.slots,
    });

  it("sends the list line only for a list of accounts", async () => {
    const system = (model: ReturnType<typeof generatorReturning>["model"]) =>
      model.doGenerateCalls[0]!.prompt.filter((message) => message.role === "system").map(
        (message) => message.content,
      );
    const listed = generatorReturning(answer({}));
    await listed.generate({ observation: list, slots: [] });
    expect(system(listed.model)).toEqual([accountListGenerationInstructions]);
    const form = generatorReturning(plan([["email", "email"]]));
    await form.generate(request);
    expect(system(form.model)).toEqual([generationInstructions]);
  });

  it("refuses a list sent with slots before any call (owner 2026-10-23 11:48 UTC)", async () => {
    const listed = generatorReturning(answer({}));
    expect(await listed.generate({ observation: list, slots: page.slots })).toMatchObject({
      status: "failed",
      error: "invalid-request",
      calls: 0,
    });
    expect(listed.model.doGenerateCalls).toHaveLength(0);
    // The prompt holds the list with no slots.
    await listed.generate({ observation: list, slots: [] });
    const prompt = listed.model.doGenerateCalls[0]!.prompt.find(
      (message) => message.role === "user",
    );
    expect(JSON.stringify(prompt)).toContain(String.raw`\"slots\":[]`);
  });

  it("answers the list's other and continue controls by their locators", async () => {
    expect(await run(list, answer({ other: "c1", continue: "c2" }))).toMatchObject({
      status: "ok",
      value: {
        accountList: true,
        other: { candidate: "c1", target: { by: "text", value: "Sign in with another profile" } },
        continue: { candidate: "c2", target: { by: "text", value: "Log back in" } },
      },
    });
    const bare = await run(list, answer({}));
    expect(bare).toMatchObject({ status: "ok", value: { accountList: true } });
    if (bare.status === "ok") expect(bare.value).not.toHaveProperty("other");
  });

  it("refuses a list answer that cannot be clicked safely, keeping only references", async () => {
    const refused = async (observation: object, text: string, detail: string) =>
      expect(await run(observation, text)).toMatchObject({
        status: "failed",
        error: "invalid-output",
        detail,
      });
    await refused(list, answer({ other: "c9" }), "unknown-candidate");
    await refused(list, answer({ other: "c1", continue: "c1" }), "duplicate-candidate");
    const marked = {
      ...list,
      candidates: [
        ...list.candidates,
        { id: "c4", role: "button", target: { by: "text", value: "[email] Last used" } },
        { id: "c5", role: "button", target: { by: "id", value: "p" }, label: "Taro [masked]" },
        { id: "c6", role: "email", target: { by: "id", value: "email" } },
        { id: "c7", role: "button", target: { by: "id", value: "q" }, label: "[account]" },
      ],
    };
    await refused(marked, answer({ other: "c4" }), "account-text");
    await refused(marked, answer({ continue: "c5" }), "account-text");
    await refused(marked, answer({ continue: "c7" }), "account-text");
    await refused(marked, answer({ other: "c6" }), "incompatible-role");
    // A form gets no list answer, and a list gets no form plan.
    const form = await run(page.observation, answer({ other: "c1" }));
    expect(form).toMatchObject({ detail: "unexpected-account-list" });
    expect(await run(list, plan([["email", "c1"]]))).toMatchObject({
      status: "failed",
      detail: "unexpected-plan",
    });
    // The log keeps only candidate IDs the request holds.
    const unknown = await run(list, answer({ other: "Sign in", continue: "c2" }));
    expect(unknown).toMatchObject({
      output: { result: { decision: "account-list", other: "?", continue: "c2" } },
    });
  });

  it("refuses a list answer naming no control when no account is an entry", async () => {
    const beside = { ...list, accountEntries: 0 };
    expect(await run(beside, answer({}))).toMatchObject({
      status: "failed",
      error: "invalid-output",
      detail: "no-list-control",
    });
    expect(await run(beside, answer({ other: "c1" }))).toMatchObject({
      status: "ok",
      value: { accountList: true, other: { candidate: "c1" } },
    });
    expect(await run(beside, answer({ continue: "c2" }))).toMatchObject({
      status: "ok",
      value: { accountList: true, continue: { candidate: "c2" } },
    });
    const entered = await Promise.all(
      [1, 2].map((accountEntries) => run({ ...list, accountEntries }, answer({}))),
    );
    for (const outcome of entered)
      expect(outcome).toMatchObject({ status: "ok", value: { accountList: true } });
    // Without the count, a bare answer is still taken.
    expect(await run(list, answer({}))).toMatchObject({
      status: "ok",
      value: { accountList: true },
    });
  });

  it("scores a list answer on a form as refused output", async () => {
    const outcome = await run(page.observation, answer({}));
    expect(outcome).toMatchObject({ status: "failed", detail: "unexpected-account-list" });
    const listed = await run(list, answer({}));
    expect(asPagePlan(listed)).toMatchObject({
      status: "failed",
      error: "invalid-output",
      detail: "unexpected-account-list",
      calls: 1,
    });
  });

  it("tells the model about lists only for a list", () => {
    expect(accountListGenerationInstructions).toBe(
      `${generationInstructions} ${accountListInstruction}`,
    );
    expect(accountListInstruction).toContain("answer account-list");
    // The slot mapping of the generation role's instructions does not apply to a list.
    expect(accountListInstruction).toContain("has no slots");
    expect(accountListInstruction).toContain("Never choose an account.");
    expect(generationInstructions).not.toContain("account-list");
  });
});
