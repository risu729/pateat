import type { RoleChoice } from "@pateat/generation";
import {
  claudeModelRates,
  createClaudeGenerationModel,
  createOpenAIGenerationModel,
  openAIModelRates,
} from "@pateat/inference";
import type { ModelCredential } from "./provider-credentials";

/** Provider-specific SDK options stay here; role execution and safety checks are shared. */
export function providerModel(
  choice: RoleChoice,
  credential: ModelCredential,
  options: { beforeRequest?: () => Promise<void>; fetch?: typeof globalThis.fetch } = {},
) {
  if (choice.provider === "openai") {
    if (!("apiKey" in credential)) throw new TypeError("OpenAI needs an API key");
    return createOpenAIGenerationModel({
      apiKey: credential.apiKey,
      choice: { ...choice, rates: openAIModelRates(choice.modelId, choice.speed)! },
      ...options,
    });
  }
  return createClaudeGenerationModel({
    ...credential,
    choice: { ...choice, rates: claudeModelRates(choice.modelId, choice.speed)! },
    ...options,
  });
}
