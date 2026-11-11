import { createOpenAI, type OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import {
  modelEfforts,
  modelSpeeds,
  openAIModelIds,
  type ModelEffort,
  type ModelSpeed,
} from "@pateat/contracts";
import { wrapLanguageModel } from "ai";
import * as v from "valibot";
import { openAIModelRates, type OpenAIRates } from "./openai-rates";

export type OpenAIModelChoice = {
  modelId: string;
  effort: ModelEffort;
  speed?: ModelSpeed;
  rates: OpenAIRates;
};
export const openAIGeneration = {
  modelId: "gpt-6.1-sol",
  effort: "low",
  speed: "standard",
  rates: openAIModelRates("gpt-6.1-sol")!,
} as const;
export const openAIResponsesUrl = "https://api.openai.com/v1/responses";

/** Explicit key and fixed origin; the SDK cannot fall back to environment credentials or URLs. */
export function createOpenAIGenerationModel(options: {
  apiKey: string;
  choice?: OpenAIModelChoice;
  beforeRequest?: () => Promise<void>;
  fetch?: typeof globalThis.fetch;
}) {
  const apiKey = v.parse(v.pipe(v.string(), v.trim(), v.nonEmpty()), options.apiKey);
  const choice = options.choice ?? openAIGeneration;
  v.parse(v.picklist(openAIModelIds), choice.modelId);
  v.parse(v.picklist(modelEfforts), choice.effort);
  v.parse(v.picklist(modelSpeeds), choice.speed ?? "standard");
  const provider = createOpenAI({
    apiKey,
    baseURL: "https://api.openai.com/v1",
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const settings = {
    store: false,
    reasoningEffort: choice.effort,
    reasoningSummary: null,
    serviceTier: choice.speed === "fast" ? "fast" : "default",
    forceReasoning: true,
    strictJsonSchema: false,
  } satisfies OpenAIResponsesProviderOptions;
  return wrapLanguageModel({
    model: provider.responses(choice.modelId),
    middleware: {
      specificationVersion: "v4",
      transformParams: async ({ type, params }) => {
        if (
          type !== "generate" ||
          params.tools?.length ||
          params.prompt.some(
            (message) =>
              message.role !== "system" &&
              (message.role !== "user" || message.content.some((part) => part.type !== "text")),
          )
        )
          throw new TypeError(
            "OpenAI recipe generation accepts only non-streaming text without tools.",
          );
        return { ...params, providerOptions: { openai: settings } };
      },
      wrapGenerate: async ({ doGenerate }) => {
        await options.beforeRequest?.();
        return doGenerate();
      },
    },
  });
}
