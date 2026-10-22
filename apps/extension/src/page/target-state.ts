import {
  namesPasswordChoice,
  namesPasswordControl,
  type LoginMarkerTarget,
} from "@pateat/contracts";
import type { TargetCheck, TargetRequirement, TargetState } from "../login/wire";
import { presence, presenceMiss } from "../observation/extract";
import { visible } from "./code-submission";
import { findTargets } from "./targets";
import {
  controlContent,
  controlName,
  controlText,
  isButton,
  isFragmentButton,
  isScriptButton,
} from "./text";

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
/**
 * A shown enabled button, or a shown script button that is not `aria-disabled`, neither
 * `inert` nor inside an `inert` element, which takes no click until the page lifts it, as
 * a submit control kept inert until its fields are filled (#853); with
 * `fragment`, which a target named by its accessible name sets, also such a link to a
 * fragment of its own document ({@link isFragmentButton}, ADR 0048 amendment of
 * 2026-10-19).
 */
export function clickable(
  element: Element | undefined,
  { fragment = false }: { fragment?: boolean } = {},
): element is HTMLElement {
  if (element === undefined || element.closest("[inert]")) return false;
  if (isButton(element)) return visible(element) && !element.disabled;
  return (
    element instanceof HTMLElement &&
    (isScriptButton(element) || (fragment && isFragmentButton(element))) &&
    visible(element) &&
    element.getAttribute("aria-disabled") !== "true"
  );
}
/**
 * A shown control that names the password as the way to confirm the sign-in (ADR 0048):
 * a button or a script button, or with `fragment` as {@link clickable} takes it a link to a
 * fragment of its own document, whose accessible name and all the text it holds
 * ({@link controlContent}, hidden text too) pass `namesPasswordControl` (its 2026-10-19
 * amendment), so a text too long to read in full refuses it. Without an accessible name,
 * its visible text must name the password itself (`namesPasswordChoice`).
 */
export function passwordChoice(
  element: Element | undefined,
  { fragment = false }: { fragment?: boolean } = {},
): boolean {
  if (
    !(element instanceof HTMLElement) ||
    !visible(element) ||
    !(isButton(element) || isScriptButton(element) || (fragment && isFragmentButton(element)))
  )
    return false;
  const name = controlName(element);
  if (name !== undefined) return namesPasswordControl(name, controlContent(element));
  const text = controlText(element);
  return text !== undefined && namesPasswordChoice(text);
}
/** Whether a target names its element by its accessible name, which a fragment link may be. */
const byName = (target: LoginMarkerTarget) => target.by === "accessible-name";
/**
 * One target's state in `document`: `unique` when it matches one element that is what
 * `require` asks for (a shown writable input, a shown enabled button, any shown element, an
 * input of a kind Pateat fills, or such an input shown; with `described-writable` or
 * `described-clickable`, a writable input or a clickable button that is also visible as the
 * page's description reads it; with `password-choice`, a shown control that names the
 * password choice, {@link passwordChoice}, ADR 0048); without
 * it, or with `present`, any one element counts. A target named by its accessible name may
 * be a link to a fragment of its own document, which counts as clickable. `links` and
 * `hidden` are {@link findTargets}'s options.
 */
export function targetState(
  document: Document,
  target: LoginMarkerTarget,
  require?: TargetRequirement,
  options: { links?: boolean; hidden?: boolean } = {},
): TargetState {
  const found = findTargets(document, target, options);
  if (found.length !== 1) return found.length === 0 ? "missing" : "ambiguous";
  const [element] = found;
  const shown = element instanceof HTMLElement && visible(element);
  // Not hidden from assistive technology, transparent (unless fading in), tiny or moved
  // before the page's start, as a password input an email form keeps for the browser.
  const described = () => element instanceof HTMLElement && presence(element) === "visible";
  const fragment = byName(target);
  return (require === "writable" && !writable(element)) ||
    (require === "clickable" && !clickable(element, { fragment })) ||
    (require === "described-writable" && !(writable(element) && described())) ||
    (require === "described-clickable" && !(clickable(element, { fragment }) && described())) ||
    (require === "shown" && !shown) ||
    (require === "input" && !textInput(element)) ||
    (require === "shown-input" && !(textInput(element) && shown)) ||
    (require === "password-choice" && !passwordChoice(element, { fragment }))
    ? "unusable"
    : "unique";
}
/**
 * The check that decided {@link targetState} for one target, for the log only (ADR 0019):
 * `ok` when it is `unique`, `missing`, `matches-N` for several elements (9 standing for 9
 * or more), or why the one element is `unusable`: for an input or button requirement, an
 * element the content script's visibility check does not see, under a `hidden` attribute
 * (`hidden-attr`) or not rendered otherwise (`not-rendered`), then one it sees that is
 * disabled, read-only or no such control (`not-writable`, `not-clickable`); then, for a
 * `described-…` requirement, the first reason the page's description does not see it
 * ({@link presenceMiss}). Never any text or
 * value of the page.
 */
export function targetCheck(
  document: Document,
  target: LoginMarkerTarget,
  require?: TargetRequirement,
  options: { links?: boolean; hidden?: boolean } = {},
): TargetCheck {
  const found = findTargets(document, target, options);
  if (found.length === 0) return "missing";
  if (found.length > 1) return `matches-${Math.min(found.length, 9)}` as TargetCheck;
  if (targetState(document, target, require, options) === "unique") return "ok";
  const [element] = found;
  const fragment = byName(target);
  const writing = require === "writable" || require === "described-writable";
  const clicking = require === "clickable" || require === "described-clickable";
  // The input and button tests require the content script's visibility first: an element
  // it does not see is named by why, apart from one that shows but takes no input.
  if ((writing || clicking) && element instanceof HTMLElement && !visible(element))
    return element.closest("[hidden]") ? "hidden-attr" : "not-rendered";
  if (writing && !writable(element)) return "not-writable";
  if (clicking && !clickable(element, { fragment })) return "not-clickable";
  if (
    (require === "described-writable" || require === "described-clickable") &&
    element instanceof HTMLElement
  )
    return presenceMiss(element) ?? "unusable";
  return "unusable";
}
