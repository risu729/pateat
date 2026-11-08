// How a preparing fill puts a value into an input (architecture: background execution).
// A page that reads a field only on a key, on its blur or when focus moves on sees a value
// set with the native setter and only `input` and `change` events as never entered: on
// 2026-10-13 a bank page showed its required-field error under filled fields. The same
// page's React inputs kept their state empty when the whole value came in one
// `insertReplacementText` input, and took it when typed a character at a time, so the
// value is typed as a keyboard would type it. Its characters are one task apart, as fast
// as the page's handlers allow (owner decision, 2026-10-13).

import { blurElement, focusElement, focusedElement } from "./focus";
import { nextTask } from "./frames";
import { widthFolded } from "./text";

const valueProperty = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

/** Characters typed with Shift on a US layout. */
const shifted = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/u;

/**
 * The physical key and Chrome's `keyCode` of each digit and symbol on a US layout, unshifted and
 * shifted: `@` is Shift and the 2 key (`Digit2`, 50), `;` and `:` are `Semicolon` (186).
 */
const symbolKeys: ReadonlyMap<string, readonly [code: string, keyCode: number]> = new Map(
  (
    [
      ["`~", "Backquote", 192],
      ["-_", "Minus", 189],
      ["=+", "Equal", 187],
      ["[{", "BracketLeft", 219],
      ["]}", "BracketRight", 221],
      ["\\|", "Backslash", 220],
      [";:", "Semicolon", 186],
      ["'\"", "Quote", 222],
      [",<", "Comma", 188],
      [".>", "Period", 190],
      ["/?", "Slash", 191],
      ["1!", "Digit1", 49],
      ["2@", "Digit2", 50],
      ["3#", "Digit3", 51],
      ["4$", "Digit4", 52],
      ["5%", "Digit5", 53],
      ["6^", "Digit6", 54],
      ["7&", "Digit7", 55],
      ["8*", "Digit8", 56],
      ["9(", "Digit9", 57],
      ["0)", "Digit0", 48],
    ] as const
  ).flatMap(([pair, code, keyCode]) =>
    [...pair].map((character) => [character, [code, keyCode]] as const),
  ),
);

/** The key a keyboard reports for `character`, as far as a US layout names one. */
function keyOf(character: string): KeyboardEventInit {
  const upper = character.toUpperCase();
  const [code, keyCode] = /^[A-Za-z]$/u.test(character)
    ? [`Key${upper}`, upper.charCodeAt(0)]
    : character === " "
      ? ["Space", 32]
      : (symbolKeys.get(character) ?? ["", 0]);
  return {
    key: character,
    code,
    keyCode,
    which: keyCode,
    shiftKey: shifted.test(character),
    bubbles: true,
    cancelable: true,
    composed: true,
  };
}

/**
 * How long the typing waits after a value's characters on a shown page, so the page's
 * handlers for them, their microtasks and short timers run first: a masked field may write
 * a key it cancelled from a 10 ms timer. A set time still to be replaced (ADR 0082), once
 * a signal says the timers the page's handlers set have run. Bitwarden's autofill waits 20
 * ms between actions.
 */
const VALUE_GAP_MS = 25;

/**
 * Waits for the page after a value's characters: {@link VALUE_GAP_MS} on a shown page, or
 * one task on a hidden one.
 */
export function gap(): Promise<void> {
  if (!document.hidden) return new Promise((resolve) => setTimeout(resolve, VALUE_GAP_MS));
  return nextTask();
}

/**
 * Whether removing only ASCII spaces and hyphens inserted between two of `value`'s
 * characters from `held` leaves exactly `value`. Every original character, its own
 * separators included, must remain in order. A separator before the first or after the
 * last character groups nothing and could change the value, as a leading hyphen makes a
 * number negative. Compare the raw characters, whole code points, so width folding
 * cannot admit another inserted separator and none can split a surrogate pair.
 */
function withInsertedSeparators(held: string, value: string): boolean {
  const typed = [...value];
  // `matched[i]`: the held characters read so far can be the first `i` typed characters
  // with insertions. A held separator may be either typed or inserted, so all are tracked.
  let matched = typed.map((_, i) => i === 0).concat(typed.length === 0);
  for (const character of held) {
    const inserted = character === " " || character === "-";
    matched = matched.map(
      (_, i) =>
        (i > 0 && matched[i - 1] === true && typed[i - 1] === character) ||
        (inserted && i > 0 && i < typed.length && matched[i] === true),
    );
  }
  return matched[typed.length] === true;
}

/**
 * Characters a page writes in place of a typed one to hide it: the asterisks, including
 * the full-width and mathematical ones, the bullets and circles, and the middle dots,
 * including the Japanese and half-width katakana ones.
 */
const maskSymbols = new Set(["*", "＊", "∗", "•", "●", "○", "◦", "·", "∙", "・", "･"]);

/**
 * Whether `held` is `value` with characters at the same positions changed only in case,
 * between full-width and half-width (see {@link widthFolded}), or into a mask symbol (see
 * {@link maskSymbols}), as a page that hides or normalizes each character it is typed does
 * (owner decision, 2026-11-08 06:57 UTC, issue 1368). Any other substitution, such as
 * `1234` into `1235`, and any reordering, such as `1234` into `1243`, is a changed value.
 * Characters are compared as whole code points.
 */
function rewrittenInPlace(held: string, value: string): boolean {
  const kept = [...held];
  const typed = [...value];
  return (
    kept.length === typed.length &&
    kept.every((character, i) => {
      if (maskSymbols.has(character)) return true;
      // Lower case only: `ı` and `i` share the upper case `I` but are different letters.
      return widthFolded(character).toLowerCase() === widthFolded(typed[i]!).toLowerCase();
    })
  );
}

/**
 * Types `value` into `input` as a person would: focus (which blurs the field focused
 * before) without scrolling; a field that already holds text is cleared first, as by
 * selecting it all and deleting; then each character as a keyboard sends it, `keydown`,
 * `keypress` (none for a control character), `beforeinput`, the character appended
 * through the native `setter` (so a framework that tracks the value, such as React, sees
 * a change) and an `input` event of type `insertText`, then `keyup`; then `change` and
 * blur. Characters are one task apart. Key events carry Shift for the characters a US
 * layout types with it. A number input gets the characters typed so far rather than its
 * current value, which the browser empties while it is not yet a number, such as `1.`. A
 * page that cancels a character's `keydown`, `keypress` or `beforeinput` keeps it out,
 * as a browser does. After the last character the page gets a pause to write cancelled
 * characters itself; then the typing stops with `refused`, without `change` or blur, so
 * a value the page changed is never submitted, when the field does not hold `value`
 * after a cancelled event, or holds a value of another length, as when the page's own
 * handlers dropped a character it does not allow. A value of the same length is kept when
 * no key was cancelled and each character only changed case or width or became a mask
 * symbol, as a page that masks or upper-cases what is typed leaves it (see
 * {@link rewrittenInPlace}); another substitution or a reordering, such as `1234` into
 * `1235`, is refused. One the page rewrote between full-width and half-width characters
 * is kept whatever its length and after a cancelled key too (owner decision, 2026-10-18
 * 02:07 UTC; see {@link widthFolded}). A value changed only by inserting ASCII spaces
 * (U+0020) and hyphen-minus (U+002D) is kept too: removing only the inserted characters
 * must give exactly `value`, preserving its own separators and every original character
 * in order (owner decision, 2026-11-07 03:45 UTC; ADR 0010), when each sits between two of its characters and the input is not a number input.
 * These exceptions require the held value, including inserted separators, to fit the
 * field's `maxlength`. Other inserted characters get no exception. After `change` and
 * blur the page gets another pause and the same checks apply, unless the page emptied
 * the field, as a form that switches to other fields does; the caller's checks see to
 * that. A page that cancels the clearing `beforeinput` and does not clear the
 * field itself within such a pause refuses the value before any character is typed.
 * After each such wait, as between characters (see {@link gap} and {@link nextTask}), it
 * calls `between`, which stops the typing with its cause when the page is no longer the
 * one to type into. A stopped typing leaves the characters typed so far in the field.
 * `beforeInput` runs once the last character is in, just before its `input` event. A
 * page that moved focus elsewhere meanwhile keeps it: `blur` only leaves the input when
 * it still has focus. A field that already holds `value`, as a password field the page or
 * an earlier fill filled does behind its mask, is left as it is: no focus, no key and no
 * event, and `beforeInput` runs at once (owner decision, 2026-10-18). Resolves to the
 * cause when the typing stopped, else `undefined`.
 */
export async function typeValue<Cause extends string>(
  input: HTMLInputElement,
  value: string,
  setter: (this: HTMLInputElement, value: string) => void,
  {
    beforeInput,
    between,
  }: {
    beforeInput?: (() => void) | undefined;
    between?: (() => Cause | undefined) | undefined;
  } = {},
): Promise<Cause | "refused" | undefined> {
  const current = () => (valueProperty?.get ? valueProperty.get.call(input) : input.value);
  if (current() === value) {
    beforeInput?.();
    return undefined;
  }
  let refused = false;
  focusElement(input);
  if (current() !== "") {
    const clear = { bubbles: true, composed: true, inputType: "deleteContentBackward" };
    if (input.dispatchEvent(new InputEvent("beforeinput", { ...clear, cancelable: true }))) {
      setter.call(input, "");
      input.dispatchEvent(new InputEvent("input", clear));
    } else {
      // The page may clear the field itself, as a framework does once its handlers ran.
      await gap();
      const cause = between?.();
      if (cause) return cause;
      if (current() !== "") return "refused";
    }
  }
  const characters = [...value];
  let typed = "";
  for (const [index, character] of characters.entries()) {
    if (index > 0) {
      // eslint-disable-next-line no-await-in-loop
      await nextTask();
      const cause = between?.();
      if (cause) return cause;
    }
    const last = index === characters.length - 1;
    const key = keyOf(character);
    const codePoint = character.codePointAt(0)!;
    const control = codePoint < 0x20 || codePoint === 0x7f;
    const inserted =
      input.dispatchEvent(new KeyboardEvent("keydown", key)) &&
      (control ||
        input.dispatchEvent(
          new KeyboardEvent("keypress", {
            ...key,
            charCode: codePoint,
            keyCode: codePoint,
            which: codePoint,
          }),
        )) &&
      input.dispatchEvent(
        new InputEvent("beforeinput", {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: "insertText",
          data: character,
        }),
      );
    if (inserted) {
      typed += character;
      setter.call(input, input.type === "number" ? typed : current() + character);
      if (last) beforeInput?.();
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: character,
        }),
      );
    } else {
      refused = true;
      if (last) beforeInput?.();
    }
    input.dispatchEvent(new KeyboardEvent("keyup", key));
  }
  // A page that types a cancelled key itself, as a framework does, may write it only once
  // its handlers' microtasks and short timers ran, and one that strips a character it does
  // not allow from the field cancels nothing.
  await gap();
  const settled = (cancelledKey: boolean, cleared: boolean) => {
    const cause = between?.();
    if (cause) return cause;
    const held = current();
    // A rewrite that made the value longer than the field allows is one a person's typing
    // could not have left in it.
    if (input.type !== "number" && input.maxLength >= 0 && held.length > input.maxLength)
      return "refused";
    // A number input holds no grouping, so a hyphen there only changes the number, as
    // `1e5` to `1e-5`.
    return widthFolded(held) !== widthFolded(value) &&
      (input.type === "number" || !withInsertedSeparators(held, value)) &&
      (cancelledKey || !rewrittenInPlace(held, value)) &&
      !(cleared && held === "")
      ? "refused"
      : undefined;
  };
  const entered = settled(refused, false);
  if (entered) return entered;
  input.dispatchEvent(new Event("change", { bubbles: true }));
  if (focusedElement() === input) blurElement(input);
  // A page's change or blur handler may rewrite the value it holds, as a framework that
  // sets the state it last rendered does. One that empties the field, as a form switching
  // to another set of fields does, is left to the checks before the click.
  await gap();
  return settled(false, true);
}
