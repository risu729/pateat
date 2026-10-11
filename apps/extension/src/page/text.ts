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
 * `<p>Customer</p><label>Number</label>`. With `everyElement`, every element boundary
 * separates words (`<span>a@example.com</span><a>Not you?</a>`), and elements matching
 * `skip` contribute nothing.
 */
export function renderedText(
  root: Element,
  limit: number,
  { everyElement = false, skip }: { everyElement?: boolean; skip?: string } = {},
): string | undefined {
  if (!shown(root) || textless.has(root.tagName)) return undefined;
  const view = root.ownerDocument.defaultView;
  let text = "";
  // `undefined` marks the end of a block, so its text never joins the text after it.
  const pending: (ChildNode | undefined)[] = [];
  const enqueue = (parent: Node) => {
    for (let child = parent.lastChild; child; child = child.previousSibling) pending.push(child);
  };
  enqueue(root);
  while (pending.length > 0 && text.length <= limit) {
    const node = pending.pop();
    if (node === undefined) text += " ";
    else if (node instanceof Text) text += node.data;
    else if (
      node instanceof Element &&
      !textless.has(node.tagName) &&
      shown(node) &&
      !(skip && node.matches(skip))
    ) {
      if (node instanceof HTMLBRElement) text += " ";
      else if (everyElement || !view?.getComputedStyle(node).display.startsWith("inline")) {
        text += " ";
        pending.push(undefined);
      }
      enqueue(node);
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

/**
 * True for an `<a href>` that runs a script instead of following the link: a
 * `javascript:` URL (SMBC Direct's login is `<a href="javascript:;" onclick="...">`), or
 * an empty or fragment-only `href` on a link with an `onclick` attribute or
 * `role="button"` (MyJCB's login script sets `href="#"` on
 * `<a id="loginButtonAD" onclick="document.loginForm.submit()">`).
 */
function scriptHref(link: HTMLAnchorElement): boolean {
  if (link.protocol === "javascript:") return true;
  // As URL parsing does: tabs and newlines go anywhere, C0 controls and spaces at the
  // ends. A `<base href>` naming another document would make `#` navigate; that is rare.
  const href = link
    .getAttribute("href")!
    .replace(/[\t\n\r]/gu, "")
    .replace(/^[\0-\x20]+|[\0-\x20]+$/gu, "");
  return (
    (href === "" || href.startsWith("#")) && (link.hasAttribute("onclick") || roleButton(link))
  );
}

const roleButton = (element: Element) =>
  element.getAttribute("role")?.trim().toLowerCase() === "button";

/**
 * A control that only scripts make clickable: a script link (an `<a>` without `href`
 * that has an `onclick` attribute or `role="button"`, or an `<a href>` that runs a
 * script, see {@link scriptHref}), or another element with `role="button"`. Form
 * controls, links that navigate and anything inside an `<a href>` (a click there would
 * follow the link, or reach the outer link's script) are not script buttons.
 */
export function isScriptButton(element: Element): boolean {
  if (
    !(element instanceof HTMLElement) ||
    element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
  )
    return false;
  if (element instanceof HTMLAnchorElement)
    return element.hasAttribute("href")
      ? scriptHref(element)
      : element.hasAttribute("onclick") || roleButton(element);
  return element.closest("a[href]") === null && roleButton(element);
}

/**
 * A script button that text locators name like a native button: any `<a>` that
 * {@link isScriptButton} accepts. Other `role="button"` elements are often widgets such
 * as menus and toggles, so only attribute locators name them.
 */
export function isScriptLink(element: Element): element is HTMLAnchorElement {
  return element instanceof HTMLAnchorElement && isScriptButton(element);
}

/** The `alt` of the shown images in a `<button>` that has no rendered text. */
function imageText(button: HTMLButtonElement): string {
  return [...button.querySelectorAll("img[alt]")]
    .flatMap((image) => (shown(image) ? [image.getAttribute("alt")!] : []))
    .join(" ");
}

/**
 * The text a `{ by: "text" }` locator compares: a rendered button's or script link's
 * text (or, for an image-only `<button>`, its images' `alt`), an input button's
 * `value`, or an image button's `alt`, collapsed. A button that is not rendered, or
 * whose text is empty or longer than 120 code units, has none.
 */
export function buttonText(element: Element): string | undefined {
  if (!(isButton(element) || isScriptLink(element)) || !shown(element)) return undefined;
  const readLimit = buttonTextLimit * 4;
  let raw =
    !isButton(element) || element instanceof HTMLButtonElement
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

/**
 * A rendered `<a href>` link's text, collapsed, like {@link buttonText}: none when the
 * link is not rendered, or its text is empty or longer than 120 code units.
 */
export function linkText(element: Element): string | undefined {
  if (!(element instanceof HTMLAnchorElement) || !element.hasAttribute("href") || !shown(element))
    return undefined;
  const readLimit = buttonTextLimit * 4;
  const raw = renderedText(element, readLimit);
  if (raw === undefined || raw.length > readLimit) return undefined;
  const text = collapseText(raw);
  return text && text.length <= buttonTextLimit ? text : undefined;
}
