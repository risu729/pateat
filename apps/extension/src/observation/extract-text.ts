import type { LoginObservation } from "@pateat/contracts";
import { closestAcross, composedParent, queryAll } from "../page/shadow";
import { collapseText, renderedText } from "../page/text";
import { landmarks } from "./extract-controls";

export const maxText = 120;

export const rawLimit = maxText * 4;

/** How much of a signed-in page's header and navigation the judge sees (ADR 0029). */
export const maxHeaderText = 1000;

/**
 * Text that can reveal an account or a number is replaced before it is observed
 * (owner decision, 2026-10-11): email-like strings, including masked ones, become
 * `[email]`; runs of three or more mask characters become `[masked]`; runs of four or
 * more digits, ASCII or fullwidth, become `[number]`.
 */
const redactions: readonly (readonly [RegExp, string])[] = [
  // Fullwidth letters, digits and punctuation count too: `ｔａｒｏ＠ｅｘａｍｐｌｅ．ｃｏｍ`. A
  // local part holds what HTML's valid email address allows, such as `'` and `#`
  // (`o'brien@`, `taro#1@`), except `/`, `=`, `?` and `&`, so `youtube.com/@pateat` and
  // `price=100@shop` stay. A domain's labels may be internationalized (`taro@例え.jp`).
  // An ASCII last label ends the address, so text right after it stays:
  // `taro@example.comでログイン` becomes `[email]でログイン`. A last label that is not ASCII
  // (`taro@例え.日本`, `taro@mail.例え.日本`) cannot be told apart from text glued to it,
  // so the address and that text go together.
  [
    /[A-Za-z0-9.!#$%'*+^_`{|}~\-●•＊Ａ-Ｚａ-ｚ０-９．＿％＋－]+[@＠](?:(?:[\p{L}\p{M}\p{N}\-*●•＊－]+[.．])*[A-Za-z0-9\-*●•＊Ａ-Ｚａ-ｚ０-９－]+(?![A-Za-z0-9\-*●•＊Ａ-Ｚａ-ｚ０-９－]|[.．][\p{L}\p{M}\p{N}\-*●•＊－])|(?:[\p{L}\p{M}\p{N}\-*●•＊－]+[.．])+[\p{L}\p{M}\p{N}\-－]+)/gu,
    "[email]",
  ],
  [/[*●•＊]{3,}/gu, "[masked]"],
  [/[0-9０-９]{4,}/gu, "[number]"],
];

/**
 * Normalizes untrusted page text to the observed-text contract: whitespace collapsed,
 * control/format/separator characters removed, private-looking parts redacted, and at
 * most `limit` (120) UTF-16 code units without splitting a surrogate pair.
 */
export function observedText(raw: string | null | undefined, limit = maxText): string | undefined {
  if (!raw) return undefined;
  // Format characters (zero-width spaces, soft hyphens) vanish before redaction so
  // they cannot split a digit run.
  let text = collapseText(raw);
  for (const [pattern, replacement] of redactions) text = text.replace(pattern, replacement);
  return bounded(text.replace(/\s+/gu, " ").trim(), limit);
}

/** At most `limit` (120) UTF-16 code units, without splitting a surrogate pair. */
export function bounded(text: string, limit = maxText): string | undefined {
  if (text.length > limit) {
    text = text.slice(0, limit);
    if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text || undefined;
}

/**
 * Observed text of a signed-in page with every number replaced by one `[number]`, whatever
 * its length or script, digit groups joined by `.`, `,` or `'` included, and a long run
 * the login-page rule already replaced (owner decision, 2026-10-12): such a page can show
 * balances and points in any form, and judging whether it is signed in needs none of
 * them. Numerals written as letters, such as most kanji, are not numbers to Unicode and stay.
 */
const numberPart = String.raw`(?:\p{Number}+|\[number\])`;

const numbers = new RegExp(`${numberPart}(?:[.,，．'\u2019]${numberPart})*`, "gu");

export const withoutNumbers = (text: string, limit = maxText) =>
  bounded(text.replace(numbers, "[number]"), limit) ?? "[number]";

/**
 * The visible text of a signed-in page's header and navigation for the judge (ADR 0029,
 * owner, 2026-10-12): every outermost `header`, `nav`, banner and navigation landmark in
 * document order, redacted as the rest of that page and cut at 1,000 characters. Every
 * element boundary separates words, as E2 reads them, so a name in its own element is
 * never glued to the word before it; the text is cut once, after every number is hidden,
 * so the end of a cut username stays the end of the text.
 */
export function headerText(document: Document): string | undefined {
  const readLimit = maxHeaderText * 4;
  let raw = "";
  for (const root of queryAll(document, landmarks)) {
    if (raw.length > readLimit) break;
    const parent = composedParent(root);
    if (parent && closestAcross(parent, landmarks)) continue;
    const text = renderedText(root, readLimit, { everyElement: true });
    if (text) raw += ` ${text}`;
  }
  const text = observedText(raw, Number.POSITIVE_INFINITY);
  return text && withoutNumbers(text, maxHeaderText);
}

/**
 * Observed text not yet cut at its 120-character limit: a candidate's label, placeholder
 * and description, the title and the headings are cut once `observe` has hidden what its
 * page hides, so that hiding every number on a signed-in page cannot shorten a cut text
 * and the end of a cut username stays the end of the text (`withoutUsernames`).
 */
export const uncutText = (raw: string | null | undefined) =>
  observedText(raw, Number.POSITIVE_INFINITY);

/** Rendered text, normalized and redacted, not yet cut; a little beyond the limit is read so redaction sees whole tokens. */
export const visibleText = (root: Element) => uncutText(renderedText(root, rawLimit));

/** A word's letters and numbers, lower-cased, so `Taro Y` and `taro_y` compare equal. */
export const foldWord = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]/gu, "");

/**
 * The folded words of a text, each two neighbouring words together (a display name such
 * as "Taro Y"), and the whole text folded, for `pathTarget`.
 */
export function shownWords(text: string | undefined): Set<string> {
  const words = new Set<string>();
  if (text === undefined) return words;
  // A word of punctuation alone, such as "·", does not part a name's two words.
  const split = text.split(/\s+/u).map(foldWord).filter(Boolean);
  for (const word of [
    foldWord(text),
    ...split,
    ...split.slice(1).map((next, at) => split[at] + next),
  ])
    if (word) words.add(word);
  return words;
}

export function language(texts: readonly string[]): LoginObservation["language"] {
  const joined = texts.join(" ").replace(/\[(?:email|masked|number)\]/gu, " ");
  const japanese = joined.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu);
  const latin = joined.match(/[A-Za-zＡ-Ｚａ-ｚ]/gu);
  const ja = japanese?.length ?? 0;
  const en = latin?.length ?? 0;
  const share = ja / Math.max(ja + en, 1);
  // A Japanese page often has "ID" labels and an English page a "日本語" switcher.
  return share >= 0.5 ? "ja" : share <= 0.1 ? "en" : "mixed";
}
