import type { LoginObservation, ValueShape } from "./observation";
import { valueCharacterClasses } from "./observation";
import type { PagePlan } from "./plan";

const classOf = (character: string): ValueShape["classes"][number] => {
  if (/^[0-9]$/.test(character)) return "ascii-digit";
  if (/^[A-Za-z]$/.test(character)) return "ascii-letter";
  if (/^[\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E]$/.test(character)) return "ascii-symbol";
  if (/^\s$/u.test(character)) return "space";
  if (/^[！-～]$/.test(character)) return "fullwidth";
  return "other";
};

// WHATWG "valid email address" and "valid floating-point number" productions, so the
// local check agrees with what the browser would accept in that input type.
const validEmail =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const validNumber = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

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
    email: validEmail.test(value),
  };
}

export type ValueMismatch = "missing-value" | "too-long" | "too-short" | "not-email" | "not-number";

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
    const fail = (reason: ValueMismatch) => ({ ok: false as const, slot: field.slot, reason });
    if (value === undefined || value.length === 0) return fail("missing-value");
    // Browsers ignore maxlength and minlength on number inputs.
    const bounded = candidate.role !== "number";
    if (bounded && candidate.maxLength !== undefined && value.length > candidate.maxLength)
      return fail("too-long");
    if (bounded && candidate.minLength !== undefined && value.length < candidate.minLength)
      return fail("too-short");
    if (candidate.role === "email" && !validEmail.test(value)) return fail("not-email");
    if (candidate.role === "number" && !validNumber.test(value)) return fail("not-number");
  }
  return { ok: true };
}
