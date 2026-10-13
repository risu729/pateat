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

/** Characters typed with Shift on a US layout. */
const shifted = /^[A-Z~!@#$%^&*()_+{}|:"<>?]$/u;

/** The key a keyboard reports for `character`, as far as a US layout names one. */
function keyOf(character: string): KeyboardEventInit {
  const upper = character.toUpperCase();
  const code = /^[A-Za-z]$/u.test(character)
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
    shiftKey: shifted.test(character),
    bubbles: true,
    cancelable: true,
    composed: true,
  };
}

/**
 * Waits between two typed characters: {@link FIELD_GAP_MS} on a shown page, or one task
 * on a hidden one, whose timers Chrome throttles to a second or, after five minutes
 * hidden, to a minute, which would stretch a password across minutes.
 */
function gap(): Promise<void> {
  if (!document.hidden) return new Promise((resolve) => setTimeout(resolve, FIELD_GAP_MS));
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      resolve();
    };
    channel.port2.postMessage(undefined);
  });
}

/**
 * Types `value` into `input` as a person would: focus (which blurs the field focused
 * before) without scrolling; a field that already holds text is cleared first, as by
 * selecting it all and deleting; then each character as a keyboard sends it, `keydown`,
 * `keypress` (none for a control character), `beforeinput`, the character appended
 * through the native `setter` (so a framework that tracks the value, such as React, sees
 * a change) and an `input` event of type `insertText`, then `keyup`; then `change` and
 * blur. Key events carry Shift for the characters a US layout types with it. A number
 * input gets the characters typed so far rather than its current value, which the
 * browser empties while it is not yet a number, such as `1.`. A page that cancels a
 * character's `keydown`, `keypress` or `beforeinput` keeps it out, as a browser does; if
 * the field does not hold `value` once the page had a pause to write the characters
 * itself, the typing stops with `refused`, without `change` or blur, so a value the page
 * changed is never submitted. A page that cancels the clearing `beforeinput` and does not
 * clear the field itself within such a pause refuses the value before any character is
 * typed. Between characters it waits (see {@link gap}) and calls `between`, which
 * stops the typing with its cause when the page is no longer the one to type into. A
 * stopped typing leaves the characters typed so far in the field. `beforeInput` runs
 * once the last character is in, just before its `input` event. A page that moved focus
 * elsewhere meanwhile keeps it: `blur` only leaves the input when it still has focus.
 * Resolves to the cause when the typing stopped, else `undefined`.
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
  let refused = false;
  input.focus({ preventScroll: true });
  if (current() !== "") {
    const clear = { bubbles: true, composed: true, inputType: "deleteContentBackward" };
    if (input.dispatchEvent(new InputEvent("beforeinput", { ...clear, cancelable: true }))) {
      setter.call(input, "");
      input.dispatchEvent(new InputEvent("input", clear));
    } else {
      // The page may clear the field itself, as a framework does once its handlers ran.
      await gap();
      if (current() !== "") return "refused";
    }
  }
  const characters = [...value];
  let typed = "";
  for (const [index, character] of characters.entries()) {
    if (index > 0) {
      // eslint-disable-next-line no-await-in-loop
      await gap();
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
  if (refused) {
    // A page that types a cancelled key itself, as a framework does, may write it only once
    // its handlers' microtasks and short timers ran.
    await gap();
    if (current() !== value) return "refused";
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));
  if (document.activeElement === input) input.blur();
  return undefined;
}
