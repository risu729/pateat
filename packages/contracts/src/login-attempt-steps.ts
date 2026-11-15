import { keypadStep, loginStepEffect, type LoginStep } from "./login/targets";
import { TOTP_HANDLER_SLOT } from "./login/route-schema";

/** A step that may advance or submit the page: a click, or a fill whose event may. */
export const effectfulStep = (step: LoginStep): boolean => {
  const effect = loginStepEffect(step);
  return effect !== undefined && effect !== "prepare";
};
/**
 * What a fill-only login takes of `step` (ADR 0021 D): nothing of a step with an effect or
 * of a fill on a page's software keyboard, whose presses the page may act on (ADR 0067),
 * and a fill without its TOTP code, whose input may submit at its last digit as a PIN pad
 * does (ADR 0027 amendment of 2026-10-23); nothing of a fill of the code alone.
 */
export function fillOnlyStep(step: LoginStep): LoginStep | undefined {
  if (effectfulStep(step) || keypadStep(step)) return undefined;
  if (step.kind !== "fill") return step;
  const fields = step.fields.filter((field) => field.slot !== TOTP_HANDLER_SLOT);
  if (fields.length === 0) return undefined;
  return fields.length === step.fields.length ? step : { ...step, fields };
}
/** A step a fill-only login never takes any of (`fillOnlyStep`). */
export const fillOnlyStops = (step: LoginStep): boolean => fillOnlyStep(step) === undefined;
