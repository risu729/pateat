import { valueMismatch, type LoginObservation, type ValueMismatch } from "@pateat/contracts";
import type { PagePlan } from "./plan";

export { valueShapeOf, type ShapeableValue } from "@pateat/contracts";

/**
 * Checks a validated plan against the real slot values before anything is filled.
 * Runs locally only; values never leave the trusted side. A mismatch means the
 * mapping is wrong or the page would reject the value, so the caller must not fill.
 */
export function checkPlanValues(
  observation: LoginObservation,
  plan: Pick<PagePlan, "fields">,
  values: ReadonlyMap<string, string>,
): { ok: true } | { ok: false; slot: string; reason: ValueMismatch } {
  const candidates = new Map(observation.candidates.map((candidate) => [candidate.id, candidate]));
  for (const field of plan.fields) {
    const value = values.get(field.slot);
    const candidate = candidates.get(field.candidate);
    if (candidate === undefined) throw new Error("Check a validated plan for this observation");
    const reason = valueMismatch(
      { type: candidate.role, maxLength: candidate.maxLength, minLength: candidate.minLength },
      value,
    );
    if (reason) return { ok: false, slot: field.slot, reason };
  }
  return { ok: true };
}
