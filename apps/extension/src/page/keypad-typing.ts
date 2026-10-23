// Typing a value on a page's software keyboard (proposed ADR 0067), one press per
// character on the key that shows it (`keysFor` in `keypad.ts`).

import { gap } from "./enter-value";
import { focusElement } from "./focus";
import { keyLabel, keypadCovers, keypadOpen, keysFor, pressable } from "./keypad";
import { pressElement } from "./script-url-click";

/** How long a keypad that opens when its field is pressed may take to show its keys. */
export const KEYPAD_OPEN_MS = 2_000;
/** How often the executor looks for the keys while the keypad opens. */
const openPollMs = 50;

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
 * Types `value` into `input` on the page's keypad in `container`, one press of the key that
 * shows each character, as a person would. A field that already holds characters is
 * refused at once: no key, such as a clear key, is ever pressed but the value's own. The
 * field is focused first, and pressed when the keypad shows no key, as one that opens on
 * focus or click; its keys must show within {@link KEYPAD_OPEN_MS}. Before the first
 * press, every character must have exactly one key a person can press (`keysFor`), else
 * nothing is pressed. Each key is looked up again just before its press, since some
 * keypads shuffle their keys after each one, and the typing stops at the first character
 * without exactly one key. After each press and the page's pause (`gap`), the field must
 * hold one more character, masked or not, else the typing stops as `refused`: a keypad
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
  container: Element,
  {
    between,
    onPress,
    openMs = KEYPAD_OPEN_MS,
  }: {
    between?: (() => Cause | undefined) | undefined;
    onPress?: () => void;
    openMs?: number;
  } = {},
): Promise<Cause | KeypadStop | undefined> {
  const current = () => (valueProperty?.get ? valueProperty.get.call(input) : input.value);
  if (current() !== "") return "refused";
  const characters = [...value];
  const open = () => keypadOpen(container);
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
  if (!keypadCovers(container, value)) return "key-missing";
  for (const [index, character] of characters.entries()) {
    const keys = keysFor(container, character);
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
    // eslint-disable-next-line no-await-in-loop
    await gap();
    const stopped = between?.();
    if (stopped) return stopped;
    if ([...current()].length !== index + 1) return "refused";
  }
  return undefined;
}
