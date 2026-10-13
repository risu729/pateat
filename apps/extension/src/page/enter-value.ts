// How a preparing fill puts a value into an input (architecture: background execution).
// A page that reads a field only on a key, on its blur or when focus moves on sees a value
// set with the native setter and only `input` and `change` events as never entered: on
// 2026-10-13 a bank page showed its required-field error under filled fields. The
// sequence is modeled on Bitwarden's autofill, which also sends bare key events.

/**
 * How long a preparing fill waits between its inputs, and between the digits of a split
 * code, so the page's handlers for one field, their microtasks and short timers, run
 * before the next field is focused. Bitwarden's autofill waits 20 ms between actions.
 */
export const FIELD_GAP_MS = 25;

/**
 * Enters `value` into `input` as a person typing it in one go would leave it: focus (which
 * blurs the field focused before), a bare `keydown`, the value through the native
 * `setter` (so a framework that tracks the value, such as React, sees a change), an
 * `input` event of type `insertReplacementText`, a bare `keyup`, `change`, and blur. The
 * key events name no key, as Bitwarden's do, so a handler that acts on Enter or on one
 * key does not. `beforeInput` runs just before the `input` event, with the value in.
 * Focus does not scroll the page. A page that moved focus elsewhere meanwhile keeps it:
 * `blur` only leaves the input when it still has focus.
 */
export function enterValue(
  input: HTMLInputElement,
  value: string,
  setter: (this: HTMLInputElement, value: string) => void,
  beforeInput?: () => void,
): void {
  input.focus({ preventScroll: true });
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true }));
  setter.call(input, value);
  beforeInput?.();
  input.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      composed: true,
      inputType: "insertReplacementText",
      data: null,
    }),
  );
  input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();
}
