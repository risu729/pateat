// The local value check of ADR 0010, shared by the inference harness (`checkPlanValues`)
// and the login executor. It runs only on the trusted side; values never leave it.

// WHATWG "valid email address" and "valid floating-point number" productions, so the
// local check agrees with what the browser would accept in that input type. Browsers
// also trim email whitespace and accept IDN domains; those values fail here, which
// stops the fill rather than risking a wrong one.
const validEmail =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const validNumber = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/** Whether `value` is a WHATWG valid email address, as an `email` input requires. */
export const isValidEmail = (value: string) => validEmail.test(value);

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
