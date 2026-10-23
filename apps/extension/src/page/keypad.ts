// Software keyboards (ADR 0067). Some bank and card pages keep a password or PIN
// input read-only and take its characters only from buttons the page draws, often in a
// shuffled order: SMBC Direct's optional keyboard is `<input type="button" value="Ｆ">`
// keys whose letters start at another place and whose digits change order on every load,
// and MUFG's is `<a href="#">A</a>` links in a list (both seen on 2026-10-23). A recipe
// names only the keypad's container; which key types which character is read here, on
// the page, from what each key shows, so neither the service nor the AI ever sees the
// value or which keys it takes.

import type { LoginKeypadTarget } from "@pateat/contracts";
import { autocompleteTokens, findTargets } from "./targets";
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

/**
 * The keys in `root` that type, apart from controls drawn for something else
 * (`otherControl`), as pagination's page numbers.
 */
const typingKeys = (root: ParentNode) => keypadKeys(root).filter((key) => !otherControl(key));

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
  return typingKeys(container).filter((key) => keyLabel(key) === character && pressable(key));
}

/**
 * Whether the keypad in `container` is open: it shows enough keys a person can press now
 * for a keypad (`enoughKeys`), so a shown "?" help button beside hidden keys is no open
 * keypad.
 */
export function keypadOpen(container: Element): boolean {
  return enoughKeys(typingKeys(container).filter(pressable));
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
 * `<time datetime>`, or it holds a control or table cell whose own label is a number from
 * 10 on (`largeNumber`), as a calendar's days 10 to 31 or page 12. Only a leaf's label
 * counts: a control with no control inside, or a cell with no element inside, so a group
 * of keys `1`, `2` and `3` never reads as 123.
 */
function datesOrPages(container: Element, around: Element): boolean {
  if (container.closest(elsewhere) !== null) return true;
  if (
    around.querySelector(
      `${elsewhere}, [aria-current], a[rel~="next" i], a[rel~="prev" i], time[datetime]`,
    )
  )
    return true;
  return [...container.querySelectorAll(`${keySelector}, td, th`)].some(
    (element) =>
      (element instanceof HTMLInputElement ||
        (element.matches(keySelector)
          ? element.querySelector(keySelector) === null
          : element.childElementCount === 0)) &&
      largeNumber(
        widthFolded(
          collapseText(
            element instanceof HTMLInputElement ? element.value : (element.textContent ?? ""),
          ),
        ),
      ),
  );
}

/** Whether `keys` are enough for a keypad: ten or more, with every digit or 26 letters. */
function enoughKeys(keys: readonly HTMLElement[]): boolean {
  if (keys.length < KEYPAD_MIN_KEYS) return false;
  const labels = new Set(keys.map(keyLabel));
  const letters = [...labels].filter((label) => label !== undefined && /\p{L}/u.test(label));
  return keypadDigits.every((digit) => labels.has(digit)) || letters.length >= KEYPAD_MIN_LETTERS;
}

/**
 * Of `keys`, those in the nearest box around `field` below the body that holds enough of
 * them for a keypad (`enoughKeys`), as the field's form or its login box; none when no box
 * does. A single-character control outside that box, such as a text-size switch's 小, 中
 * and 大, is no key of the field's keypad.
 */
function keysAround(field: Element, keys: readonly HTMLElement[]): HTMLElement[] {
  const { body, documentElement } = field.ownerDocument;
  for (
    let box = field.parentElement;
    box && box !== body && box !== documentElement;
    box = box.parentElement
  ) {
    const inside = keys.filter((key) => box.contains(key));
    if (enoughKeys(inside)) return inside;
  }
  return [];
}

/**
 * The smallest groups of `keys` that are enough for a keypad (`enoughKeys`): for each key,
 * the nearest element above it, below the body, whose keys are enough, kept when it holds
 * no other such element. Groups never nest; a key in none, as a "?" help button beside the
 * keys, is no key of any keypad.
 */
function keyGroups(keys: readonly HTMLElement[]): HTMLElement[][] {
  if (keys.length === 0) return [];
  const { body, documentElement } = keys[0]!.ownerDocument;
  const enough = new Map<Element, boolean>();
  const boxes = new Set<Element>();
  for (const key of keys)
    for (
      let box = key.parentElement;
      box && box !== body && box !== documentElement;
      box = box.parentElement
    ) {
      const holds = enough.getOrInsertComputed(box, (inside) =>
        enoughKeys(keys.filter((other) => inside.contains(other))),
      );
      if (holds) {
        boxes.add(box);
        break;
      }
    }
  return [...boxes]
    .filter((box) => ![...boxes].some((other) => other !== box && box.contains(other)))
    .map((box) => keys.filter((key) => box.contains(key)));
}

/**
 * The keypad that holds `keys`, the nearest element that holds them all, unless it is the
 * body or the root, or it or its box (its parent below the body) shows what a date picker
 * or pagination shows (`datesOrPages`) or holds a control drawn for something else
 * (`otherControl`) among `all`, the document's one-character controls.
 */
function keypadOf(keys: readonly HTMLElement[], all: readonly HTMLElement[]): Element | undefined {
  if (!enoughKeys(keys)) return undefined;
  const { body, documentElement } = keys[0]!.ownerDocument;
  let container = keys[0]!.parentElement;
  while (container && !keys.every((key) => container!.contains(key)))
    container = container.parentElement;
  if (!container || container === body || container === documentElement) return undefined;
  const parent = container.parentElement;
  const around = parent && parent !== body && parent !== documentElement ? parent : container;
  if (
    datesOrPages(container, around) ||
    all.some((key) => otherControl(key) && around.contains(key))
  )
    return undefined;
  return container;
}

/**
 * The page's keypad for `field`, or, without `field`, the document's one keypad: the
 * nearest element that holds the keys of the smallest groups of one-character controls
 * (`keyGroups`) that have at least {@link KEYPAD_MIN_KEYS}, with a key for each of the ten
 * digits or at least {@link KEYPAD_MIN_LETTERS} letters (a letters-only keyboard, owner's
 * choice, 2026-10-23 13:01 UTC), when that element is neither the body nor the root. With
 * `field`, only the keys in the nearest box around it that holds enough count
 * (`keysAround`), and a keypad split into a group of digits and one of letters is one
 * keypad; without, the document's groups must make exactly one keypad (`findKeypads`).
 * A one-character control outside every group, such as a "?" help button in the form, is
 * no key. Controls drawn for something else (`otherControl`), as an `A`-`Z` index bar's
 * jump links or pagination, are not keys, and an element that shows what a date picker or
 * pagination shows (`datesOrPages`), or whose box holds such a control, is no keypad.
 * These guards read the page's structure, never a site (ADR 0033). A keypad that switches
 * between letters and digits, whose other half is not on the page, is not supported: it
 * is no keypad, or its missing half has no keys (`key-missing`).
 */
export function findKeypad(
  document: Document,
  field?: Element,
  all: readonly HTMLElement[] = keypadKeys(document),
): Element | undefined {
  if (!field) {
    const found = findKeypads(document, all);
    return found.length === 1 ? found[0] : undefined;
  }
  const typing = all.filter((key) => !otherControl(key));
  const groups = keyGroups(keysAround(field, typing));
  return keypadOf(groups.length > 1 ? fieldGroup(field, groups) : (groups[0] ?? []), all);
}

/** The inputs a person types in, other than buttons, checkboxes and radios. */
const entryInputs =
  "input:not([type='hidden' i], [type='button' i], [type='submit' i], [type='reset' i], [type='image' i], [type='checkbox' i], [type='radio' i]), textarea";

/**
 * Of several groups of keys around `field`, those of its keypad: all of them when the
 * nearest element that holds them holds no input, as a keypad drawn as a group of digits
 * and one of letters, else the nearest group after the field with no input between, or
 * the nearest before it, as when each of two fields has its own keypad in one form; none
 * when no group is the field's alone.
 */
function fieldGroup(field: Element, groups: readonly HTMLElement[][]): HTMLElement[] {
  const keys = groups.flat();
  let common = keys[0]!.parentElement;
  while (common && !keys.every((key) => common!.contains(key))) common = common.parentElement;
  if (common && !common.querySelector(entryInputs)) return keys;
  const inputs = [...field.ownerDocument.querySelectorAll(entryInputs)];
  const at = inputs.indexOf(field);
  const between = (from: Node, to: Node) =>
    inputs.some(
      (input) =>
        input !== field &&
        from.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING &&
        input.compareDocumentPosition(to) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
  if (at < 0) return [];
  const after = groups.find(
    (group) =>
      field.compareDocumentPosition(group[0]!) & Node.DOCUMENT_POSITION_FOLLOWING &&
      !between(field, group[0]!),
  );
  if (after) return after;
  const before = groups.findLast(
    (group) =>
      group.at(-1)!.compareDocumentPosition(field) & Node.DOCUMENT_POSITION_FOLLOWING &&
      !between(group.at(-1)!, field),
  );
  return before ?? [];
}

/**
 * Every keypad of the document, one for each smallest group of keys (`keyGroups`), so a
 * page with a keypad for each of two fields has two. The observation leaves all their keys
 * and key labels out (ADR 0067). `all` is the document's `keypadKeys`, read once by a
 * caller that looks for several keypads.
 */
export function findKeypads(
  document: Document,
  all: readonly HTMLElement[] = keypadKeys(document),
): Element[] {
  return keyGroups(all.filter((key) => !otherControl(key)))
    .map((keys) => keypadOf(keys, all))
    .filter((container) => container !== undefined);
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
 * The keypad a locator names for `field` (ADR 0067): the page's keypad for the field
 * (`findKeypad`), when the locator names exactly one element, hidden or not, and that
 * element holds the keypad. A position counts from `field`. The keys are read from the
 * keypad alone, never from the rest of the element the locator names, as a wrapper that
 * also holds pagination; so an `id`, a class another element took on or a place another
 * element moved into names no keypad unless it holds the page's one.
 */
export function locateKeypad(
  document: Document,
  target: LoginKeypadTarget,
  field: Element,
): Element | undefined {
  const found =
    target.by === "class"
      ? [...document.getElementsByClassName(target.value)]
      : target.by === "position"
        ? [atPosition(field, target.value)].filter((node) => node !== undefined)
        : findTargets(document, target, { hidden: true });
  if (found.length !== 1) return undefined;
  const keypad = findKeypad(document, field);
  return keypad && found[0]!.contains(keypad) ? keypad : undefined;
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
 * Whether `field` may take a keypad's characters: an enabled, empty read-only password
 * input, or one marked for a current password or a one-time code. A read-only field
 * that holds a value, as an email address shown again or a picked date, or another
 * text input, as a search box beside an `A`-`Z` filter bar, is not.
 */
export function keypadInput(field: HTMLInputElement): boolean {
  const tokens = autocompleteTokens(field);
  return (
    field.readOnly &&
    !field.disabled &&
    field.value === "" &&
    (field.type === "password" ||
      tokens.includes("current-password") ||
      tokens.includes("one-time-code"))
  );
}

/**
 * Whether `field` is entered on the page's keypad in `container` (`findKeypad`): a
 * `keypadInput` beside it (`besideKeypad`). Whether it shows is the caller's check.
 */
export function keypadField(field: HTMLInputElement, container: Element | undefined): boolean {
  return container !== undefined && keypadInput(field) && besideKeypad(container, field);
}
