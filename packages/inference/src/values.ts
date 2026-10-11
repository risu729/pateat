import {
  isValidEmail,
  valueCharacterClasses,
  valueMismatch,
  type LoginObservation,
  type ValueMismatch,
  type ValueShape,
} from "@pateat/contracts";
import type { PagePlan } from "./plan";

const classOf = (character: string): ValueShape["classes"][number] => {
  if (/^[0-9]$/.test(character)) return "ascii-digit";
  if (/^[A-Za-z]$/.test(character)) return "ascii-letter";
  if (/^[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]$/.test(character)) return "ascii-symbol";
  if (/^\s$/u.test(character)) return "space";
  if (/^[！-～]$/.test(character)) return "fullwidth";
  return "other";
};

/**
 * A value the shape may describe (ADR 0010): the login username or a Bitwarden Text
 * custom field. Resolve a Linked field to its source first; Hidden, password and TOTP
 * values have no source type here and never get a shape.
 */
export type ShapeableValue = { source: "username" | "text"; value: string };

/**
 * Derives the coarse shape of a visible identifier value on the trusted side. Returns
 * undefined for values the shape contract cannot describe.
 */
export function valueShapeOf({ source, value }: ShapeableValue): ValueShape | undefined {
  if (source !== "username" && source !== "text") return undefined;
  if (value.length === 0 || value.length > 1024) return undefined;
  const present = new Set(Array.from(value, classOf));
  return {
    length: value.length,
    classes: valueCharacterClasses.filter((entry) => present.has(entry)),
    email: isValidEmail(value),
  };
}

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
