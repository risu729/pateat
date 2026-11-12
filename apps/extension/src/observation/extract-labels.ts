import { closestAcross, composedParent, queryAll, treeOf } from "../page/shadow";
import { renderedText, shown } from "../page/text";
import { rawLimit, uncutText, visibleText } from "./extract-text";
import { controls, fields } from "./extract-controls";

const labelDepth = 3;

export const idList = (element: Element, attribute: string) =>
  element.getAttribute(attribute)?.split(/\s+/u).filter(Boolean) ?? [];

/**
 * Visible text of the elements `ids` name. With `skip`, the text of an element matching
 * it, or of one inside such an element, is left out; with `keys`, the keys of a page's
 * software keyboards (ADR 0067), so is their text, as the key labels and their order.
 */
function referencedText(
  element: Element,
  ids: readonly string[],
  skip?: string,
  keys?: ReadonlySet<Element>,
): string | undefined {
  const parts = ids.flatMap((id) => {
    const referenced = treeOf(element).getElementById(id);
    if (!referenced || (skip && closestAcross(referenced, skip))) return [];
    const text = uncutText(renderedText(referenced, rawLimit, { skip, leave: keys }));
    return text ? [text] : [];
  });
  return uncutText(parts.join(" "));
}

/** Regions that announce changes, such as a failed sign-in's message. */
export const liveRegions = [
  ...["alert", "status", "log", "marquee", "timer"].map((role) => `[role~='${role}' i]`),
  "[aria-live]:not([aria-live='off'])",
].join(", ");

/**
 * A field's `aria-describedby` text, such as a hint that it takes three digits. Error
 * messages can echo the value the user typed, so a field marked `aria-invalid="true"`
 * gets none, and an element its `aria-errormessage` names or a live region, around the
 * description or inside it, never counts.
 * Text that repeats the label is left out.
 */
export function fieldDescription(
  input: HTMLInputElement,
  label: string | undefined,
  keys?: ReadonlySet<Element>,
) {
  if (input.getAttribute("aria-invalid")?.trim().toLowerCase() === "true") return undefined;
  const errors = new Set(idList(input, "aria-errormessage"));
  const text = referencedText(
    input,
    idList(input, "aria-describedby").filter((id) => !errors.has(id)),
    liveRegions,
    keys,
  );
  return text === label ? undefined : text;
}

/** True for an element that belongs to another control: a control or its `<label for>`. */
function otherControl(node: Element, element: Element): boolean {
  const labelsOther = (label: Element) =>
    label instanceof HTMLLabelElement && label.htmlFor !== "" && label.control !== element;
  return (
    node.matches(controls) ||
    labelsOther(node) ||
    queryAll(node, controls).length > 0 ||
    queryAll(node, "label[for]").some(labelsOther)
  );
}

/**
 * Text of a nearby element that labels a field by layout, as table and form rows do:
 * the nearest preceding sibling with rendered text, at most three levels up, never
 * across another control's area, a software keyboard's keys (`keys`, ADR 0067) or out of
 * the field's form.
 */
function adjacentText(element: Element, keys?: ReadonlySet<Element>): string | undefined {
  let node: Element | null = element;
  for (let depth = 0; node && depth <= labelDepth; depth += 1) {
    if (depth > 0 && queryAll(node, fields).length > 1) return undefined;
    if (node instanceof HTMLFormElement || node === node.ownerDocument.body) return undefined;
    for (let sibling = node.previousElementSibling; sibling;) {
      const before: Element = sibling;
      if (
        otherControl(before, element) ||
        (keys?.size && [...keys].some((key) => before.contains(key) || key.contains(before)))
      )
        return undefined;
      const text = visibleText(sibling);
      if (text) return text;
      sibling = sibling.previousElementSibling;
    }
    node = composedParent(node);
  }
  return undefined;
}

/**
 * A field's label: its `aria-labelledby` text, `aria-label`, `<label>` text, the nearby
 * text that labels it by layout, or its `title`, in that order. The keys of a page's
 * software keyboards (`keys`, ADR 0067), with their labels and order, are never part of
 * it; the rest of a label around them is.
 */
export function fieldLabel(
  input: HTMLInputElement | HTMLSelectElement,
  keys?: ReadonlySet<Element>,
): string | undefined {
  const labels = [...(input.labels ?? [])].flatMap((label) => {
    const text = uncutText(renderedText(label, rawLimit, { leave: keys }));
    return text ? [text] : [];
  });
  return (
    referencedText(input, idList(input, "aria-labelledby"), undefined, keys) ??
    uncutText(input.getAttribute("aria-label")) ??
    uncutText(labels.join(" ")) ??
    adjacentText(input, keys) ??
    uncutText(input.title)
  );
}

export function actionLabel(element: HTMLElement): string | undefined {
  const images = queryAll(element, "img[alt]").flatMap((image) =>
    shown(image) ? [image.getAttribute("alt")] : [],
  );
  return (
    referencedText(element, idList(element, "aria-labelledby")) ??
    uncutText(element.getAttribute("aria-label")) ??
    (element instanceof HTMLInputElement
      ? uncutText(element.type === "image" ? element.alt : element.value)
      : visibleText(element)) ??
    uncutText(images.join(" ")) ??
    uncutText(element.title)
  );
}
