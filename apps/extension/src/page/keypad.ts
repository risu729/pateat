// Software keyboards (ADR 0067). Some bank and card pages keep a password or PIN
// input read-only and take its characters only from buttons the page draws, often in a
// shuffled order: SMBC Direct's optional keyboard is `<input type="button" value="Ｆ">`
// keys whose letters start at another place and whose digits change order on every load,
// and MUFG's is `<a href="#">A</a>` links in a list (both seen on 2026-10-23). A recipe
// names only the keypad's container; which key types which character is read here, on
// the page, from what each key shows, so neither the service nor the AI ever sees the
// value or which keys it takes.

import type { LoginKeypadTarget } from "@pateat/contracts";
import { findTargets } from "./targets";
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
/** A keypad without every digit has at least as many letters as the Latin alphabet. */
export const KEYPAD_MIN_LETTERS = 26;

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
 * Where controls serve something else than typing: navigation, as pagination or an
 * `A`-`Z` index bar; a grid, as a date picker's days; a tab or menu bar.
 */
const elsewhere = 'nav, [role="navigation"], [role="grid"], [role="tablist"], [role="menubar"]';

/**
 * Whether `link` jumps to an element of its own page, as an `A`-`Z` index bar's `#A` that
 * scrolls to the entries under A. A keypad's links go nowhere (`href="#"`).
 */
function jumpLink(link: HTMLAnchorElement): boolean {
  if (!isFragmentButton(link)) return false;
  const fragment = link.hash.slice(1);
  if (!fragment) return false;
  let name = fragment;
  try {
    name = decodeURIComponent(fragment);
  } catch {
    // A malformed escape is looked up as written.
  }
  const document = link.ownerDocument;
  return document.getElementById(name) !== null || document.getElementsByName(name).length > 0;
}

/**
 * Whether a single-character control is drawn for something else than typing: inside
 * navigation or a grid (`elsewhere`), a jump to its own page (`jumpLink`), the current
 * item of a list (`aria-current`, as pagination's current page), or a next or previous
 * link (`rel`).
 */
function otherControl(control: HTMLElement): boolean {
  if (control.closest(elsewhere) !== null || control.hasAttribute("aria-current")) return true;
  if (!(control instanceof HTMLAnchorElement)) return false;
  return (
    jumpLink(control) ||
    (control.getAttribute("rel") ?? "")
      .toLowerCase()
      .split(/\s+/u)
      .some((token) => token === "next" || token === "prev")
  );
}

/** A label that is a whole number from 10 on, as a date picker's days or a page number. */
const largeNumber = (text: string) => /^\d{2,}$/u.test(text) && Number(text) >= 10;

/**
 * Whether `container`, with `around` the box it sits in, shows what a date picker or
 * pagination shows, which no keypad does: it sits in navigation or a grid (`elsewhere`),
 * its box holds one, the current item of a list, a next or previous link or a
 * `<time datetime>`, or it holds a control or table cell whose label is a number from 10
 * on (`largeNumber`), as a calendar's days 10 to 31 or page 12.
 */
function datesOrPages(container: Element, around: Element): boolean {
  if (container.closest(elsewhere) !== null) return true;
  if (
    around.querySelector(
      `${elsewhere}, [aria-current], a[rel~="next" i], a[rel~="prev" i], time[datetime]`,
    )
  )
    return true;
  return [...container.querySelectorAll(`${keySelector}, td, th`)].some((element) =>
    largeNumber(
      widthFolded(
        collapseText(
          element instanceof HTMLInputElement ? element.value : (element.textContent ?? ""),
        ),
      ),
    ),
  );
}

/**
 * The page's keypad, for the observation: the nearest element that holds every key of the
 * document, when there are at least {@link KEYPAD_MIN_KEYS}, they include a key for each
 * of the ten digits or at least {@link KEYPAD_MIN_LETTERS} letters (a letters-only
 * keyboard, owner's choice, 2026-10-23 13:01 UTC), and that element is neither the body
 * nor the root. Controls drawn for something else (`otherControl`), as an `A`-`Z` index
 * bar's jump links or pagination, are not keys, and an element that shows what a date
 * picker or pagination shows (`datesOrPages`), or whose box (its parent below the body)
 * holds such a control, is no keypad. These
 * guards read the page's structure, never a site (ADR 0033). A single-character control
 * elsewhere on the page, such as a "?" help button, makes the page have no keypad, which
 * leaves it to the person as before.
 */
export function findKeypad(document: Document): Element | undefined {
  const all = keypadKeys(document);
  const keys = all.filter((key) => !otherControl(key));
  if (keys.length < KEYPAD_MIN_KEYS) return undefined;
  const labels = new Set(keys.map(keyLabel));
  const letters = [...labels].filter((label) => label !== undefined && /\p{L}/u.test(label));
  if (!keypadDigits.every((digit) => labels.has(digit)) && letters.length < KEYPAD_MIN_LETTERS)
    return undefined;
  let container = keys[0]!.parentElement;
  while (container && !keys.every((key) => container!.contains(key)))
    container = container.parentElement;
  if (!container || container === document.body || container === document.documentElement)
    return undefined;
  const parent = container.parentElement;
  const around =
    parent && parent !== document.body && parent !== document.documentElement ? parent : container;
  if (
    datesOrPages(container, around) ||
    all.some((key) => otherControl(key) && around.contains(key))
  )
    return undefined;
  return container;
}

/**
 * The element at `position` (`<up>:<path>`, ADR 0067) from `field`: that many parents up,
 * then the child element at each index of the path.
 */
function atPosition(field: Element, position: string): Element | undefined {
  const [up, path] = position.split(":");
  let node: Element | null = field;
  for (let level = Number(up); node && level > 0; level--) node = node.parentElement;
  for (const index of (path ?? "").split(".")) node = node?.children[Number(index)] ?? null;
  return node ?? undefined;
}

/**
 * The position of `container` from `field` (`atPosition`), from their nearest common
 * ancestor below the body, or `undefined` when it is deeper or wider than a locator holds.
 */
export function keypadPosition(field: Element, container: Element): string | undefined {
  const { body } = field.ownerDocument;
  let common: Element | null = field.parentElement;
  let up = 1;
  while (common && common !== body && !common.contains(container)) {
    common = common.parentElement;
    up++;
  }
  if (!common || common === body || common === container || up > 20) return undefined;
  const path: number[] = [];
  for (let node: Element = container; node !== common; node = node.parentElement!)
    path.unshift([...node.parentElement!.children].indexOf(node));
  if (path.length > 12 || path.some((index) => index > 99)) return undefined;
  const position = `${up}:${path.join(".")}`;
  return atPosition(field, position) === container ? position : undefined;
}

/**
 * The elements a keypad locator names (ADR 0067), hidden or not; a position counts from
 * `field`. A class or a position names its element only while that element alone matches
 * and holds the page's keypad (`findKeypad`), so a class another element took on, or a
 * place another element moved into, names nothing.
 */
export function findKeypadTargets(
  document: Document,
  target: LoginKeypadTarget,
  field: Element | undefined,
): Element[] {
  if (target.by === "class" || target.by === "position") {
    const found =
      target.by === "class"
        ? [...document.getElementsByClassName(target.value)]
        : [field && atPosition(field, target.value)].filter((node) => node !== undefined);
    if (found.length !== 1) return found;
    const page = findKeypad(document);
    return page && found[0]!.contains(page) ? found : [];
  }
  return findTargets(document, target, { hidden: true });
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
