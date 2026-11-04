import { APICallError, InvalidResponseDataError } from "ai";
import * as v from "valibot";
import type { FiniteChoiceModel } from "../decision";
import { clefAccountIdSchema, clefUrl, isClefModel, type ClefModelId } from "./clef-models";

export {
  clefAccountIdSchema,
  clefModels,
  clefUrl,
  estimateClefCostUsd,
  isClefModel,
  type ClefModelId,
} from "./clef-models";

type DecideOptions = Parameters<FiniteChoiceModel["doDecide"]>[0];
type DecideResult = Awaited<ReturnType<FiniteChoiceModel["doDecide"]>>;
type Question = DecideOptions["questions"][string];
type Answer = DecideResult["answers"][string];

const credentialValue = v.pipe(v.string(), v.trim(), v.nonEmpty());

// Clef question IDs: letters, digits, `_`, `.` and `-`, at most 100 characters.
const questionIdPattern = /^[A-Za-z0-9_.-]{1,100}$/;
/** A Clef-safe question ID for each of ours, unique, mapped back on the answer. */
function clefQuestionIds(ids: readonly string[]): Map<string, string> {
  const mapped = new Map<string, string>();
  const used = new Set<string>();
  ids.forEach((id, index) => {
    let safe = questionIdPattern.test(id)
      ? id
      : id.replaceAll(/[^A-Za-z0-9_.-]/gu, ".").slice(0, 100) || `q${index}`;
    if (used.has(safe)) safe = `q${index}`;
    while (used.has(safe)) safe = `${safe}_`;
    used.add(safe);
    mapped.set(id, safe);
  });
  return mapped;
}

function clefQuestion(id: string, question: Question) {
  if (question.instructions === undefined || question.instructions === null)
    throw new TypeError(`Clef needs instructions for question ${id}.`);
  const { instructions } = question;
  switch (question.type) {
    case "choice":
      return { type: "choice", instructions, criteria: question.criteria };
    case "score":
      return { type: "score", instructions, criteria: question.criteria };
    case "boolean":
      return {
        type: "noul",
        instructions,
        ...(question.criteria === undefined ? {} : { criteria: question.criteria }),
      };
    default:
      throw new TypeError(`Clef answers no ${question.type} questions.`);
  }
}

/** The state as Clef reads it: one part as itself, several as an array. Text and JSON only. */
function clefState(state: DecideOptions["state"]) {
  const parts = state.map((part) => {
    if (part.type === "text") return part.text;
    if (part.type === "json") return part.value;
    throw new TypeError("This adapter sends no files to Clef.");
  });
  return parts.length === 1 ? parts[0] : parts;
}

const probabilities = v.record(v.string(), v.pipe(v.number(), v.minValue(0), v.maxValue(1)));
const answerSchema = v.variant("type", [
  v.object({ type: v.literal("choice"), choice: v.string(), probabilities }),
  v.object({ type: v.literal("score"), score: v.number(), probabilities }),
  v.object({ type: v.literal("noul"), noul: v.pipe(v.number(), v.minValue(0), v.maxValue(1)) }),
]);
const count = v.pipe(v.number(), v.integer(), v.minValue(0));
const resultSchema = v.object({
  model: v.string(),
  answers: v.record(v.string(), answerSchema),
  usage: v.optional(
    v.object({ input_tokens: v.optional(count), output_tokens: v.optional(count) }),
  ),
});
const responseSchema = v.object({ success: v.literal(true), result: resultSchema });
const errorSchema = v.object({
  errors: v.optional(v.array(v.object({ code: v.optional(v.number()) })), []),
});

type ClefResult = v.InferOutput<typeof resultSchema>;

/** The body of one Clef call, under Clef-safe question IDs, and how to map its answers back. */
function clefRequest(call: DecideOptions, modelId: ClefModelId) {
  const ids = clefQuestionIds(Object.keys(call.questions));
  const original = new Map([...ids].map(([id, safe]) => [safe, id]));
  const body = {
    model: modelId,
    state: clefState(call.state),
    questions: Object.fromEntries(
      Object.entries(call.questions).map(([id, question]) => [
        ids.get(id)!,
        clefQuestion(id, question),
      ]),
    ),
  };
  return { body, original };
}

/** A Clef result as the decision contract answers it, under the role's question IDs. */
function decisionResult(result: ClefResult, original: ReadonlyMap<string, string>): DecideResult {
  const answers: Record<string, Answer> = {};
  for (const [safe, answer] of Object.entries(result.answers)) {
    const id = original.get(safe);
    if (id === undefined)
      throw new InvalidResponseDataError({
        data: undefined,
        message: "Clef answered a question that was not asked.",
      });
    answers[id] =
      answer.type === "noul"
        ? { type: "boolean", probability: answer.noul }
        : answer.type === "choice"
          ? { type: "choice", choice: answer.choice, probabilities: answer.probabilities }
          : { type: "score", score: answer.score, probabilities: answer.probabilities };
  }
  return {
    answers,
    rounding: { probabilityDecimals: 4, scoreDecimals: 4 },
    usage: {
      ...(result.usage?.input_tokens === undefined
        ? {}
        : { inputTokens: result.usage.input_tokens }),
      ...(result.usage?.output_tokens === undefined
        ? {}
        : { outputTokens: result.usage.output_tokens }),
    },
    warnings: [],
    response: { modelId: result.model },
  };
}

const invalidAnswer = () =>
  new InvalidResponseDataError({
    data: undefined,
    message: "Workers AI returned no Clef answer in the documented shape.",
  });

function decisionModel(modelId: ClefModelId, doDecide: FiniteChoiceModel["doDecide"]) {
  if (!isClefModel(modelId)) throw new TypeError(`Unknown Clef model ${String(modelId)}.`);
  return {
    specificationVersion: "v4",
    provider: "cloudflare.workers-ai",
    modelId,
    supportedQuestionTypes: ["choice", "score", "boolean"],
    doDecide,
  } satisfies FiniteChoiceModel;
}

/**
 * A Clef model behind the AI SDK decision contract, calling the Workers AI REST API
 * directly (`workers-ai-provider` has no decision model). Question IDs Clef does not
 * accept, such as `slot:username`, are sent as safe IDs and answered under the original
 * ones. Errors carry status and Cloudflare error codes only, never page content. Clef
 * rounds probabilities to four decimals, which the result declares.
 */
export function createClefDecisionModel(options: {
  accountId: string;
  apiToken: string;
  modelId: ClefModelId;
  /** Test seam, and the relay of a call a device makes (ADR 0083). */
  fetch?: typeof globalThis.fetch;
}): FiniteChoiceModel {
  const account = v.parse(clefAccountIdSchema, options.accountId);
  const token = v.parse(credentialValue, options.apiToken);
  const { modelId } = options;
  const url = clefUrl(account, modelId);
  const fetch = options.fetch ?? globalThis.fetch;
  return decisionModel(modelId, async (call) => {
    const { body, original } = clefRequest(call, modelId);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      ...(call.abortSignal === undefined ? {} : { signal: call.abortSignal }),
    });
    const text = await response.text();
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!response.ok) {
      const parsed = v.safeParse(errorSchema, json);
      const codes = parsed.success ? parsed.output.errors.flatMap((error) => error.code ?? []) : [];
      throw new APICallError({
        message: `Workers AI answered ${response.status}${codes.length ? ` (codes ${codes.join(", ")})` : ""}.`,
        url,
        requestBodyValues: { model: modelId },
        statusCode: response.status,
        isRetryable: response.status === 429 || response.status >= 500,
      });
    }
    const parsed = v.safeParse(responseSchema, json);
    if (!parsed.success) throw invalidAnswer();
    return decisionResult(parsed.output.result, original);
  });
}

/** What the adapter needs of a Worker's Workers AI binding (`env.AI`). */
export type WorkersAiBinding = { run(model: string, input: unknown): Promise<unknown> };

/**
 * A Clef model behind the AI SDK decision contract, called through a Worker's Workers AI
 * binding (ADR 0083), which bills the Worker's own Cloudflare account and needs no token.
 * The binding answers the REST result's contents. A failed call throws an `APICallError`
 * without the binding's message, which may quote the request.
 */
export function createClefBindingModel(options: {
  ai: WorkersAiBinding;
  modelId: ClefModelId;
}): FiniteChoiceModel {
  const { ai, modelId } = options;
  if (typeof ai?.run !== "function") throw new TypeError("Pass the Workers AI binding");
  return decisionModel(modelId, async (call) => {
    const { body, original } = clefRequest(call, modelId);
    let output: unknown;
    try {
      output = await ai.run(`@cf/cloudflare/${modelId}`, body);
    } catch {
      throw new APICallError({
        message: "The Workers AI binding failed the Clef call.",
        url: `workers-ai:@cf/cloudflare/${modelId}`,
        requestBodyValues: { model: modelId },
        isRetryable: false,
      });
    }
    const parsed = v.safeParse(resultSchema, output);
    if (!parsed.success) throw invalidAnswer();
    return decisionResult(parsed.output, original);
  });
}
