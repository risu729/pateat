// Offline fakes for tests. They never perform network I/O or paid inference.
import { MockLanguageModelV4 } from "ai/test";
import { evaluationCorpus, type EvaluationCase } from "../corpus/cases";
import type { FiniteChoiceModel } from "../decision";

type GenerateOptions = Parameters<MockLanguageModelV4["doGenerate"]>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV4["doGenerate"]>>;
type DecideOptions = Parameters<FiniteChoiceModel["doDecide"]>[0];
type DecideResult = Awaited<ReturnType<FiniteChoiceModel["doDecide"]>>;

export const usage = (input?: number, output?: number): GenerateResult["usage"] => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});

export const textResult = (
  text: string,
  options: {
    finish?: GenerateResult["finishReason"]["unified"];
    usage?: GenerateResult["usage"];
  } = {},
): GenerateResult => ({
  content: [{ type: "text", text }],
  finishReason: { unified: options.finish ?? "stop", raw: undefined },
  usage: options.usage ?? usage(120, 30),
  warnings: [],
});

export function textModel(respond: (options: GenerateOptions) => PromiseLike<GenerateResult>) {
  return new MockLanguageModelV4({
    provider: "fake",
    modelId: "fake-generator",
    doGenerate: respond,
  });
}

/** The JSON request the generation role sent, parsed back from the user message. */
export function generationRequest(options: GenerateOptions): {
  task: string;
  slots: unknown[];
  observation: { origin: string; path: string };
  repair?: unknown;
} {
  const user = [...options.prompt].reverse().find((message) => message.role === "user");
  const part = user?.content.find((entry) => entry.type === "text");
  if (part?.type !== "text") throw new Error("Missing user text");
  return JSON.parse(part.text);
}

export const caseFor = (page: { origin: string; path: string }): EvaluationCase => {
  const found = evaluationCorpus.find(
    (entry) => entry.observation.origin === page.origin && entry.observation.path === page.path,
  );
  if (found === undefined) throw new Error("Unknown synthetic page");
  return found;
};

/** A generation fake that answers every corpus page with its ground truth. */
export const oracleGenerator = () =>
  textModel(async (options) => {
    const expected = caseFor(generationRequest(options).observation).expected;
    const result =
      expected.kind === "abstain"
        ? { decision: "abstain", reason: "ambiguous" }
        : {
            decision: "plan",
            fields: Object.entries(expected.fields).map(([slot, candidate]) => ({
              slot,
              candidate,
            })),
            action: { candidate: expected.action, purpose: expected.purpose },
          };
    return textResult(JSON.stringify({ result }));
  });

export function decisionModel(
  respond: (options: DecideOptions) => PromiseLike<DecideResult>,
): FiniteChoiceModel & { calls: DecideOptions[] } {
  const calls: DecideOptions[] = [];
  return {
    specificationVersion: "v4",
    provider: "fake",
    modelId: "fake-decider",
    supportedQuestionTypes: ["choice"],
    calls,
    doDecide: (options) => {
      calls.push(options);
      return respond(options);
    },
  };
}

/** A complete distribution that puts `confidence` on `choice`. */
export function distribution(options: readonly string[], choice: string, confidence = 0.9) {
  const rest = options.length > 1 ? (1 - confidence) / (options.length - 1) : 0;
  return Object.fromEntries(
    options.map((option) => [
      option,
      option === choice ? (options.length > 1 ? confidence : 1) : rest,
    ]),
  );
}

export const decisionState = (options: DecideOptions) => {
  const part = options.state[0];
  if (part?.type !== "json") throw new Error("Expected JSON state");
  return part.value as { page: { origin: string; path: string } };
};

/** A decision fake that answers every corpus page with its ground truth. */
export const oracleDecider = () =>
  decisionModel(async (options) => {
    const expected = caseFor(decisionState(options).page).expected;
    const answers: DecideResult["answers"] = {};
    for (const [id, question] of Object.entries(options.questions)) {
      if (question.type !== "choice") throw new Error("Unexpected question type");
      const keys = Object.keys(question.criteria);
      const target =
        expected.kind === "abstain"
          ? undefined
          : id === "action"
            ? expected.action
            : expected.fields[id.slice("slot:".length)];
      const choice = target === undefined ? "none" : `c:${target}`;
      answers[id] = { type: "choice", choice, probabilities: distribution(keys, choice) };
    }
    return { answers, usage: { inputTokens: 300 }, warnings: [] };
  });
