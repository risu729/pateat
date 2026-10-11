/** Elements whose text is never page text: code, styles, raw markup and control contents. */
const textless = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SELECT",
  "OPTION",
  "OPTGROUP",
  "DATALIST",
  "TEXTAREA",
  "INPUT",
  "IFRAME",
  "OBJECT",
  "CANVAS",
]);

/** Rendered: not hidden by CSS, a closed `<details>` or an attribute (opacity optional). */
export function shown(element: Element, opacity = true): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.isConnected &&
    !element.closest("[hidden], [inert], [aria-hidden='true']") &&
    element.checkVisibility({
      contentVisibilityAuto: true,
      opacityProperty: opacity,
      visibilityProperty: true,
      // Chrome 120, the minimum version, knows only the older option names.
      checkOpacity: opacity,
      checkVisibilityCSS: true,
    })
  );
}

/**
 * The rendered text inside a shown element, read from text nodes of shown elements
 * only, until it is longer than `limit`. Scripts, styles, raw markup, SVG and
 * form-control contents never contribute. Blocks and `<br>` separate words as
 * rendering does: `<div>Customer</div><div>Number</div>` and
 * `<p>Customer</p><label>Number</label>`.
 */
export function renderedText(root: Element, limit: number): string | undefined {
  if (!shown(root) || textless.has(root.tagName)) return undefined;
  const view = root.ownerDocument.defaultView;
  let text = "";
  // `undefined` marks the end of a block, so its text never joins the text after it.
  const pending: (ChildNode | undefined)[] = [...root.childNodes].reverse();
  while (pending.length > 0 && text.length <= limit) {
    const node = pending.pop();
    if (node === undefined || node instanceof HTMLBRElement) text += " ";
    else if (node instanceof Text) text += node.data;
    else if (node instanceof Element && !textless.has(node.tagName) && shown(node)) {
      if (!view?.getComputedStyle(node).display.startsWith("inline")) {
        text += " ";
        pending.push(undefined);
      }
      pending.push(...[...node.childNodes].reverse());
    }
  }
  return text;
}

/**
 * Removes format characters (zero-width spaces, soft hyphens), turns control and
 * separator characters into spaces, and collapses whitespace to single spaces.
 */
export function collapseText(raw: string): string {
  return raw
    .replace(/\p{Cf}+/gu, "")
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const buttonInputTypes = new Set(["submit", "button", "image"]);
const buttonTextLimit = 120;

/** A control the executor clicks: a `<button>` or an `<input type="submit|button|image">`. */
export function isButton(element: Element): element is HTMLButtonElement | HTMLInputElement {
  return (
    element instanceof HTMLButtonElement ||
    (element instanceof HTMLInputElement && buttonInputTypes.has(element.type))
  );
}

/** The `alt` of the shown images in a `<button>` that has no rendered text. */
function imageText(button: HTMLButtonElement): string {
  return [...button.querySelectorAll("img[alt]")]
    .flatMap((image) => (shown(image) ? [image.getAttribute("alt")!] : []))
    .join(" ");
}

/**
 * The text a `{ by: "text" }` locator compares: a rendered button's text (or, for an
 * image-only button, its images' `alt`), an input button's `value`, or an image
 * button's `alt`, collapsed. A button that is not rendered, or whose text is empty or
 * longer than 120 code units, has none.
 */
export function buttonText(element: Element): string | undefined {
  if (!isButton(element) || !shown(element)) return undefined;
  const readLimit = buttonTextLimit * 4;
  let raw =
    element instanceof HTMLButtonElement
      ? renderedText(element, readLimit)
      : element.type === "image"
        ? element.alt
        : element.value;
  // A read cut short could collapse to a prefix ("Sign in" of "Sign in and delete").
  if (raw === undefined || raw.length > readLimit) return undefined;
  if (element instanceof HTMLButtonElement && !collapseText(raw)) raw = imageText(element);
  const text = collapseText(raw);
  return text && text.length <= buttonTextLimit ? text : undefined;
}
