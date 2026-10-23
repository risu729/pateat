// Software keyboards (proposed ADR 0067). Some bank and card pages keep a password or PIN
// input read-only and take its characters only from buttons the page draws, often in a
// shuffled order: SMBC Direct's optional keyboard is `<input type="button" value="Ｆ">`
// keys whose letters start at another place and whose digits change order on every load,
// and MUFG's is `<a href="#">A</a>` links in a list (both seen on 2026-10-23). A recipe
// names only the keypad's container; which key types which character is read here, on
// the page, from what each key shows, so neither the service nor the AI ever sees the
// value or which keys it takes.

import {
  collapseText,
  isButton,
  isFragmentButton,
  isScriptButton,
  renderedText,
  shown,
  widthFolded,
} from "./text";

/** A keypad has at least as many keys as a PIN pad's digits. */
export const KEYPAD_MIN_KEYS = 10;

const keySelector = "button, input, a, [role], [onclick]";

/**
 * A control a person presses on a keypad: a button, a submit, button or image input, a
 * script button, a link to a fragment of its own page (`<a href="#">A</a>`), or another
 * element with an `onclick` attribute, as a table cell of an older keypad. Fields, selects
 * and text areas are never keys.
 */
function keyControl(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (element instanceof HTMLInputElement) return isButton(element);
  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) return false;
  return (
    isButton(element) ||
    isScriptButton(element) ||
    isFragmentButton(element) ||
    element.hasAttribute("onclick")
  );
}

/**
 * The one character a key types, as the page shows it: its visible text (an input
 * button's `value`, an image input's `alt`; a key not shown yet, as on a keypad that opens
 * on focus, by its text content), else its `aria-label`, else the `alt` of its one image
 * that has one, collapsed and with full-width forms folded (`widthFolded`), so `Ｆ` types
 * `F`. A key whose label is not exactly one character, such as "クリア" or an image without
 * `alt`, types nothing. Case is kept: `A` and `a` are other keys.
 */
export function keyLabel(element: Element): string | undefined {
  if (!keyControl(element)) return undefined;
  // Read apart, since `shown` narrows what it is called on.
  const isShown: boolean = shown(element);
  const raw =
    element instanceof HTMLInputElement
      ? element.type === "image"
        ? element.alt
        : element.value
      : isShown
        ? (renderedText(element, 16) ?? "")
        : (element.textContent ?? "").slice(0, 64);
  let text = collapseText(raw);
  if (!text) text = collapseText(element.getAttribute("aria-label") ?? "");
  if (!text && !(element instanceof HTMLInputElement)) {
    const alts = [...element.querySelectorAll("img[alt]")]
      .map((image) => collapseText(image.getAttribute("alt")!))
      .filter(Boolean);
    if (alts.length === 1) text = alts[0]!;
  }
  const folded = widthFolded(text);
  return [...folded].length === 1 ? folded : undefined;
}

/** Of nested keys, as a cell with an `onclick` around a key link, only the innermost. */
const innermost = (keys: readonly HTMLElement[]) =>
  keys.filter((key) => !keys.some((other) => other !== key && key.contains(other)));

/** Every key in `root`, shown or not, innermost first where keys nest. */
export function keypadKeys(root: ParentNode): HTMLElement[] {
  return innermost(
    [...root.querySelectorAll(keySelector)].filter(
      (element): element is HTMLElement => keyLabel(element) !== undefined,
    ),
  );
}

/** Whether a person can press `key` now: shown, enabled and not inert. */
export function pressable(key: HTMLElement): boolean {
  return (
    shown(key) &&
    !(key instanceof HTMLButtonElement && key.disabled) &&
    !(key instanceof HTMLInputElement && key.disabled) &&
    key.getAttribute("aria-disabled") !== "true" &&
    key.closest("[inert]") === null
  );
}

/**
 * The keys in `container` a person can press now that type `character`. Only key labels
 * are folded: a value's own full-width character, such as `Ａ` in a stored password, is
 * another character than the `A` a key types, so it has no key.
 */
export function keysFor(container: Element, character: string): HTMLElement[] {
  if (widthFolded(character) !== character) return [];
  return keypadKeys(container).filter((key) => keyLabel(key) === character && pressable(key));
}

/** Whether the keypad in `container` shows a key a person can press now. */
export function keypadOpen(container: Element): boolean {
  return keypadKeys(container).some(pressable);
}

/** Whether every character of `value` has exactly one key in `container` a person can press now. */
export function keypadCovers(container: Element, value: string): boolean {
  return [...value].every((character) => keysFor(container, character).length === 1);
}

const keypadDigits = [..."0123456789"];

/**
 * The page's keypad, for the observation: the nearest element that holds every key of the
 * document, when there are at least {@link KEYPAD_MIN_KEYS}, they include a key for each
 * of the ten digits, and that element is neither the body nor the root. Requiring every
 * digit leaves out a date picker (`1` to `31`), pagination and an `A`-`Z` index of links.
 * A single-character control elsewhere on the page, such as a "?" help button, makes the
 * page have no keypad, which leaves it to the person as before.
 */
export function findKeypad(document: Document): Element | undefined {
  const keys = keypadKeys(document);
  if (keys.length < KEYPAD_MIN_KEYS) return undefined;
  const labels = new Set(keys.map(keyLabel));
  if (!keypadDigits.every((digit) => labels.has(digit))) return undefined;
  let container = keys[0]!.parentElement;
  while (container && !keys.every((key) => container!.contains(key)))
    container = container.parentElement;
  return container && container !== document.body && container !== document.documentElement
    ? container
    : undefined;
}

/**
 * Whether the keypad in `container` belongs to `field`: the field's form holds it, or the
 * nearest element that holds both the field and the keypad is neither the body nor the
 * root, as a keypad drawn beside its form in one login box.
 */
export function besideKeypad(container: Element, field: HTMLInputElement): boolean {
  const { body, documentElement } = field.ownerDocument;
  let common: Element | null = field.form ?? field;
  while (common && !common.contains(container)) common = common.parentElement;
  return common !== null && common !== body && common !== documentElement;
}

/**
 * Whether `field` is entered on the page's keypad in `container` (`findKeypad`): an
 * enabled, empty read-only input beside it (`besideKeypad`). A read-only field that holds
 * a value, as an email address shown again or a picked date, is not; whether it shows is
 * the caller's check.
 */
export function keypadField(field: HTMLInputElement, container: Element | undefined): boolean {
  return (
    container !== undefined &&
    field.readOnly &&
    !field.disabled &&
    field.value === "" &&
    besideKeypad(container, field)
  );
}
