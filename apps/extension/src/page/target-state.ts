import type { LoginMarkerTarget } from "@pateat/contracts";
import type { TargetRequirement, TargetState } from "../login/wire";
import { presence } from "../observation/extract";
import { visible } from "./code-submission";
import { findTargets } from "./targets";
import { isButton, isScriptButton } from "./text";

/** An input of a kind Pateat fills, whether or not it is shown or can be written now. */
function textInput(element: Element | undefined): element is HTMLInputElement {
  return (
    element instanceof HTMLInputElement &&
    !["hidden", "file", "submit", "button", "image", "reset", "checkbox", "radio"].includes(
      element.type,
    )
  );
}
/** A shown input of a kind Pateat fills that is neither disabled nor read-only. */
export function writable(element: Element | undefined): element is HTMLInputElement {
  return textInput(element) && visible(element) && !element.disabled && !element.readOnly;
}
/** A shown enabled button, or a shown script button that is not `aria-disabled`. */
export function clickable(element: Element | undefined): element is HTMLElement {
  if (element === undefined) return false;
  if (isButton(element)) return visible(element) && !element.disabled;
  return (
    element instanceof HTMLElement &&
    isScriptButton(element) &&
    visible(element) &&
    element.getAttribute("aria-disabled") !== "true"
  );
}
/**
 * One target's state in `document`: `unique` when it matches one element that is what
 * `require` asks for (a shown writable input, a shown enabled button, any shown element, an
 * input of a kind Pateat fills, or such an input shown; with `described-writable` or
 * `described-clickable`, a writable input or a clickable button that is also visible as the
 * page's description reads it); without it, or with `present`, any one element counts.
 */
export function targetState(
  document: Document,
  target: LoginMarkerTarget,
  require?: TargetRequirement,
  links = false,
): TargetState {
  const found = findTargets(document, target, { links });
  if (found.length !== 1) return found.length === 0 ? "missing" : "ambiguous";
  const [element] = found;
  const shown = element instanceof HTMLElement && visible(element);
  // Not hidden from assistive technology, transparent (unless fading in), tiny or moved
  // before the page's start, as a password input an email form keeps for the browser.
  const described = () => element instanceof HTMLElement && presence(element) === "visible";
  return (require === "writable" && !writable(element)) ||
    (require === "clickable" && !clickable(element)) ||
    (require === "described-writable" && !(writable(element) && described())) ||
    (require === "described-clickable" && !(clickable(element) && described())) ||
    (require === "shown" && !shown) ||
    (require === "input" && !textInput(element)) ||
    (require === "shown-input" && !(textInput(element) && shown))
    ? "unusable"
    : "unique";
}
