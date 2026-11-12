import {
  DEFAULT_MODEL_CONFIG,
  type ModelChoice,
  type ModelConfig,
  type ModelRole,
} from "@pateat/contracts";
import {
  claudeModelRates,
  openAIModelRates,
  type ClaudeRates,
  type OpenAIRates,
  type InferenceOutcome,
} from "@pateat/inference";
import type { ServedModel } from "./backend";

// Which models a role asks, in order (ADR 0014, owner 2026-10-23 11:31 UTC), wherever the
// call is made: the owner's choices on the service, the defaults on a device without one
// (ADR 0040).

/** A configured model to call, with rates belonging to that provider. */
type Choice = {
  modelId: string;
  effort: ModelChoice["effort"];
  speed: ModelChoice["speed"];
};
export type RoleChoice = Choice &
  ({ provider: "anthropic"; rates: ClaudeRates } | { provider: "openai"; rates: OpenAIRates });

function pricedChoice(
  choice: Choice & { provider: ModelChoice["provider"] },
): RoleChoice | undefined {
  if (choice.provider === "openai") {
    const rates = openAIModelRates(choice.modelId, choice.speed);
    return rates === undefined ? undefined : { ...choice, provider: "openai", rates };
  }
  const rates = claudeModelRates(choice.modelId, choice.speed);
  return rates === undefined ? undefined : { ...choice, provider: "anthropic", rates };
}

/**
 * The role's choices in order, each with its published rates. Fast mode on a model in
 * `fastFailing` runs at the standard speed, so a saved choice the page now refuses stops
 * paying for failed fast calls. A choice the pricing page no longer prices is skipped and
 * logged, since its spend could not be bounded; with none left the role asks the defaults.
 */
export function roleChoices(
  config: ModelConfig,
  role: ModelRole,
  fastFailing: ReadonlySet<string> = new Set(),
  defaults: ModelConfig = DEFAULT_MODEL_CONFIG,
): RoleChoice[] {
  const priced = (choices: readonly ModelChoice[]) =>
    choices.flatMap((saved) => {
      const choice =
        saved.speed === "fast" && fastFailing.has(`${saved.provider}:${saved.model}`)
          ? { ...saved, speed: "standard" as const }
          : saved;
      const result = pricedChoice({
        provider: choice.provider,
        modelId: choice.model,
        effort: choice.effort,
        speed: choice.speed,
      });
      if (result === undefined) {
        console.warn("Configured model has no price", {
          role,
          provider: choice.provider,
          model: choice.model,
          speed: choice.speed,
        });
        return [];
      }
      return [result];
    });
  const choices = priced(config[role]);
  return choices.length > 0 ? choices : priced(defaults[role]);
}

/** The failures after which fast mode asks the same model at the standard speed. */
const FAST_RETRY = new Set(["rate-limited", "provider-error", "timeout"]);

/** A choice's calls in order: fast mode is followed by the same model at the standard speed. */
export function choiceAttempts(choice: RoleChoice): RoleChoice[] {
  if (choice.speed !== "fast") return [choice];
  const standard = pricedChoice({ ...choice, speed: "standard" });
  return standard === undefined ? [choice] : [choice, standard];
}

export const servedModel = (choice: RoleChoice): ServedModel => ({
  provider: choice.provider,
  model: choice.modelId,
  effort: choice.effort,
  speed: choice.speed,
});

/**
 * Whether a role asks `attempt` after the call that answered `last` (owner decision,
 * 2026-10-23 11:31 UTC): a refusal asks the next choice, skipping the same model at the
 * standard speed; fast mode that failed asks the same model at the standard speed; any
 * other outcome ends the request.
 */
export function nextAttempt(
  last: { outcome: InferenceOutcome<unknown>; served: ServedModel },
  attempt: RoleChoice,
): "ask" | "skip" | "stop" {
  const { outcome, served } = last;
  if (outcome.status !== "failed") return "stop";
  const sameModel = attempt.provider === served.provider && attempt.modelId === served.model;
  if (outcome.error === "refused" && sameModel) return "skip";
  return outcome.error === "refused" ||
    (served.speed === "fast" && sameModel && FAST_RETRY.has(outcome.error))
    ? "ask"
    : "stop";
}
