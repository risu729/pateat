import { SPLIT_PART_LENGTH, SPLIT_PARTS } from "@pateat/contracts";
import { formOf, inputsOf, queryAll } from "./shadow";
import { autocompleteTokens, visible } from "./targets";

/**
 * Identifiers split over several inputs (ADR 0089, owner 2026-11-21 19:00 UTC): one value,
 * such as a customer number `NNNN-NNNN-NNNNN`, typed in parts into consecutive inputs
 * named `<stem>1`, `<stem>2`... This is its own rule, apart from a `totp` handler's code
 * split into one input per digit (ADR 0027, `splitCodeInputs`) and a personal detail's
 * parts the judge names one by one (ADR 0061): the owner asked for split identifiers to be
 * told apart from split codes (2026-11-21 18:59 UTC). Only the typing code is shared.
 */

/** Input types whose order the rule reads: another such input between two breaks a group. */
const textLike = new Set(["text", "email", "tel", "number", "url", "password", "search"]);
/** Input types a group's part may have; `number` ignores `maxlength`, so it never counts. */
const partTypes = new Set(["text", "tel"]);

/** A part's name: its `name`, else its `id`, as a stem with a number after it. */
function numbered(input: HTMLInputElement): { stem: string; number: string } | undefined {
  const match = /^(.*?)(\d+)$/u.exec(input.name || input.id);
  return match && match[1] ? { stem: match[1], number: match[2]! } : undefined;
}

/**
 * Whether `input` may be a group's part: a shown, enabled, writable text or tel input
 * whose `maxlength` is 2 to 8 and that is not marked `one-time-code`. An input that takes
 * one character, as a code's digit box (ADR 0027), never is.
 */
function part(input: HTMLInputElement): boolean {
  return (
    partTypes.has(input.type) &&
    !autocompleteTokens(input).includes("one-time-code") &&
    input.maxLength >= SPLIT_PART_LENGTH.min &&
    input.maxLength <= SPLIT_PART_LENGTH.max &&
    visible(input) &&
    !input.matches(":disabled") &&
    !input.readOnly
  );
}

/** The shown text-like inputs of `form` (or outside every form, for `null`), in page order. */
function sequence(form: HTMLFormElement | null, document: Document): HTMLInputElement[] {
  return inputsOf(form, document).filter((input) => textLike.has(input.type) && visible(input));
}

/**
 * The group that starts at `inputs[at]`, or undefined: that input and the ones right after
 * it whose name (else id) has the same stem and the numbers 1, 2, 3... in order, 2 to 6
 * of them, each a part (`part`). A run of such names longer than six, or one with an
 * input that is no part, is no group.
 */
function groupAt(inputs: readonly HTMLInputElement[], at: number): HTMLInputElement[] | undefined {
  const first = inputs[at];
  const name = first && numbered(first);
  if (!name || name.number !== "1") return undefined;
  const group = [first];
  for (let next = at + 1; next < inputs.length; next += 1) {
    const other = numbered(inputs[next]!);
    if (other?.stem !== name.stem || other.number !== String(group.length + 1)) break;
    group.push(inputs[next]!);
  }
  return group.length >= SPLIT_PARTS.min && group.length <= SPLIT_PARTS.max && group.every(part)
    ? group
    : undefined;
}

/** The name (else id) the parts of `group` share, without their numbers. */
export const groupStem = (group: readonly HTMLInputElement[]): string =>
  (group[0] && numbered(group[0])?.stem) ?? "";

/** Every split identifier group the page shows (`groupAt`), in page order. */
export function splitGroups(document: Document): HTMLInputElement[][] {
  const forms = new Set(
    queryAll<HTMLInputElement>(document, "input")
      .filter((input) => partTypes.has(input.type))
      .map((input) => formOf(input)),
  );
  return [...forms].flatMap((form) => {
    const inputs = sequence(form, document);
    const groups: HTMLInputElement[][] = [];
    for (let at = 0; at < inputs.length; at += 1) {
      const group = groupAt(inputs, at);
      if (!group) continue;
      groups.push(group);
      at += group.length - 1;
    }
    return groups;
  });
}

/**
 * The group whose first part is `first`, found from it by the same rule as `splitGroups`,
 * as a login finds the other parts of a recipe field that names only the first one.
 */
export function splitGroupFrom(first: HTMLInputElement): HTMLInputElement[] | undefined {
  const inputs = sequence(formOf(first), first.ownerDocument);
  const at = inputs.indexOf(first);
  return at < 0 ? undefined : groupAt(inputs, at);
}
