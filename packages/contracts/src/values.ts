import { valueCharacterClasses, type ValueShape } from "./observation";

// The local value check and value shapes of ADR 0010, shared by the inference harness
// and the extension. They run only on the trusted side; values never leave it.

// WHATWG "valid email address" and "valid floating-point number" productions, so the
// local check agrees with what the browser would accept in that input type. Browsers
// also trim email whitespace and accept IDN domains; those values fail here, which
// stops the fill rather than risking a wrong one.
const validEmail =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const validNumber = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

export type ValueMismatch = "missing-value" | "too-long" | "too-short" | "not-email" | "not-number";

/**
 * The constraints an input declares: its type (an observed role or an input's `type`;
 * only `email` and `number` are checked) and its `maxlength` and `minlength`, if any.
 */
export interface InputConstraints {
  type: string;
  maxLength?: number | undefined;
  minLength?: number | undefined;
}

/**
 * Why the page would reject `value` in an input with these constraints, or undefined
 * when it fits. A mismatch means the mapping is wrong or the page would reject the
 * value, so the caller must not fill.
 */
export function valueMismatch(
  { type, maxLength, minLength }: InputConstraints,
  value: string | undefined,
): ValueMismatch | undefined {
  if (value === undefined || value.length === 0) return "missing-value";
  // Browsers ignore maxlength and minlength on number inputs; lengths are UTF-16 units.
  const bounded = type !== "number";
  if (bounded && maxLength !== undefined && value.length > maxLength) return "too-long";
  if (bounded && minLength !== undefined && value.length < minLength) return "too-short";
  if (type === "email" && !validEmail.test(value)) return "not-email";
  if (type === "number" && !validNumber.test(value)) return "not-number";
  return undefined;
}

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
    email: validEmail.test(value),
  };
}
