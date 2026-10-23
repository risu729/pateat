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
/** Separates the region's text blocks; never part of a page's text. */
const BLOCK = "\u0000";
/** The longest label before a question, as in 「秘密の質問：」 or "Security question:". */
const PREFIX_LIMIT = 40;

/**
 * What an answer is filled under: a field's `name`, which the region's text must contain,
 * or a `question` the owner confirmed, which must be one whole question shown there.
 */
export type AskedQuestion = { readonly name: string } | { readonly question: string };

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
 * The rendered text of the part of the page that asks for `input` (`questionRegion`), at
 * most 4,000 characters, or undefined when it is not shown.
 */
export function regionText(input: HTMLInputElement): string | undefined {
  return renderedText(questionRegion(input), QUESTION_TEXT_LIMIT)?.slice(0, QUESTION_TEXT_LIMIT);
}

/**
 * The whole questions the region shows, in their compared form: each text block (a block
 * element's own run of text, as rendering lays it out), and the same block without a short
 * label before its first colon. A block that ends in a colon is a label, not a question,
 * and a part of a block is never one.
 */
function wholeQuestions(region: Element): Set<string> {
  const text = renderedText(region, QUESTION_TEXT_LIMIT, { separator: BLOCK }) ?? "";
  const questions = new Set<string>();
  for (const block of text.split(BLOCK)) {
    const shown = block.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
    if (!shown || shown.endsWith(":")) continue;
    questions.add(questionText(shown));
    const colon = shown.indexOf(":");
    if (colon > 0 && colon <= PREFIX_LIMIT) questions.add(questionText(shown.slice(colon + 1)));
  }
  return questions;
}

/**
 * Which of `asked` is the question shown for `input`. A `name` counts when the rendered
 * text of the input's region contains it; a `question` only when it is one of the
 * region's whole questions. Either needs at least 4 characters. The longest one that
 * counts wins; undefined when none does or two of that length do.
 */
export function askedQuestion(
  input: HTMLInputElement,
  asked: readonly AskedQuestion[],
): number | undefined {
  const region = questionRegion(input);
  const text = renderedText(region, QUESTION_TEXT_LIMIT);
  if (text === undefined) return undefined;
  const shown = questionText(text);
  let questions: Set<string> | undefined;
  let best: number | undefined;
  let bestLength = -1;
  let tie = false;
  asked.forEach((entry, index) => {
    const wanted = questionText("name" in entry ? entry.name : entry.question);
    if (wanted.length < QUESTION_MIN_LENGTH) return;
    if (
      "name" in entry
        ? !shown.includes(wanted)
        : !(questions ??= wholeQuestions(region)).has(wanted)
    )
      return;
    if (wanted.length > bestLength) {
      best = index;
      bestLength = wanted.length;
      tie = false;
    } else if (wanted.length === bestLength) tie = true;
  });
  return tie ? undefined : best;
}
