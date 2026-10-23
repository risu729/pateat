// How a `detail` handler's fill sets a select (ADR 0061): only a split birth date's or card
// expiry date's year, month or day, and only by an option that says the wanted number. An
// option is never chosen by its position, which differs between sites and between a
// select's own years.

import { blurElement, focusElement, focusedElement } from "./focus";

const selectedIndex = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "selectedIndex");

/**
 * The digits a select option's value or visible text says: the one run of ASCII digits it
 * holds after NFKC and trimming, as in `4`, `04`, `4月`, `31`, `2031` or `2031年`. A text with
 * no digits, such as a placeholder, or with two runs, as `2031 (13)`, says none.
 */
function optionDigits(text: string): string | undefined {
  const runs = text
    .normalize("NFKC")
    .trim()
    .match(/[0-9]+/gu);
  return runs?.length === 1 ? runs[0] : undefined;
}

/**
 * The index of the one option of `select` that a person could choose for `wanted`, a
 * date part's digits as the service worker made them (`1990`, `04`, `4`): an enabled,
 * shown option whose value or visible text says the same number (`optionDigits`). A
 * four-digit year with no such option takes the option that says only its last two
 * digits, as a card's expiry year `31` for `2031`. Undefined when no option or several
 * do, so a select whose values and texts disagree, as one whose values count from 0, is
 * never guessed at.
 */
export function optionFor(select: HTMLSelectElement, wanted: string): number | undefined {
  if (!/^[0-9]{1,4}$/u.test(wanted)) return undefined;
  const choosable = [...select.options].flatMap((option, index) => {
    const group = option.parentElement;
    return option.disabled ||
      option.hidden ||
      (group instanceof HTMLOptGroupElement && group.disabled)
      ? []
      : [{ index, says: [optionDigits(option.value), optionDigits(option.text)] }];
  });
  const matching = (fits: (digits: string) => boolean) =>
    choosable.flatMap(({ index, says }) =>
      says.some((digits) => digits !== undefined && fits(digits)) ? [index] : [],
    );
  const whole = matching((digits) => Number(digits) === Number(wanted));
  const found =
    whole.length === 0 && wanted.length === 4
      ? matching((digits) => digits.length === 2 && digits === wanted.slice(2))
      : whole;
  return found.length === 1 ? found[0] : undefined;
}

/**
 * Chooses option `index` of `select` as a person would: focus without scrolling, the
 * option selected through the native setter, then `input` and `change` events that bubble,
 * and blur. A select that already shows the option is left as it is. Returns whether the
 * select still shows the option once the page's handlers ran, so a page that changed it
 * back keeps the fill from going on.
 */
export function chooseOption(select: HTMLSelectElement, index: number): boolean {
  if (select.selectedIndex === index) return true;
  focusElement(select);
  if (selectedIndex?.set) selectedIndex.set.call(select, index);
  else select.selectedIndex = index;
  select.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  if (focusedElement() === select) blurElement(select);
  return select.selectedIndex === index;
}
