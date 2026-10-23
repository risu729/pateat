import { regionText } from "./question";

// What a page shows about the card it asks for (ADR 0061, owner 2026-10-23 12:26 UTC): the
// last four digits of a masked card number and card brand names, read from the text beside
// a card detail's input and the page's title, so the popup can guess the vault's card item.
// Only these tokens leave the document, and only to the service worker; the page's text
// never does.

/** The card brands a page may name, as Bitwarden's `card.brand` values spell them. */
export const cardBrands = [
  "Visa",
  "Mastercard",
  "Amex",
  "Diners Club",
  "Discover",
  "JCB",
  "UnionPay",
] as const;
export type CardBrand = (typeof cardBrands)[number];

/** The most last-four runs a page's answer carries. */
export const MAX_CARD_LAST_4 = 10;

/** How a page names each brand, in its text after NFKC and without case. */
const brandWords: Readonly<Record<CardBrand, RegExp>> = {
  Visa: /(?<![a-z])visa(?![a-z])/u,
  Mastercard: /(?<![a-z])master ?card(?![a-z])|マスターカード/u,
  Amex: /(?<![a-z])(?:amex|american ?express)(?![a-z])|アメックス|アメリカン・?エキスプレス/u,
  "Diners Club": /(?<![a-z])diners(?![a-z])|ダイナース/u,
  Discover: /(?<![a-z])discover(?![a-z])/u,
  JCB: /(?<![a-z])jcb(?![a-z])/u,
  UnionPay: /(?<![a-z])union ?pay(?![a-z])|銀聯|银联/u,
};

/**
 * Four digits after a run of mask characters (`*`, `•`, `●`, `x`, and `＊`,
 * which NFKC makes `*`), groups of them apart by spaces or hyphens: `****1234`,
 * `•••• 1234`, `XXXX-XXXX-XXXX-1234`. A run starting with `x` must not
 * follow a letter or digit, so `box 1234` is none.
 */
const maskedDigits = /(?:(?<![a-z0-9])x|[*•●])((?:[\s-]*[*•●x])*)[\s-]*(\d{4})(?!\d)/gu;
/** Four digits after words that say they end the card number: 末尾 1234, ending in 1234. */
const endingDigits =
  /(?:末尾|下4桁|下四桁|ending (?:in|with)|ends (?:in|with)|last (?:4|four)(?: digits)?)[\s:#-]*(?:(?:は|が|is)[\s:#-]*)?(?:[*•●x][\s-]*)*(?<!\d)(\d{4})(?!\d)/gu;

/**
 * The last-four runs and brands named in `text`: each four digits after a mask run (an
 * `x`-only run needs two `x`s) or after words such as 末尾, 下4桁 or "ending in", and each
 * brand named, in the order of {@link cardBrands}.
 */
export function cardHintsIn(text: string): { last4: string[]; brands: CardBrand[] } {
  const shown = text.normalize("NFKC").toLowerCase();
  const last4 = new Set<string>();
  for (const match of shown.matchAll(maskedDigits)) {
    // A lone `x` before digits reads as a word, not a mask.
    if (`${match[0][0]}${match[1]}`.replaceAll(/[\s-]/gu, "") === "x") continue;
    last4.add(match[2]!);
  }
  for (const match of shown.matchAll(endingDigits)) last4.add(match[1]!);
  return {
    last4: [...last4].slice(0, MAX_CARD_LAST_4),
    brands: cardBrands.filter((brand) => brandWords[brand].test(shown)),
  };
}

/**
 * What the page shows about the card `input` asks for: the hints in the rendered text of
 * the input's region (as for a secret question, at most 4,000 characters) and in `title`.
 */
export function cardHints(
  input: HTMLInputElement,
  title: string,
): { last4: string[]; brands: CardBrand[] } {
  return cardHintsIn(`${regionText(input) ?? ""}\n${title}`);
}

/** The brand a vault card item's `card.brand` value names, or undefined for another or none. */
export function cardBrandOf(value: string): CardBrand | undefined {
  const key = value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(/[^a-z]/gu, "");
  if (key === "americanexpress") return "Amex";
  if (key === "diners") return "Diners Club";
  return cardBrands.find((brand) => brand.toLowerCase().replaceAll(" ", "") === key);
}
