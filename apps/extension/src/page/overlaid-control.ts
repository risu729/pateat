// Click layers named by the text laid over them (ADR 0090): a page drawn in absolutely
// placed `<div>`s may put a button's click target and its text in sibling layers, so the
// element that takes the click holds no text of its own.

import { uncutText } from "../observation/extract-text";
import { closestAcross, composedParent, queryAll } from "./shadow";
import { collapseText, pointer, renderedText, shown } from "./text";

/** The longest overlaid text that names a click layer, as a label is bounded. */
const maxOverlaidText = 120;

/** How far above a click layer the container of its text may be. */
const containerDepth = 3;

/** Elements that make a container more than one control's layers. */
const controls = "a, button, input, select, textarea, [role], [contenteditable]";

/** Whether a `tabindex` attribute is a negative integer, as `-1`. */
const negativeTabIndex = (element: Element) =>
  /^\s*-\d+\s*$/u.test(element.getAttribute("tabindex") ?? "");

/**
 * Whether an element is a click layer (ADR 0090): it has no `role` and a negative
 * `tabindex`, is no form control, link, `<label>` or `<summary>`, is not editable and not
 * inside an `<a href>`, sets the pointer cursor itself, is shown, and holds no text and no
 * control, link, `role` or `tabindex` element. UNSW Endeavour's "log on" takes its clicks
 * on `<div id="274:areaElement" tabindex="-1">`, an empty layer under the text.
 */
export function isClickLayer(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    !(
      element instanceof HTMLAnchorElement ||
      element instanceof HTMLButtonElement ||
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement ||
      element instanceof HTMLLabelElement
    ) &&
    element.localName !== "summary" &&
    !element.hasAttribute("role") &&
    negativeTabIndex(element) &&
    !element.isContentEditable &&
    closestAcross(element, "a[href]") === null &&
    collapseText(element.textContent ?? "") === "" &&
    queryAll(element, `${controls}, [tabindex]`).length === 0 &&
    pointer(element) &&
    shown(element)
  );
}

/**
 * The text laid over a click layer (ADR 0090), redacted and collapsed as a label is: the
 * text of its nearest ancestor, at most three levels up and below the body, that renders
 * text, when each shown text node there has its centre inside the layer's box, the
 * ancestor holds no control, link or `role` element and no other element that sets the
 * pointer cursor, and the text is at most 120 characters. With `hit`, the page's hit test
 * at the layer's centre must also land on it, so a click on its text reaches it; the
 * executor's check leaves that out, so a dialog outside the viewport still counts.
 */
export function overlaidLabel(element: Element, { hit }: { hit: boolean }): string | undefined {
  if (!isClickLayer(element)) return undefined;
  const box = element.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return undefined;
  if (hit) {
    const tree = element.getRootNode();
    if (!(tree instanceof Document || tree instanceof ShadowRoot)) return undefined;
    const at = tree.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    if (!at || !element.contains(at)) return undefined;
  }
  const document = element.ownerDocument;
  let container = composedParent(element);
  for (
    let depth = 1;
    container && depth < containerDepth && collapseText(container.textContent ?? "") === "";
    depth++
  )
    container = composedParent(container);
  if (
    !container ||
    container === document.body ||
    container === document.documentElement ||
    queryAll(container, controls).length > 0 ||
    queryAll(container, "[tabindex]").some(
      (other) => other !== element && !element.contains(other) && pointer(other),
    )
  )
    return undefined;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let texts = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (collapseText(node.textContent ?? "") === "" || !parent || !shown(parent)) continue;
    range.selectNodeContents(node);
    const rect = range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    if (x < box.left || x > box.right || y < box.top || y > box.bottom) return undefined;
    texts++;
  }
  if (texts === 0) return undefined;
  const label = uncutText(renderedText(container, maxOverlaidText * 4));
  return label !== undefined && label.length <= maxOverlaidText ? label : undefined;
}

/**
 * The click layers in `root` outside every form that a click on their text reaches, and
 * that text: those a login page describes beside fields with no button near them
 * (ADR 0090).
 */
export function clickLayers(root: Document | Element): { element: HTMLElement; label: string }[] {
  return queryAll(root, "[tabindex]").flatMap((element) => {
    if (!negativeTabIndex(element) || closestAcross(element, "form")) return [];
    const label = overlaidLabel(element, { hit: true });
    return label === undefined ? [] : [{ element: element as HTMLElement, label }];
  });
}

/**
 * Whether a click step may press `element` (ADR 0090): a click layer only while it shows
 * the step's `shows`, anything else only for a step without it.
 */
export const showsStep = (element: Element, shows: string | undefined): boolean =>
  shows === undefined ? !isClickLayer(element) : overlaidLabel(element, { hit: false }) === shows;
