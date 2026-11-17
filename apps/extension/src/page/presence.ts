import { attributeHidden, shown } from "./text";

/**
 * Whether a control is on the page: `visible`, `faint` when it is rendered but
 * transparent or tiny (a trap, or a real input under a styled widget), or `absent`
 * when it is hidden or moved before the page's start, where trap inputs usually go.
 * A control transparent only while it or an ancestor fades in from opacity 0 counts as
 * opaque, as `shown` does (2026-10-17), and so does a fillable input transparent only
 * under its own shown label (2026-10-23) or laid over boxes drawn for it (2026-11-17).
 */
export function presence(element: HTMLElement): "visible" | "faint" | "absent" {
  const miss = presenceMiss(element);
  if (miss === undefined) return "visible";
  return miss === "transparent" || miss === "tiny" ? "faint" : "absent";
}

/**
 * Why {@link presence} does not read a control as `visible`, checked in its order: an
 * attribute hides it (`hidden-attr`: `hidden`, `inert` or `aria-hidden`), it is not
 * rendered otherwise (`not-rendered`), it is moved before the page's start (`off-start`),
 * it is transparent and not fading in or revealed by its label (`transparent`), or it is
 * under 2 pixels wide or high (`tiny`). Undefined when it is visible. For the log only (ADR 0019).
 */
export function presenceMiss(
  element: HTMLElement,
): "hidden-attr" | "not-rendered" | "off-start" | "transparent" | "tiny" | undefined {
  const view = element.ownerDocument.defaultView;
  if (!view) return "not-rendered";
  if (!shown(element, false)) return attributeHidden(element) ? "hidden-attr" : "not-rendered";
  const rect = element.getBoundingClientRect();
  if (rect.right + view.scrollX <= 0 || rect.bottom + view.scrollY <= 0) return "off-start";
  if (!shown(element)) return "transparent";
  if (rect.width < 2 || rect.height < 2) return "tiny";
  return undefined;
}
