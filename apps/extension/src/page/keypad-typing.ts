// Typing a value on a page's software keyboard (ADR 0067), one press per
// character on the key that shows it (`keysFor` in `keypad.ts`).

import { gap } from "./enter-value";
import { focusElement } from "./focus";
import { keyLabel, keypadCovers, keypadOpen, keysFor, pressable } from "./keypad";
import { pressElement } from "./script-url-click";

/** How long a keypad that opens when its field is pressed may take to show its keys. */
export const KEYPAD_OPEN_MS = 2_000;
/** How often the executor looks for the keys while the keypad opens. */
const openPollMs = 50;
/** How long a press may take to show its character in the field. */
export const KEYPAD_PRESS_MS = 1_000;

/** Why typing on a keypad stopped, besides the caller's own causes. */
export type KeypadStop =
  /** The keypad showed no key, even after its field was pressed. */
  | "keypad-closed"
  /** A character of the value has no key, or several, so nothing more is pressed. */
  | "key-missing"
  /** The field held characters before, or did not show one more after a press. */
  | "refused";

const valueProperty = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");

/**
 * Types `value` into `input` on the page's keypad, which `keypad` looks up again before
 * each use, one press of the key that shows each character, as a person would. A field that already holds characters is
 * refused at once: no key, such as a clear key, is ever pressed but the value's own. The
 * field is focused first, and pressed when the keypad shows no key, as one that opens on
 * focus or click; its keys must show within {@link KEYPAD_OPEN_MS}. Before the first
 * press, every character must have exactly one key a person can press (`keysFor`), else
 * nothing is pressed. The keypad and each key are looked up again just before its press,
 * since some keypads shuffle or redraw their keys after each one, and the typing stops at
 * the first character without exactly one key. After each press, the field must come to
 * hold one more character, masked or not, within {@link KEYPAD_PRESS_MS}, read after each
 * of the page's pauses (`gap`); more characters, or none in time, stop the typing as
 * `refused`: a keypad
 * that ignored the press, as one that checks `isTrusted` would, or that keeps the value
 * elsewhere, is never submitted with a value Pateat cannot see. Nothing is ever pressed
 * again after a stop. Each press stops before its click when the key no longer shows its
 * character or cannot be pressed, as a keypad that relabels its keys on `pointerdown`.
 * `between` runs after each wait, as `typeValue`'s does, and `onPress` after each press
 * that reached its key's `pointerdown`. Resolves to the cause when the typing stopped,
 * else `undefined`.
 */
export async function typeOnKeypad<Cause extends string>(
  input: HTMLInputElement,
  value: string,
  keypad: () => Element | undefined,
  {
    between,
    onPress,
    openMs = KEYPAD_OPEN_MS,
    pressMs = KEYPAD_PRESS_MS,
  }: {
    between?: (() => Cause | undefined) | undefined;
    onPress?: () => void;
    openMs?: number;
    pressMs?: number;
  } = {},
): Promise<Cause | KeypadStop | undefined> {
  const current = () => (valueProperty?.get ? valueProperty.get.call(input) : input.value);
  if (current() !== "") return "refused";
  const characters = [...value];
  const open = () => {
    const container = keypad();
    return container !== undefined && keypadOpen(container);
  };
  focusElement(input);
  if (!open()) {
    const pressed = await pressElement(input, () => between?.() === undefined);
    const cause = between?.();
    if (cause) return cause;
    if (pressed !== "clicked") return "keypad-closed";
    const until = Date.now() + openMs;
    while (!open() && Date.now() < until) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, openPollMs));
      const stopped = between?.();
      if (stopped) return stopped;
    }
    if (!open()) return "keypad-closed";
  }
  const shown = keypad();
  if (!shown || !keypadCovers(shown, value)) return "key-missing";
  for (const [index, character] of characters.entries()) {
    const container = keypad();
    const keys = container ? keysFor(container, character) : [];
    if (keys.length !== 1) return "key-missing";
    const key = keys[0]!;
    // eslint-disable-next-line no-await-in-loop
    const pressed = await pressElement(
      key,
      () => between?.() === undefined && keyLabel(key) === character && pressable(key),
    );
    // A press stopped after `pointerdown` may have typed already.
    if (pressed !== "missed") onPress?.();
    const cause = between?.();
    if (cause) return cause;
    if (pressed !== "clicked") return "refused";
    const until = Date.now() + pressMs;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      await gap();
      const stopped = between?.();
      if (stopped) return stopped;
      const length = [...current()].length;
      if (length === index + 1) break;
      if (length > index + 1 || Date.now() >= until) return "refused";
    }
  }
  return undefined;
}
