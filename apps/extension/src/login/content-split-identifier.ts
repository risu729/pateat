import { splitIdentifier, type LoginStep } from "@pateat/contracts";
import { typeValue } from "../page/enter-value";
import { inputValueMismatch } from "../page/fill-checks";
import { nextFrame } from "../page/frames";
import { splitGroupFrom } from "../page/split-identifier";

type FillField = Extract<LoginStep, { kind: "fill" }>["fields"][number];

/**
 * The inputs of each fill field that splits an identifier over several inputs (ADR 0089),
 * by its first input: the group the page rule finds from that input (`splitGroupFrom`),
 * which must have as many parts as the field's `split` and each part the `maxlength` it
 * names. `undefined` when one does not match, so that nothing is filled. This rule is not
 * the one a `totp` handler's code split one digit per input follows (ADR 0027).
 */
export function splitFieldParts(
  fields: readonly FillField[],
  inputs: readonly (Element | undefined)[],
): Map<Element, HTMLInputElement[]> | undefined {
  const found = new Map<Element, HTMLInputElement[]>();
  for (const [index, { split }] of fields.entries()) {
    if (!split) continue;
    const first = inputs[index];
    const group = first instanceof HTMLInputElement ? splitGroupFrom(first) : undefined;
    if (
      !first ||
      group?.length !== split.length ||
      group.some((input, at) => input.maxLength !== split[at])
    )
      return undefined;
    found.set(first, group);
  }
  return found;
}

/**
 * The fill's inputs with each split identifier's other parts after its first (ADR 0089),
 * as the page's validation is read after the fill, and the fill field each one is of.
 */
export function withParts<Input extends Element>(
  inputs: readonly Input[],
  parts: ReadonlyMap<Element, readonly HTMLInputElement[]>,
): {
  inputs: (Input | HTMLInputElement)[];
  fieldOf: (at: number | undefined) => number | undefined;
} {
  const all = (input: Input): (Input | HTMLInputElement)[] => [...(parts.get(input) ?? [input])];
  const fields = inputs.flatMap((input, field) => all(input).map(() => field));
  return {
    inputs: inputs.flatMap(all),
    fieldOf: (at) => (at === undefined ? undefined : fields[at]),
  };
}

/** Whether the page rule still finds these parts from their first input. */
export function sameParts(parts: readonly HTMLInputElement[]): boolean {
  const now = parts[0] && splitGroupFrom(parts[0]);
  return now?.length === parts.length && now.every((input, at) => input === parts[at]);
}

/** Each part's input with the value's part for it (`splitIdentifier`), or undefined. */
const pairs = (parts: readonly HTMLInputElement[], value: string) => {
  const values = splitIdentifier(
    value,
    parts.map((input) => input.maxLength),
  );
  return values?.map((part, at) => [parts[at]!, part] as const);
};

/** Whether `value` splits into `parts` and each part fits its input (ADR 0010). */
export function splitFits(parts: readonly HTMLInputElement[], value: string): boolean {
  return (
    pairs(parts, value)?.every(([input, part]) => inputValueMismatch(input, part) === undefined) ??
    false
  );
}

/**
 * Types `value` into the parts of a split identifier, each its part in turn as a person
 * types them (`typeValue`), with a frame between parts for the page's handlers, as a page
 * that moves the focus to the next box. `between` runs after every wait, and `stillPart`
 * for the next part before it is typed: a stop leaves the parts typed so far in their
 * inputs. `beforeInput` runs before the last part's last `input` event.
 */
export async function typeSplit<Cause extends string>(
  parts: readonly HTMLInputElement[],
  value: string,
  setter: (this: HTMLInputElement, value: string) => void,
  options: {
    beforeInput?: (() => void) | undefined;
    between: () => Cause | undefined;
  },
  stillPart: (input: HTMLInputElement) => boolean,
): Promise<Cause | "field-changed" | "refused" | undefined> {
  const typed = pairs(parts, value);
  if (!typed) return "refused";
  for (const [at, [input, part]] of typed.entries()) {
    if (at > 0) {
      // eslint-disable-next-line no-await-in-loop
      await nextFrame();
      const stopped = options.between();
      if (stopped) return stopped;
    }
    if (!stillPart(input)) return "field-changed";
    // eslint-disable-next-line no-await-in-loop
    const stopped = await typeValue(input, part, setter, {
      beforeInput: at === typed.length - 1 ? options.beforeInput : undefined,
      between: () => options.between() ?? (stillPart(input) ? undefined : "field-changed"),
    });
    if (stopped) return stopped;
  }
  return undefined;
}
