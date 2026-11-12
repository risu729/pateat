import type { LoginObservation } from "@pateat/contracts";
import { toJsonSchema } from "@valibot/to-json-schema";
import { APICallError } from "ai";
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import {
  completionBesideInstructions,
  completionInstructions,
  completionStopInstructions,
  createCompletionJudge,
  judgedPageSchema,
} from "./completion";
import { evaluationCorpus } from "./corpus/cases";
import {
  createEntryGenerator,
  createRecipeGenerator,
  entryGenerationInstructions,
  generatedPlanSchema,
  generationInstructions,
} from "./generation";
import { createLogoutGenerator, logoutAnswerSchema, logoutInstructions } from "./logout";
import type { InferenceOutcome } from "./outcome";
import { textModel, textResult } from "./testing/fake-models";

type Config = Parameters<typeof createRecipeGenerator>[0];
type Options = { stop?: boolean; beside?: boolean };
type Role = {
  name: string;
  create: (
    config: Config,
  ) => (observation: unknown, options?: Options) => Promise<InferenceOutcome<unknown>>;
  instructions: string;
  schemaJson: string;
  prompt: (observation: LoginObservation) => unknown;
  answer: string;
};
const slots = evaluationCorpus[0]!.slots;
const abstain = JSON.stringify({ result: { decision: "abstain", reason: "ambiguous" } });
const page: LoginObservation = {
  version: 1,
  origin: "https://example.test",
  path: "/login",
  language: "ja",
  title: "\u65e5\u672c\u8a9e\ud83d\udd10",
  complete: true,
  candidates: [{ id: "sign-in", role: "button", target: { by: "id", value: "sign-in" } }],
};
const roles: Role[] = [
  {
    name: "recipe",
    create: (config) => {
      const run = createRecipeGenerator(config);
      return (observation) => run({ observation, slots });
    },
    instructions: generationInstructions,
    schemaJson: JSON.stringify(toJsonSchema(generatedPlanSchema)),
    prompt: (observation) => ({ task: "generate", slots, observation }),
    answer: abstain,
  },
  {
    name: "entry",
    create: (config) => {
      const run = createEntryGenerator(config);
      return (observation) => run({ observation });
    },
    instructions: entryGenerationInstructions,
    schemaJson: JSON.stringify(toJsonSchema(generatedPlanSchema)),
    prompt: (observation) => ({ task: "entry", observation }),
    answer: abstain,
  },
  {
    name: "completion",
    create: (config) => {
      const run = createCompletionJudge(config);
      return (observation, options) => run({ observation, loginPaths: ["/login"], ...options });
    },
    instructions: completionInstructions,
    schemaJson: JSON.stringify(toJsonSchema(judgedPageSchema)),
    prompt: (observation) => ({
      task: "judge-sign-in",
      loginPaths: ["/login"],
      slots: [],
      stepElements: [],
      observation,
    }),
    answer: JSON.stringify({ result: { decision: "unclear" } }),
  },
  {
    name: "logout",
    create: (config) => {
      const run = createLogoutGenerator(config);
      return (observation) => run({ observation });
    },
    instructions: logoutInstructions,
    schemaJson: JSON.stringify(toJsonSchema(logoutAnswerSchema)),
    prompt: (observation) => ({ task: "logout", observation }),
    answer: abstain,
  },
];

const configFor = (model: Config["model"]): Config => ({
  model,
  limits: { maxRetries: 0, timeoutMs: 1_000, maxInputBytes: 256 * 1024 },
  maxOutputTokens: 512,
});
const localFailure = (error: string) => ({
  status: "failed",
  error,
  calls: 0,
  usage: { inputTokens: 0, outputTokens: 0 },
});
const byteLength = (value: string) => new TextEncoder().encode(value).length;

describe.each(roles)("$name public structured role policy", (role) => {
  it("validates the configured model before limits, then limits before output tokens synchronously", () => {
    const model = textModel(async () => textResult(role.answer));
    const config = configFor(model);
    config.limits.timeoutMs = 0;
    config.maxOutputTokens = 15;
    expect(() =>
      role.create({ ...config, model: "unconfigured" as unknown as Config["model"] }),
    ).toThrow(new TypeError("Pass a configured model instance"));
    expect(() => role.create({ ...config, model: null as unknown as Config["model"] })).toThrow(
      TypeError,
    );
    try {
      role.create(config);
      throw new Error("Expected synchronous limits validation");
    } catch (error) {
      expect(error).toBeInstanceOf(v.ValiError);
      expect(error).toMatchObject({ issues: [{ path: [{ key: "timeoutMs" }] }] });
    }
    config.limits.timeoutMs = 1_000;
    expect(() => role.create(config)).toThrow(v.ValiError);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it.each([15, 16.5, 16_385])(
    "rejects invalid maxOutputTokens %s during construction",
    (tokens) => {
      const model = textModel(async () => textResult(role.answer));
      expect(() => role.create({ ...configFor(model), maxOutputTokens: tokens })).toThrow(
        v.ValiError,
      );
      expect(model.doGenerateCalls).toHaveLength(0);
    },
  );

  it.each([16, 16_384])(
    "accepts and forwards the inclusive output-token boundary %s",
    async (tokens) => {
      const model = textModel(async () => textResult(role.answer));
      const run = role.create({ ...configFor(model), maxOutputTokens: tokens });
      expect(await run(page)).toMatchObject({ status: "abstained", calls: 1 });
      expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(tokens);
    },
  );

  it("checks malformed and incomplete observations before request size", async () => {
    const model = textModel(async () => textResult(role.answer));
    const config = configFor(model);
    config.limits.maxInputBytes = 256;
    const run = role.create(config);
    expect(await run({ ...page, version: 2 })).toEqual(localFailure("invalid-request"));
    expect(await run({ ...page, complete: false })).toEqual(localFailure("incomplete-observation"));
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("accepts the exact UTF-8 request boundary including instructions and response schema", async () => {
    // Assert the public wire content as well as its bound: non-ASCII text must count in bytes.
    const prompt = JSON.stringify(role.prompt(page));
    const requestBytes =
      byteLength(role.instructions) + byteLength(prompt) + byteLength(role.schemaJson);
    expect(byteLength(prompt)).toBeGreaterThan(prompt.length);
    expect(requestBytes).toBeGreaterThan(256);
    const accepted = textModel(async () => textResult(role.answer));
    const run = role.create({
      ...configFor(accepted),
      limits: { timeoutMs: 1_000, maxInputBytes: requestBytes },
    });
    expect(await run(page)).toMatchObject({
      status: "abstained",
      calls: 1,
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    const call = accepted.doGenerateCalls[0]!;
    expect(
      call.prompt.filter((message) => message.role === "system").map((message) => message.content),
    ).toEqual([role.instructions]);
    const user = call.prompt.find((message) => message.role === "user");
    expect(user?.content).toEqual([{ type: "text", text: prompt }]);

    const rejected = textModel(async () => textResult(role.answer));
    const tooSmall = role.create({
      ...configFor(rejected),
      limits: { timeoutMs: 1_000, maxInputBytes: requestBytes - 1 },
    });
    expect(await tooSmall(page)).toEqual(localFailure("input-too-large"));
    expect(rejected.doGenerateCalls).toHaveLength(0);
  });

  it("captures limits and token cap at construction, including the retry and timeout limits", async () => {
    const model = textModel(async () => textResult(role.answer));
    const config = configFor(model);
    const originalLimits = config.limits;
    const run = role.create(config);
    originalLimits.maxInputBytes = 256;
    originalLimits.maxRetries = 2;
    originalLimits.timeoutMs = 100;
    config.limits = { maxInputBytes: 256, maxRetries: 2, timeoutMs: 100 };
    config.maxOutputTokens = 16;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      expect(await run(page)).toMatchObject({ status: "abstained", calls: 1 });
      expect(model.doGenerateCalls[0]?.maxOutputTokens).toBe(512);
      expect(timeout).toHaveBeenCalledWith(1_000);
      const retryable = textModel(async () => {
        throw new APICallError({
          message: "Synthetic retryable failure",
          url: "https://model.example.test",
          requestBodyValues: {},
          statusCode: 503,
          isRetryable: true,
        });
      });
      config.model = retryable;
      expect(await run(page)).toMatchObject({
        status: "failed",
        error: "provider-error",
        calls: 1,
        usage: { inputTokens: null, outputTokens: null },
      });
      expect(retryable.doGenerateCalls).toHaveLength(1);
    } finally {
      timeout.mockRestore();
    }
  });

  it("reads the model and refusal-category callback at invocation time", async () => {
    const original = textModel(async () => textResult(role.answer));
    const originalReader = vi.fn(() => "old-category");
    const config = { ...configFor(original), refusalCategory: originalReader };
    const run = role.create(config);
    const metadata = { fake: { category: "changed-category" } };
    const replacement = textModel(async () => ({
      ...textResult(role.answer, { finish: "content-filter" }),
      providerMetadata: metadata,
    }));
    const replacementReader = vi.fn(() => "changed-category");
    config.model = replacement;
    config.refusalCategory = replacementReader;
    expect(await run(page)).toMatchObject({
      status: "failed",
      error: "refused",
      refusalCategory: "changed-category",
      calls: 1,
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    expect(original.doGenerateCalls).toHaveLength(0);
    expect(replacement.doGenerateCalls).toHaveLength(1);
    expect(originalReader).not.toHaveBeenCalled();
    expect(replacementReader).toHaveBeenCalledWith(metadata);
  });
});

describe("completion instruction selection before request bounding", () => {
  const completion = roles.find((role) => role.name === "completion")!;

  it("rejects conflicting stop/beside modes before size, after malformed and incomplete checks", async () => {
    const model = textModel(async () => textResult(completion.answer));
    const config = configFor(model);
    config.limits.maxInputBytes = 256;
    const run = completion.create(config);
    const conflict = { stop: true, beside: true };
    expect(await run(page, conflict)).toEqual(localFailure("invalid-request"));
    expect(await run({ ...page, complete: false }, conflict)).toEqual(
      localFailure("incomplete-observation"),
    );
    expect(await run({ ...page, version: 2 }, conflict)).toEqual(localFailure("invalid-request"));
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it.each([
    { options: { stop: true }, instructions: completionStopInstructions },
    { options: { beside: true }, instructions: completionBesideInstructions },
  ])("bounds the selected instruction variant $options", async ({ options, instructions }) => {
    const prompt = JSON.stringify(completion.prompt(page));
    const bytes = byteLength(instructions) + byteLength(prompt) + byteLength(completion.schemaJson);
    const model = textModel(async () => textResult(completion.answer));
    const config = { ...configFor(model), limits: { timeoutMs: 1_000, maxInputBytes: bytes } };
    expect(await completion.create(config)(page, options)).toMatchObject({
      status: "abstained",
      calls: 1,
    });
    expect(model.doGenerateCalls[0]?.prompt[0]).toMatchObject({
      role: "system",
      content: instructions,
    });
    const rejected = textModel(async () => textResult(completion.answer));
    expect(
      await completion.create({
        ...configFor(rejected),
        limits: { timeoutMs: 1_000, maxInputBytes: bytes - 1 },
      })(page, options),
    ).toEqual(localFailure("input-too-large"));
    expect(rejected.doGenerateCalls).toHaveLength(0);
  });
});
