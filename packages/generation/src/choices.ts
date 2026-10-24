import {
  DEFAULT_MODEL_CONFIG,
  type ModelChoice,
  type ModelConfig,
  type ModelRole,
} from "@pateat/contracts";
import { claudeModelRates, type ClaudeModelChoice, type InferenceOutcome } from "@pateat/inference";
import type { ServedModel } from "./backend";

// Which models a role asks, in order (ADR 0014, owner 2026-10-23 11:31 UTC), wherever the
// call is made: the owner's choices on the service, the defaults on a device without one
// (ADR 0040).

/** A configured model to call, with the rates its speed is charged at. */
export type RoleChoice = ClaudeModelChoice & { speed: "standard" | "fast" };

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
): RoleChoice[] {
  const priced = (choices: readonly ModelChoice[]) =>
    choices.flatMap((saved) => {
      const choice =
        saved.speed === "fast" && fastFailing.has(saved.model)
          ? { ...saved, speed: "standard" as const }
          : saved;
      const rates = claudeModelRates(choice.model, choice.speed);
      if (rates === undefined) {
        console.warn("Configured Claude model has no price", {
          role,
          model: choice.model,
          speed: choice.speed,
        });
        return [];
      }
      return [{ modelId: choice.model, effort: choice.effort, rates, speed: choice.speed }];
    });
  const choices = priced(config[role]);
  return choices.length > 0 ? choices : priced(DEFAULT_MODEL_CONFIG[role]);
}

/** The failures after which fast mode asks the same model at the standard speed. */
const FAST_RETRY = new Set(["rate-limited", "provider-error", "timeout"]);

/** A choice's calls in order: fast mode is followed by the same model at the standard speed. */
export function choiceAttempts(choice: RoleChoice): RoleChoice[] {
  if (choice.speed !== "fast") return [choice];
  const rates = claudeModelRates(choice.modelId);
  return rates === undefined ? [choice] : [choice, { ...choice, rates, speed: "standard" }];
}

export const servedModel = (choice: RoleChoice): ServedModel => ({
  provider: "anthropic",
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
  const sameModel = attempt.modelId === served.model;
  if (outcome.error === "refused" && sameModel) return "skip";
  return outcome.error === "refused" ||
    (served.speed === "fast" && sameModel && FAST_RETRY.has(outcome.error))
    ? "ask"
    : "stop";
}
