// How a `detail` handler's fill sets a select (ADR 0061): only a split birth date's or card
// expiry date's year, month or day, and only by an option that says the wanted number. An
// option's visible text decides when it holds a number; its value counts only when the
// text holds none and every value of the select lies in the part's own range. A card
// expiry year also matches an option that writes it with the other number of digits (`31`
// for 2031, `2031` for 31); a birth year never does, so an era year such as 昭和55年 is
// never taken for 1955 or 1980. An option is never chosen by its position, which differs
// between sites and between a select's own years.

import type { DatePart } from "@pateat/contracts";
import { blurElement, focusElement, focusedElement } from "./focus";

const selectedIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");

/** The number a split date's part wants from a select, as the service worker made it. */
export type WantedOption = {
  /** The part's digits, as `1990`, `04`, `4` or `31`. */
  value: string;
  /** Which part of the date it is, which sets the range an option's value must lie in. */
  part?: DatePart | undefined;
  /** A card expiry year, which may be written with two or four digits. */
  shortYear?: true | undefined;
};

/**
 * The digits a select option's value or visible text says: the one run of ASCII digits it
 * holds after NFKC and trimming, as in `4`, `04`, `4月`, `31`, `2031` or `2031年`. A text with
 * no digits, such as a placeholder or a month's name, or with two runs, as `2031 (13)`,
 * says none.
 */
function optionDigits(text: string): string | undefined {
  const runs = text
    .normalize("NFKC")
    .trim()
    .match(/[0-9]+/gu);
  return runs?.length === 1 ? runs[0] : undefined;
}

/** The options a person could choose: enabled, shown, and not in a disabled group. */
function choosableOptions(select: HTMLSelectElement): HTMLOptionElement[] {
  return [...select.options].filter((option) => {
    const group = option.parentElement;
    return !(
      option.disabled ||
      option.hidden ||
      (group instanceof HTMLOptGroupElement && group.disabled)
    );
  });
}

/**
 * Whether the numbers a select's option values say lie in `wanted`'s part's own range: 1
 * to 12 for a month, 1 to 31 for a day, four digits for a year (or two for a card expiry
 * year), and never 0, so values that count from 0 or stand for something else are never
 * read as the part's number.
 */
function valuesInRange(options: readonly HTMLOptionElement[], wanted: WantedOption): boolean {
  if (wanted.part === undefined) return false;
  const numbers = options.flatMap((option) => {
    const digits = optionDigits(option.value);
    return digits === undefined ? [] : [digits];
  });
  return (
    numbers.length > 0 &&
    numbers.every((digits) => {
      const number = Number(digits);
      if (number === 0) return false;
      if (wanted.part === "month") return number <= 12;
      if (wanted.part === "day") return number <= 31;
      return digits.length === 4 || (wanted.shortYear === true && digits.length === 2);
    })
  );
}

/**
 * The one option of `select` that a person could choose for `wanted`: an enabled, shown
 * option whose visible text says the same number (`optionDigits`), or, for an option whose
 * text says none, whose value does while every value lies in the part's range
 * (`valuesInRange`). A card expiry year with no such option takes the option that writes
 * it with two digits for four or four for two (`20` and the two digits). Undefined when
 * no option or several do.
 */
export function optionFor(
  select: HTMLSelectElement,
  wanted: WantedOption,
): HTMLOptionElement | undefined {
  if (!/^[0-9]{1,4}$/u.test(wanted.value)) return undefined;
  const options = choosableOptions(select);
  const trusted = valuesInRange(options, wanted);
  const says = options.map((option) => ({
    option,
    digits: optionDigits(option.text) ?? (trusted ? optionDigits(option.value) : undefined),
  }));
  const matching = (fits: (digits: string) => boolean) =>
    says.flatMap(({ option, digits }) => (digits !== undefined && fits(digits) ? [option] : []));
  let found = matching((digits) => Number(digits) === Number(wanted.value));
  if (found.length === 0 && wanted.shortYear && wanted.part === "year")
    found =
      wanted.value.length === 4
        ? matching((digits) => digits.length === 2 && digits === wanted.value.slice(2))
        : matching((digits) => digits.length === 4 && digits === `20${wanted.value}`);
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Chooses `option` of `select` as a person would: focus without scrolling, the option's
 * place read again once the page's focus handlers ran and selected through the native
 * setter, then `input` and `change` events that bubble, and blur. A select that already
 * shows the option is left as it is. Returns whether the select still shows that option
 * once the page's handlers ran, so a page that changed it back, or moved or removed the
 * option, keeps the fill from going on.
 */
export function chooseOption(select: HTMLSelectElement, option: HTMLOptionElement): boolean {
  if (select.selectedOptions[0] === option) return true;
  focusElement(select);
  const index = [...select.options].indexOf(option);
  if (index < 0) return false;
  if (selectedIndex?.set) selectedIndex.set.call(select, index);
  else select.selectedIndex = index;
  select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  if (focusedElement() === select) blurElement(select);
  return select.selectedOptions[0] === option;
}
