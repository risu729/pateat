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

const visibility = (opacity: boolean) => ({
  contentVisibilityAuto: true,
  opacityProperty: opacity,
  visibilityProperty: true,
  // Chrome 120, the minimum version, knows only the older option names.
  checkOpacity: opacity,
  checkVisibilityCSS: true,
});

const hiders = "[inert], [aria-hidden='true']";

/**
 * The elements an open modal dialog's script hid from assistive technology, set only
 * while {@link readBehindModal} runs.
 */
let behindModal: ReadonlySet<Element> | undefined;

/**
 * The open modal dialogs of `document`: each shown element with `aria-modal="true"` and
 * the role `dialog` or `alertdialog` (a `<dialog>` has that role itself), and each
 * `<dialog>` opened with `showModal()`.
 */
export function openModals(document: Document): HTMLElement[] {
  return [...document.querySelectorAll("[aria-modal='true' i], dialog")].filter(
    (element): element is HTMLElement =>
      (element.matches(":modal") ||
        (element.getAttribute("aria-modal")?.trim().toLowerCase() === "true" &&
          (element instanceof HTMLDialogElement ||
            /^(?:alert)?dialog$/u.test(
              element.getAttribute("role")?.trim().toLowerCase().split(/\s+/u)[0] ?? "",
            )))) &&
      shown(element),
  );
}

/**
 * Runs `read` with the page behind `document`'s open modal dialogs counted as shown: an
 * `aria-hidden="true"` or `inert` element beside a modal or beside one of its ancestors
 * no longer hides what it holds. Modal libraries mark those elements while a modal is
 * open (Radix and `aria-hidden`, React Aria, Headless UI, MUI), but the page still
 * renders behind the overlay, as the signed-in page did behind a promotion on
 * 2026-10-13 (ADR 0029). Such an element hidden for another reason, such as a closed
 * drawer beside the page's root, counts too; an attribute inside the page or the modal
 * still hides. Nothing changes without an open modal. Only the signed-in page's
 * description and E2 read the page this way.
 */
export function readBehindModal<Result>(document: Document, read: () => Result): Result {
  const outer = behindModal;
  const modals = openModals(document);
  const hidden = new Set<Element>();
  for (const modal of modals)
    for (let ancestor = modal.parentElement; ancestor; ancestor = ancestor.parentElement)
      for (const sibling of ancestor.children) if (sibling.matches(hiders)) hidden.add(sibling);
  behindModal = hidden.size > 0 ? hidden : outer;
  try {
    return read();
  } finally {
    behindModal = outer;
  }
}

/**
 * Whether an `inert` or `aria-hidden="true"` element hides `element`, leaving out those
 * an open modal hid while {@link readBehindModal} runs.
 */
function hiddenByAttribute(element: Element): boolean {
  for (
    let hider = element.closest(hiders);
    hider;
    hider = hider.parentElement?.closest(hiders) ?? null
  )
    if (!behindModal?.has(hider)) return true;
  return false;
}

/**
 * Rendered: not hidden by CSS, a closed `<details>` or an attribute (opacity optional).
 * An element with `display: contents` has no box of its own, so `checkVisibility` is
 * false for it although its children render in its place; it counts as shown when its
 * parent is, the parent renders its content (not a closed `<details>` or
 * `content-visibility: hidden`), and any child element renders too (Cloudflare's saved
 * profiles wrap each address in one, 2026-10-12).
 */
export function shown(element: Element, opacity = true): element is HTMLElement {
  if (
    !(element instanceof HTMLElement) ||
    !element.isConnected ||
    element.closest("[hidden]") ||
    hiddenByAttribute(element)
  )
    return false;
  if (element.checkVisibility(visibility(opacity))) return true;
  const parent = element.parentElement;
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  if (
    !parent ||
    !view ||
    style?.display !== "contents" ||
    // Its own text renders with its `visibility`, which its children also inherit.
    style.visibility !== "visible" ||
    (parent instanceof HTMLDetailsElement && !parent.open) ||
    view.getComputedStyle(parent).contentVisibility === "hidden" ||
    !shown(parent, opacity)
  )
    return false;
  // Children are checked themselves; a nested `display: contents` one counts as rendered.
  const children = [...element.children];
  return (
    !children.length ||
    children.some(
      (child) =>
        child.checkVisibility(visibility(opacity)) ||
        view.getComputedStyle(child).display === "contents",
    )
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
 * `javascript:` (or `data:` or `vbscript:`) URL (SMBC Direct's login is `<a href="javascript:;" onclick="...">`), or
 * an empty or fragment-only `href` on a link with an `onclick` attribute or
 * `role="button"` (MyJCB's login script sets `href="#"` on
 * `<a id="loginButtonAD" onclick="document.loginForm.submit()">`).
 */
function scriptHref(link: HTMLAnchorElement): boolean {
  // A `data:` or `vbscript:` link does not navigate either: Chrome blocks top-level
  // `data:` navigations and has no `vbscript:`, so a click runs only the page's script.
  if (["javascript:", "data:", "vbscript:"].includes(link.protocol)) return true;
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

/**
 * True when a native button, shown or not, may carry `text`: its whole collapsed text
 * content (hidden descendants included), one of its images' `alt`, or an input button's
 * `value` or `alt`. It is a loose guard only: a hidden native button with a script
 * link's text, such as one revealed after an animation, keeps a text locator from
 * falling back to the script link meanwhile. Which shown native button a locator names
 * still comes from {@link buttonText}.
 */
export function hasNativeButton(document: Document, text: string): boolean {
  return [...document.querySelectorAll("button, input")].some((element) => {
    if (!isButton(element)) return false;
    const raw =
      element instanceof HTMLButtonElement
        ? [
            element.textContent ?? "",
            ...[...element.querySelectorAll("img[alt]")].map((image) => image.getAttribute("alt")!),
          ]
        : [element.type === "image" ? element.alt : element.value];
    return raw.some((part) => collapseText(part) === text);
  });
}

/** The `alt` of the shown images in a `<button>` or link that has no rendered text. */
function imageText(element: Element): string {
  return [...element.querySelectorAll("img[alt]")]
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
 * A rendered `<a href>` link's text (or, for an image-only link such as a header icon,
 * its images' `alt`), collapsed, like {@link buttonText}: none when the link is not
 * rendered, or its text is empty or longer than 120 code units.
 */
export function linkText(element: Element): string | undefined {
  if (!(element instanceof HTMLAnchorElement) || !element.hasAttribute("href") || !shown(element))
    return undefined;
  const readLimit = buttonTextLimit * 4;
  let raw = renderedText(element, readLimit);
  if (raw === undefined || raw.length > readLimit) return undefined;
  if (!collapseText(raw)) raw = imageText(element);
  const text = collapseText(raw);
  return text && text.length <= buttonTextLimit ? text : undefined;
}

/** The `<input>` types a login fills, which a `{ by: "label" }` locator names. */
const fieldInputTypes = new Set(["text", "email", "tel", "number", "password"]);
const fieldNameLimit = 120;

/**
 * The visible name a `{ by: "label" }` locator compares (ADR 0037): for a shown fillable
 * `<input>`, the rendered text of the elements its `aria-labelledby` names, else of its
 * `<label>` elements, else its `aria-label`, else its `placeholder`, the first that is not
 * empty, collapsed. An input that is not shown or not fillable, or whose first name is
 * longer than 120 code units, has none; a later source is never tried in its place.
 */
export function fieldName(element: Element): string | undefined {
  if (
    !(element instanceof HTMLInputElement) ||
    !fieldInputTypes.has(element.type) ||
    !shown(element)
  )
    return undefined;
  const readLimit = fieldNameLimit * 4;
  // Undefined when the text is cut short, which could collapse to a prefix of it.
  const read = (elements: readonly Element[]) => {
    let raw = "";
    for (const part of elements) {
      raw += ` ${renderedText(part, readLimit) ?? ""}`;
      if (raw.length > readLimit) return undefined;
    }
    return collapseText(raw);
  };
  const document = element.ownerDocument;
  const referenced = (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u).flatMap((id) => {
    const target = id ? document.getElementById(id) : null;
    return target ? [target] : [];
  });
  const sources = [
    () => read(referenced),
    () => read([...(element.labels ?? [])]),
    () => collapseText(element.getAttribute("aria-label") ?? ""),
    () => collapseText(element.placeholder),
  ];
  for (const source of sources) {
    const name = source();
    if (name === undefined) return undefined;
    if (name) return name.length <= fieldNameLimit ? name : undefined;
  }
  return undefined;
}
