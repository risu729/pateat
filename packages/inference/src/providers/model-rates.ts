import type { ModelProvider, ModelSpeed } from "@pateat/contracts";
import type { InferenceUsage } from "../outcome";
import { claudeModelRates, estimateClaudeCost, type ClaudeRates } from "./claude-rates";
import { claudeWorstCaseRates } from "./claude";
import {
  estimateOpenAICostUsd,
  openAIModelRates,
  openAIWorstCaseRates,
  type OpenAIRates,
} from "./openai-rates";

export type ModelRates = ClaudeRates | OpenAIRates;
export const modelRates = (
  provider: ModelProvider,
  modelId: string,
  speed: ModelSpeed = "standard",
) => (provider === "openai" ? openAIModelRates(modelId, speed) : claudeModelRates(modelId, speed));
export const estimateModelCostUsd = (
  provider: ModelProvider,
  usage: InferenceUsage,
  rates: ModelRates,
) =>
  provider === "openai"
    ? estimateOpenAICostUsd(usage, rates as OpenAIRates)
    : estimateClaudeCost(usage, rates as ClaudeRates);
export const modelWorstCaseRates = (
  provider: ModelProvider,
  rates: ModelRates,
  maxInputTokens: number,
) =>
  provider === "openai"
    ? openAIWorstCaseRates(rates as OpenAIRates, maxInputTokens)
    : claudeWorstCaseRates(rates as ClaudeRates, maxInputTokens);
