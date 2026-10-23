import { regionText } from "./question";

// What a page shows about the card it asks for (ADR 0061, owner 2026-10-23 12:26 UTC): the
// last four digits of a masked card number, read from the text beside a card detail's input
// and the page's title, and the card brand named beside the input, so the popup can guess
// the vault's card item. Only these tokens leave the document, and only to the service
// worker; the page's text never does.

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

/**
 * How a page names each brand, in its text after NFKC: without case, except "Discover",
 * which is also an everyday English word.
 */
const brandWords: Readonly<Record<CardBrand, RegExp>> = {
  Visa: /(?<![a-z])visa(?![a-z])/iu,
  Mastercard: /(?<![a-z])master ?card(?![a-z])|マスターカード/iu,
  Amex: /(?<![a-z])(?:amex|american ?express)(?![a-z])|アメックス|アメリカン・?エキスプレス/iu,
  "Diners Club": /(?<![a-z])diners(?![a-z])|ダイナース/iu,
  Discover: /(?<![A-Za-z])Discover(?![A-Za-z])/u,
  JCB: /(?<![a-z])jcb(?![a-z])/iu,
  UnionPay: /(?<![a-z])union ?pay(?![a-z])|銀聯|银联/iu,
};

/** The mask characters, after NFKC (which makes U+FF0A `*`) and without case. */
const MASK = "[*\u2022\u25cfx]";
/**
 * Four digits after a run of mask characters (U+002A, U+2022, U+25CF, `x` or `X`, and
 * U+FF0A), groups of them apart by spaces or hyphens: `****1234`, `XXXX-XXXX-XXXX-1234`.
 * A run starting with `x` follows no Latin letter or digit, so `box 1234` is none. Four
 * digits followed by `-` or `/` and a digit are part of a date or an order number.
 */
const maskedDigits = new RegExp(
  `(?:(?<![a-z0-9])x|[*\u2022\u25cf])((?:[\\s-]*${MASK})*)[\\s-]*(\\d{4})(?!\\d)(?![-/]\\d)`,
  "gu",
);
/** Four digits after words that say they end the card number: 末尾 1234, ending in 1234. */
const endingDigits = new RegExp(
  "(?:末尾|下4桁|下四桁|ending (?:in|with)|ends (?:in|with)|last (?:4|four)(?: digits)?)" +
    `[\\s:#-]*(?:(?:は|が|is)[\\s:#-]*)?(?:${MASK}[\\s-]*)*(?<!\\d)(\\d{4})(?!\\d)(?![-/]\\d)`,
  "gu",
);

/**
 * The last-four runs shown in `text`: each four digits after a run of two or more mask
 * characters or after words such as 末尾, 下4桁 or "ending in", once each, in the order
 * shown.
 */
export function cardLastFours(text: string): string[] {
  const shown = text.normalize("NFKC").toLowerCase();
  const last4 = new Set<string>();
  for (const match of shown.matchAll(maskedDigits)) {
    // A lone mask character before digits reads as a bullet, a footnote or a word.
    if (`${match[0][0]}${match[1]}`.replaceAll(/[\s-]/gu, "").length < 2) continue;
    last4.add(match[2]!);
  }
  for (const match of shown.matchAll(endingDigits)) last4.add(match[1]!);
  return [...last4].slice(0, MAX_CARD_LAST_4);
}

/**
 * The brand named in `text`, as one list; none when it names none or several, as a list
 * of the brands a site accepts does.
 */
export function cardBrandsIn(text: string): CardBrand[] {
  const shown = text.normalize("NFKC");
  const named = cardBrands.filter((brand) => brandWords[brand].test(shown));
  return named.length === 1 ? named : [];
}

/**
 * What the page shows about the card `input` asks for: the last four digits in the
 * rendered text of the input's region (as for a secret question, at most 4,000
 * characters) and in `title`, and the brand named in that region alone.
 */
export function cardHints(
  input: HTMLInputElement,
  title: string,
): { last4: string[]; brands: CardBrand[] } {
  const region = regionText(input) ?? "";
  return { last4: cardLastFours(`${region}\n${title}`), brands: cardBrandsIn(region) };
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
