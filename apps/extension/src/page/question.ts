import { QUESTION_MIN_LENGTH, questionText } from "@pateat/contracts";
import { renderedText } from "./text";

// The secret question a page asks beside an answer input (ADR 0061), matched against the
// names of the login item's custom fields, which people name after their questions, and
// against the questions the owner confirmed for fields named otherwise. Page text never
// leaves the content script: the worker sends the names, the document answers which one
// its question is.

export { questionText };

/** The most text read around an input when looking for its question. */
const QUESTION_TEXT_LIMIT = 4000;

/**
 * The part of the page that asks for `input`: its nearest ancestor that holds no other
 * input Pateat could fill, stopping at its form, so a question beside another answer
 * input never counts for this one.
 */
function questionRegion(input: HTMLInputElement): Element {
  let region: Element = input;
  for (let parent = input.parentElement; parent; parent = parent.parentElement) {
    const others = [...parent.querySelectorAll("input, textarea")].some(
      (other) =>
        other !== input &&
        !(
          other instanceof HTMLInputElement &&
          ["hidden", "submit", "button", "image", "reset", "checkbox", "radio"].includes(other.type)
        ),
    );
    if (others) break;
    region = parent;
    if (parent instanceof HTMLFormElement) break;
  }
  return region;
}

/**
 * Which of `names` is the question shown for `input`. Each entry is a field's name or,
 * as alternatives, its name and the question stored for it; an entry counts by its
 * longest alternative of at least 4 characters whose text appears in the rendered text
 * of the input's region. The entry that counts longest wins; undefined when none
 * appears or two entries tie.
 */
export function askedQuestion(
  input: HTMLInputElement,
  names: readonly (string | readonly string[])[],
): number | undefined {
  const text = renderedText(questionRegion(input), QUESTION_TEXT_LIMIT);
  if (text === undefined) return undefined;
  const shown = questionText(text);
  let best: number | undefined;
  let bestLength = -1;
  let tie = false;
  names.forEach((entry, index) => {
    const length = Math.max(
      -1,
      ...(typeof entry === "string" ? [entry] : entry)
        .map(questionText)
        .filter((wanted) => wanted.length >= QUESTION_MIN_LENGTH && shown.includes(wanted))
        .map((wanted) => wanted.length),
    );
    if (length < 0) return;
    if (length > bestLength) {
      best = index;
      bestLength = length;
      tie = false;
    } else if (length === bestLength) tie = true;
  });
  return tie ? undefined : best;
}
