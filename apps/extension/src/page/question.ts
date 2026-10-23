import { renderedText } from "./text";

// The secret question a page asks beside an answer input (ADR 0061), matched against the
// names of the login item's custom fields, which people name after their questions. Page
// text never leaves the content script: the worker sends the names, the document answers
// which one its question is.

/** The most text read around an input when looking for its question. */
const QUESTION_TEXT_LIMIT = 4000;
/** The shortest custom field name that may stand for a question. */
const QUESTION_MIN_LENGTH = 4;

/**
 * A question or a field name as both are compared: NFKC, without case, with curly
 * apostrophes made straight, white space collapsed, and a trailing `?`, `:` or their
 * full-width forms removed (NFKC already folds those).
 */
export function questionText(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[‘’]/gu, "'")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .replace(/[?:]+$/u, "")
    .trim();
}

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
 * Which of `names` is the question shown for `input`: the longest whose text appears in
 * the rendered text of the input's region, or undefined when none does or two of that
 * length do.
 */
export function askedQuestion(
  input: HTMLInputElement,
  names: readonly string[],
): number | undefined {
  const text = renderedText(questionRegion(input), QUESTION_TEXT_LIMIT);
  if (text === undefined) return undefined;
  const shown = questionText(text);
  let best: number | undefined;
  let tie = false;
  names.forEach((name, index) => {
    const wanted = questionText(name);
    if (wanted.length < QUESTION_MIN_LENGTH || !shown.includes(wanted)) return;
    const length = best === undefined ? -1 : questionText(names[best]!).length;
    if (wanted.length > length) {
      best = index;
      tie = false;
    } else if (wanted.length === length) tie = true;
  });
  return tie ? undefined : best;
}
