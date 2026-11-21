import * as v from "valibot";

/**
 * An identifier split over several inputs (ADR 0089): one value, such as a customer number
 * `NNNN-NNNN-NNNNN`, typed in parts into 2 to 6 consecutive inputs whose `maxlength` is 2
 * to 8 each. A recipe's fill field names the first input and the parts' lengths; the
 * extension finds the others from the first by the page rule. This is apart from a `totp`
 * handler's code split one digit per input (ADR 0027) and from a personal detail's parts
 * (ADR 0061).
 */
export const SPLIT_PARTS = { min: 2, max: 6 } as const;
/** The `maxlength` of each part of a split identifier (ADR 0089). */
export const SPLIT_PART_LENGTH = { min: 2, max: 8 } as const;

/** A recipe fill field's split (ADR 0089): each part's `maxlength`, in page order. */
export const splitLengthsSchema = v.pipe(
  v.array(
    v.pipe(
      v.number(),
      v.integer(),
      v.minValue(SPLIT_PART_LENGTH.min),
      v.maxValue(SPLIT_PART_LENGTH.max),
    ),
  ),
  v.minLength(SPLIT_PARTS.min),
  v.maxLength(SPLIT_PARTS.max),
);

/**
 * Spaces of any kind, and hyphens and dashes a person writes between a number's groups. A
 * full-width hyphen or space is one of them once the value is in NFKC.
 */
const separators = /[\s\u002D\u2010-\u2015\u2212]/gu;

/**
 * The parts of `value` for inputs of these lengths (ADR 0089), on the trusted side only:
 * the value in NFKC with every space and hyphen taken out, then every part but the last
 * exactly its length and the last the rest, 1 character up to its length. Letters stay,
 * as some identifiers have them. Undefined when the value does not fit.
 */
export function splitIdentifier(value: string, lengths: readonly number[]): string[] | undefined {
  const plain = value.normalize("NFKC").replaceAll(separators, "");
  const parts: string[] = [];
  let at = 0;
  for (const [index, length] of lengths.entries()) {
    const last = index === lengths.length - 1;
    const part = last ? plain.slice(at) : plain.slice(at, at + length);
    if (part.length === 0 || part.length > length || (!last && part.length !== length))
      return undefined;
    parts.push(part);
    at += part.length;
  }
  return parts;
}

/**
 * Why a split identifier's value fits no inputs of these lengths, as the local value check
 * names it (ADR 0010): `missing-value`, `too-long` or `too-short`; undefined when it fits.
 */
export function splitMismatch(
  value: string | undefined,
  lengths: readonly number[],
): "missing-value" | "too-long" | "too-short" | undefined {
  if (value === undefined || value.length === 0) return "missing-value";
  if (splitIdentifier(value, lengths)) return undefined;
  const plain = value.normalize("NFKC").replaceAll(separators, "");
  return plain.length > lengths.reduce((sum, length) => sum + length, 0) ? "too-long" : "too-short";
}
