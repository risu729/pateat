// How a preparing fill puts a value into an input (architecture: background execution).
// A page that reads a field only on a key, on its blur or when focus moves on sees a value
// set with the native setter and only `input` and `change` events as never entered: on
// 2026-10-13 a bank page showed its required-field error under filled fields. The same
// page's React inputs kept their state empty when the whole value came in one
// `insertReplacementText` input, and took it when typed a character at a time, so the
// value is typed as a keyboard would type it.

/**
 * How long a preparing fill waits between its inputs, between the digits of a split code
 * and between the characters it types, so the page's handlers for one, their microtasks
 * and short timers, run before the next. Bitwarden's autofill waits 20 ms between
 * actions.
 */
export const FIELD_GAP_MS = 25;

const valueProperty = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

/** The key a keyboard reports for `character`, as far as a US layout names one. */
function keyOf(character: string): KeyboardEventInit {
  const upper = character.toUpperCase();
  const code = /^[a-z]$/iu.test(character)
    ? `Key${upper}`
    : /^\d$/u.test(character)
      ? `Digit${character}`
      : character === " "
        ? "Space"
        : "";
  const keyCode = code ? upper.charCodeAt(0) : 0;
  return {
    key: character,
    code,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
}

/**
 * Types `value` into `input` as a person would: focus (which blurs the field focused
 * before) without scrolling; a field that already holds text is cleared first, as by
 * selecting it all and deleting; then each character as a keyboard sends it, `keydown`,
 * `keypress`, `beforeinput`, the character appended through the native `setter` (so a
 * framework that tracks the value, such as React, sees a change) and an `input` event of
 * type `insertText`, then `keyup`; then `change` and blur. A page that cancels a
 * character's `keydown`, `keypress` or `beforeinput` keeps it out, as a browser does.
 * Between characters it waits {@link FIELD_GAP_MS} and calls `between`, which stops the
 * typing with its cause when the page is no longer the one to type into. `beforeInput`
 * runs once the last character is in, just before its `input` event. A page that moved
 * focus elsewhere meanwhile keeps it: `blur` only leaves the input when it still has
 * focus. Resolves to `between`'s cause when it stopped, else `undefined`.
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
): Promise<Cause | undefined> {
  const current = () => (valueProperty?.get ? valueProperty.get.call(input) : input.value);
  input.focus({ preventScroll: true });
  if (current() !== "") {
    const clear = { bubbles: true, composed: true, inputType: "deleteContentBackward" };
    if (input.dispatchEvent(new InputEvent("beforeinput", { ...clear, cancelable: true }))) {
      setter.call(input, "");
      input.dispatchEvent(new InputEvent("input", clear));
    }
  }
  const characters = [...value];
  for (const [index, character] of characters.entries()) {
    if (index > 0) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise<void>((resolve) => setTimeout(resolve, FIELD_GAP_MS));
      const cause = between?.();
      if (cause) return cause;
    }
    const last = index === characters.length - 1;
    const key = keyOf(character);
    const codePoint = character.codePointAt(0)!;
    const inserted =
      input.dispatchEvent(new KeyboardEvent("keydown", key)) &&
      input.dispatchEvent(
        new KeyboardEvent("keypress", {
          ...key,
          charCode: codePoint,
          keyCode: codePoint,
          which: codePoint,
        }),
      ) &&
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
      setter.call(input, current() + character);
      if (last) beforeInput?.();
      input.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          composed: true,
          inputType: "insertText",
          data: character,
        }),
      );
    } else if (last) beforeInput?.();
    input.dispatchEvent(new KeyboardEvent("keyup", key));
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));
  if (document.activeElement === input) input.blur();
  return undefined;
}
