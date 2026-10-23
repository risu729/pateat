import { closestAcross, composedParent, queryAll, shadowRootOf, treeOf } from "./shadow";

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
  return queryAll(document, "[aria-modal='true' i], dialog").filter(
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
  // Up through the hosts of the shadow trees that hold a modal, each tree's top included
  // (ADR 0070).
  for (const modal of modals)
    for (let node: Element | null = modal; node; node = composedParent(node)) {
      const parent = node.parentNode;
      if (parent instanceof Element || parent instanceof ShadowRoot)
        for (const sibling of parent.children) if (sibling.matches(hiders)) hidden.add(sibling);
    }
  behindModal = hidden.size > 0 ? hidden : outer;
  try {
    return read();
  } finally {
    behindModal = outer;
  }
}

/**
 * Runs `read` with `element`'s own `inert` attribute not hiding it, as a page that keeps
 * its submit control inert until its fields are filled (ANA's login modal, 2026-10-22,
 * #853): such a control counts as a disabled button does. An `inert` or
 * `aria-hidden="true"` ancestor still hides it, and so does its own `aria-hidden`.
 */
export function readOwnInert<Result>(element: Element, read: () => Result): Result {
  if (!element.hasAttribute("inert") || element.getAttribute("aria-hidden") === "true")
    return read();
  const outer = behindModal;
  behindModal = new Set([...(outer ?? []), element]);
  try {
    return read();
  } finally {
    behindModal = outer;
  }
}

/**
 * Whether an `inert` or `aria-hidden="true"` element hides `element`, leaving out those
 * an open modal hid while {@link readBehindModal} runs and an element {@link readOwnInert}
 * reads.
 */
function hiddenByAttribute(element: Element): boolean {
  for (let hider = closestAcross(element, hiders); hider;) {
    if (!behindModal?.has(hider)) return true;
    const parent = composedParent(hider);
    hider = parent && closestAcross(parent, hiders);
  }
  return false;
}

/**
 * Whether an attribute hides `element` as {@link shown} reads it: a `hidden` ancestor or
 * itself, or an `inert` or `aria-hidden="true"` one.
 */
export function attributeHidden(element: Element): boolean {
  return closestAcross(element, "[hidden]") !== null || hiddenByAttribute(element);
}

/**
 * The parent of `element` in the flat tree, as `checkVisibility` walks it, or `undefined`
 * when its slot in its parent's shadow root cannot be found. A closed shadow root hides
 * the slot from `assignedSlot`; a content script reaches the root through
 * `dom.openOrClosedShadowRoot`.
 */
function flatParent(element: Element): Element | null | undefined {
  if (element.assignedSlot) return element.assignedSlot;
  const parent = element.parentNode;
  if (parent instanceof ShadowRoot) return parent.host;
  const host = element.parentElement;
  const root = host && shadowRootOf(host);
  if (!root) return host;
  return [...root.querySelectorAll("slot")].find((slot) => slot.assignedNodes().includes(element));
}

/** Whether the current iteration of `animation` plays toward its effect's last keyframe. */
function forward(animation: Animation, timing: ComputedEffectTiming): boolean {
  const odd = (timing.currentIteration ?? Math.floor(timing.iterationStart ?? 0)) % 2 === 1;
  const reversed =
    timing.direction === "reverse" ||
    (timing.direction === "alternate" && odd) ||
    (timing.direction === "alternate-reverse" && !odd);
  return reversed === animation.playbackRate < 0;
}

/**
 * Whether an animation of `element` that has not finished, running or paused, still
 * takes its opacity above 0 in its current iteration: a CSS animation, a CSS transition
 * or a script's `animate()` with a keyframe ahead of its current progress, in the
 * direction it plays, whose opacity is above 0. One that holds the opacity at 0 for the
 * rest of the iteration, as a fade-out that then holds or a carousel's slide hidden
 * until its next cycle, does not count. One still waiting out its delay counts from the
 * iteration's start.
 */
function fades(element: Element): boolean {
  return element.getAnimations().some((animation) => {
    const effect = animation.effect;
    if (
      (animation.playState !== "running" && animation.playState !== "paused") ||
      !(effect instanceof KeyframeEffect)
    )
      return false;
    const timing = effect.getComputedTiming();
    const ahead = forward(animation, timing);
    // Before its delay ends without a backwards fill, the effect is not applied yet.
    const waiting = timing.localTime !== null && Number(timing.localTime) < (timing.delay ?? 0);
    const at = timing.progress ?? (waiting ? (ahead ? 0 : 1) : undefined);
    if (at === undefined) return false;
    return effect
      .getKeyframes()
      .some(
        (frame) =>
          (ahead ? frame.computedOffset >= at : frame.computedOffset <= at) &&
          Number(frame["opacity"] ?? 0) > 0,
      );
  });
}

/**
 * Whether `element` is transparent only while it fades in: each of it and its flat-tree
 * ancestors whose opacity is 0, which `checkVisibility` counts as hidden, has an
 * animation of its opacity under way ({@link fades}). A sign-in form often fades in, as
 * Microsoft Entra's did: its email field stayed under a container at opacity 0 until
 * about 1.3 seconds after the page started in cloud Chromium (2026-10-17). An animation
 * does not advance while the tab is not rendered (inferred for the owner's Chrome), so
 * one held at its start counts, paused ones too. An input at opacity 0 with no such
 * animation, as a trap, is not fading.
 */
function fadingIn(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  let transparent = false;
  for (let node: Element | null = element; node;) {
    if (Number(view.getComputedStyle(node).opacity) === 0) {
      if (!fades(node)) return false;
      transparent = true;
    }
    const parent = flatParent(node);
    // A slot it cannot find may sit under a transparent element that is not fading.
    if (parent === undefined) return false;
    node = parent;
  }
  return transparent;
}

/**
 * Whether `element` is a fillable input transparent only under its own `<label>`: the
 * label holds it and shows text at full opacity, as a floating label that reveals its
 * input once it is focused or holds a value. Airbnb's sign-in kept its email input under
 * a container at opacity 0 inside a `<label>` that read 電話番号またはメールアドレス
 * (2026-10-23); the person clicks the label and types. The official Bitwarden extension
 * reads only the input's own opacity, so it fills that input too. An input at opacity 0
 * itself, or one whose label is transparent, tiny, before the page's start or shows no
 * text, as a trap, is not.
 */
function revealedByLabel(element: Element): boolean {
  if (!(element instanceof HTMLInputElement) || !fieldInputTypes.has(element.type)) return false;
  const view = element.ownerDocument.defaultView;
  if (!view || Number(view.getComputedStyle(element).opacity) === 0) return false;
  return [...(element.labels ?? [])].some((label) => {
    if (!label.contains(element) || !label.checkVisibility(visibility(true))) return false;
    // A label clipped to a pixel, as a screen-reader-only one, or moved before the page's
    // start shows nothing.
    const rect = label.getBoundingClientRect();
    return (
      rect.width >= 2 &&
      rect.height >= 2 &&
      rect.right + view.scrollX > 0 &&
      rect.bottom + view.scrollY > 0 &&
      collapseText(renderedText(label, fieldNameLimit) ?? "") !== ""
    );
  });
}

/**
 * `checkVisibility`, with an element that is fading in, or an input its label reveals,
 * counted as opaque.
 */
function rendered(element: Element, opacity: boolean): boolean {
  return (
    element.checkVisibility(visibility(opacity)) ||
    (opacity &&
      element.checkVisibility(visibility(false)) &&
      (fadingIn(element) || revealedByLabel(element)))
  );
}

/**
 * Rendered: not hidden by CSS, a closed `<details>` or an attribute (opacity optional; an
 * element still fading in from opacity 0 counts as opaque, {@link fadingIn}, and so does
 * an input transparent only under its own label, {@link revealedByLabel}).
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
    closestAcross(element, "[hidden]") ||
    hiddenByAttribute(element)
  )
    return false;
  if (rendered(element, opacity)) return true;
  const parent = composedParent(element);
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
      (child) => rendered(child, opacity) || view.getComputedStyle(child).display === "contents",
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
 * `skip`, and the elements in `leave`, contribute nothing; a root inside one has none. A
 * line-break opportunity never separates words: a `<wbr>` adds nothing, and format
 * characters such as a zero-width space or soft hyphen are left out, so
 * `taro@<wbr>example.com` and `taro@\u200Bexample.com` read as `taro@example.com`. With `separator`, block and `<br>` boundaries are that character,
 * removed from the text itself, so a caller can split the text into its blocks.
 */
export function renderedText(
  root: Element,
  limit: number,
  {
    everyElement = false,
    skip,
    leave,
    separator = " ",
  }: {
    everyElement?: boolean;
    skip?: string | undefined;
    leave?: ReadonlySet<Element> | undefined;
    separator?: string;
  } = {},
): string | undefined {
  if (!shown(root) || textless.has(root.tagName)) return undefined;
  if (leave?.size)
    for (let node: Element | null = root; node; node = composedParent(node))
      if (leave.has(node)) return undefined;
  const view = root.ownerDocument.defaultView;
  let text = "";
  // `undefined` marks the end of a block, so its text never joins the text after it.
  const pending: (ChildNode | undefined)[] = [];
  // The flat tree, as it renders: a host's shadow tree instead of its children, and a
  // slot's assigned nodes instead of its fallback content (ADR 0070).
  const enqueue = (parent: Element) => {
    const assigned = parent instanceof HTMLSlotElement ? parent.assignedNodes() : [];
    if (assigned.length > 0) {
      for (let at = assigned.length - 1; at >= 0; at--) pending.push(assigned[at] as ChildNode);
      return;
    }
    const from = shadowRootOf(parent) ?? parent;
    for (let child = from.lastChild; child; child = child.previousSibling) pending.push(child);
  };
  enqueue(root);
  while (pending.length > 0 && text.length <= limit) {
    const node = pending.pop();
    if (node === undefined) text += separator;
    else if (node instanceof Text)
      text += node.data.replace(/\p{Cf}+/gu, "").replaceAll(separator, " ");
    else if (
      node instanceof Element &&
      !textless.has(node.tagName) &&
      shown(node) &&
      !(skip && node.matches(skip)) &&
      !leave?.has(node)
    ) {
      if (node instanceof HTMLBRElement) text += separator;
      else if (
        node.localName !== "wbr" &&
        (everyElement || !view?.getComputedStyle(node).display.startsWith("inline"))
      ) {
        text += separator;
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

/**
 * `text` with its full-width and half-width forms (U+3000 and U+FF01 to U+FFEF) folded
 * as Unicode NFKC folds them, and composed, so `ｶﾞ`, `ガ` and `１Ａ`, `1A` fold alike.
 * Other compatibility characters, such as `①` or `ﬁ`, stay as they are.
 */
export function widthFolded(text: string): string {
  return text
    .replace(/[\u3000\uFF01-\uFFEF]/gu, (character) => character.normalize("NFKC"))
    .normalize("NFC");
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
  // A `<base href>` naming another document would make `#` navigate; that is rare.
  const href = parsedHref(link);
  return (
    (href === "" || href.startsWith("#")) && (link.hasAttribute("onclick") || roleButton(link))
  );
}

/**
 * A link's `href` as URL parsing reads it: tabs and newlines go anywhere, C0 controls and
 * spaces at the ends.
 */
const parsedHref = (link: HTMLAnchorElement) =>
  (link.getAttribute("href") ?? "")
    .replace(/[\t\n\r]/gu, "")
    .replace(/^[\0-\x20]+|[\0-\x20]+$/gu, "");

/**
 * Where a link opens: its own `target`, else the document's first `<base target>`, as the
 * browser chooses; `null` when neither names one.
 */
function linkTarget(link: HTMLAnchorElement): string | null {
  return (
    link.getAttribute("target") ??
    link.ownerDocument.querySelector("base[target]")?.getAttribute("target") ??
    null
  );
}

/** Whether a link opens in its own tab: its {@link linkTarget} is none or `_self`. */
export function opensHere(link: HTMLAnchorElement): boolean {
  const target = linkTarget(link);
  return target === null || target.trim().toLowerCase() === "_self";
}

/**
 * True for an `<a href>` that only moves to a fragment of its own document, whose click a
 * page script may handle without any `onclick` attribute or role {@link isScriptButton}
 * sees, as `<a href="#" aria-label="Select Password.">Select</a>` on a page that asks how
 * to confirm the sign-in (ADR 0048 amendment of 2026-10-19): its `href` starts with `#`,
 * it resolves to the document's URL apart from the fragment (a `<base href>` naming
 * another document makes it navigate, so it does not count), it opens in its own tab
 * ({@link opensHere}, also through `<base target>`) and has no `download`. An empty `href`
 * reloads the page and never counts, nor does a script link, nor a fragment that starts
 * with `#/` or `#!`, which a page's router reads as a route (`#/account/delete`), so such
 * a link may go to another page in all but its URL. Only an accessible-name
 * locator, which only a `password` handler's button uses, counts such a link as a button;
 * everywhere else it stays a link.
 */
export function isFragmentButton(element: Element): element is HTMLAnchorElement {
  if (!(element instanceof HTMLAnchorElement)) return false;
  const href = parsedHref(element);
  if (
    !element.hasAttribute("href") ||
    element.hasAttribute("download") ||
    !href.startsWith("#") ||
    href.startsWith("#/") ||
    href.startsWith("#!") ||
    isScriptButton(element) ||
    !opensHere(element)
  )
    return false;
  const url = URL.parse(element.href);
  // Read past any element the document names `URL`.
  const page = URL.parse(Reflect.get(Document.prototype, "URL", element.ownerDocument) as string);
  if (!url || !page) return false;
  url.hash = "";
  page.hash = "";
  return url.href === page.href;
}

const roleButton = (element: Element) =>
  element.getAttribute("role")?.trim().toLowerCase() === "button";

/**
 * Whether an `<a>` without `href`, which never navigates, sets the pointer the page
 * gives clickable things itself, not inheriting it from a clickable card around it:
 * IIJmio's login control is `<a class="pink_btn">ログイン</a>`, whose click a script
 * listener handles with no `onclick` attribute or role (2026-10-23). The cursor is read
 * as computed when asked, so one the page sets only on hover or after the fields are
 * filled does not count.
 */
function pointer(link: HTMLAnchorElement): boolean {
  const view = link.ownerDocument.defaultView;
  const points = (element: Element) =>
    /(?:^|, )pointer$/u.test(view!.getComputedStyle(element).cursor);
  const parent = composedParent(link);
  return view !== null && points(link) && !(parent && points(parent));
}

/**
 * A control that only scripts make clickable: a script link (an `<a>` without `href`
 * that has an `onclick` attribute or `role="button"` or sets a pointer cursor, see
 * {@link pointer}, or an `<a href>` that runs a script, see {@link scriptHref}), or
 * another element with `role="button"`. Form controls, links that navigate and anything
 * inside an `<a href>` (a click there would follow the link, or reach the outer link's
 * script) are not script buttons.
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
      : element.hasAttribute("onclick") || roleButton(element) || pointer(element);
  return closestAcross(element, "a[href]") === null && roleButton(element);
}

/**
 * A script button that text locators name right after native buttons: any `<a>` that
 * {@link isScriptButton} accepts. Other `role="button"` elements are often widgets such
 * as menus and toggles, so a text locator names one only when no button or script link
 * has its text, and the extractor gives one a text locator only inside a login form.
 */
export function isScriptLink(element: Element): element is HTMLAnchorElement {
  return element instanceof HTMLAnchorElement && isScriptButton(element);
}

/** A script button that is no `<a>`: an element such as a `<div>` with `role="button"`. */
export function isRoleButton(element: Element): element is HTMLElement {
  return !(element instanceof HTMLAnchorElement) && isScriptButton(element);
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
  return queryAll(document, "button, input").some((element) => {
    if (!isButton(element)) return false;
    const raw =
      element instanceof HTMLButtonElement
        ? [
            element.textContent ?? "",
            ...queryAll(element, "img[alt]").map((image) => image.getAttribute("alt")!),
          ]
        : [element.type === "image" ? element.alt : element.value];
    return raw.some((part) => collapseText(part) === text);
  });
}

/** The `alt` of the shown images in a `<button>` or link that has no rendered text. */
function imageText(element: Element): string {
  return queryAll(element, "img[alt]")
    .flatMap((image) => (shown(image) ? [image.getAttribute("alt")!] : []))
    .join(" ");
}

/**
 * The text a `{ by: "text" }` locator compares: a rendered button's or script button's
 * text (or, for an image-only `<button>`, its images' `alt`), an input button's
 * `value`, or an image button's `alt`, collapsed. A button that is not rendered, or
 * whose text is empty or longer than 120 code units, has none.
 */
export function buttonText(element: Element): string | undefined {
  if (!(isButton(element) || isScriptButton(element)) || !shown(element)) return undefined;
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
  return firstName([
    () => readNames(labelledBy(element)),
    () => readNames([...(element.labels ?? [])]),
    () => collapseText(element.getAttribute("aria-label") ?? ""),
    () => collapseText(element.placeholder),
  ]);
}

/** The elements `element`'s `aria-labelledby` names, in its order. */
function labelledBy(element: Element): Element[] {
  const tree = treeOf(element);
  return (element.getAttribute("aria-labelledby") ?? "").split(/\s+/u).flatMap((id) => {
    const target = id ? tree.getElementById(id) : null;
    return target ? [target] : [];
  });
}

/**
 * The rendered text of `elements`, collapsed; undefined when it is cut short, which could
 * collapse to a prefix of it.
 */
function readNames(elements: readonly Element[]): string | undefined {
  const readLimit = fieldNameLimit * 4;
  let raw = "";
  for (const part of elements) {
    raw += ` ${renderedText(part, readLimit) ?? ""}`;
    if (raw.length > readLimit) return undefined;
  }
  return collapseText(raw);
}

/**
 * The first name of `sources` that is not empty, when it has at most 120 code units; a
 * name cut short or longer than that gives none, and a later source is never tried in its
 * place.
 */
function firstName(sources: readonly (() => string | undefined)[]): string | undefined {
  for (const source of sources) {
    const name = source();
    if (name === undefined) return undefined;
    if (name) return name.length <= fieldNameLimit ? name : undefined;
  }
  return undefined;
}

/**
 * A control an `{ by: "accessible-name" }` locator may name (ADR 0048 amendment of
 * 2026-10-19): a button, a script button, or a link to a fragment of its own document
 * ({@link isFragmentButton}).
 */
export function isNamedControl(element: Element): element is HTMLElement {
  return isButton(element) || isScriptButton(element) || isFragmentButton(element);
}

/**
 * The accessible name an `{ by: "accessible-name" }` locator compares (ADR 0048 amendment
 * of 2026-10-19): for a shown {@link isNamedControl}, the rendered text of the elements
 * its `aria-labelledby` names, else its `aria-label`, the first that is not empty,
 * collapsed. A control that is not shown, or whose first name is longer than 120 code
 * units, has none; a later source is never tried in its place. Its visible text, an
 * image's `alt` and its `title` are not its name here.
 */
export function controlName(element: Element): string | undefined {
  if (!isNamedControl(element) || !shown(element)) return undefined;
  return firstName([
    () => readNames(labelledBy(element)),
    () => collapseText(element.getAttribute("aria-label") ?? ""),
  ]);
}

/**
 * The visible text of a shown {@link isNamedControl}: a button's {@link buttonText}, or a
 * fragment link's {@link linkText}.
 */
export function controlText(element: Element): string | undefined {
  return buttonText(element) ?? (isFragmentButton(element) ? linkText(element) : undefined);
}

const contentLimit = buttonTextLimit * 4;
/** Elements, HTML or SVG, whose text is code or markup, never a control's text. */
const codeElements = new Set(["script", "style", "template"]);
/** The `<input>` types whose `value` or `alt` is the text they show. */
const labelInputTypes = new Set([...buttonInputTypes, "reset"]);

/**
 * All the text a control holds, for the check that nothing in it names another way or
 * task than its accessible name does (`namesPasswordControl`, ADR 0048 amendment of
 * 2026-10-19): the text of `element` and its descendants, shown or not (`aria-hidden`
 * ones and those in open or closed shadow roots too), every element boundary separating
 * words, the `alt` of its images and image inputs and the `value` of its other input
 * buttons, the control's own included, collapsed. Scripts, styles and templates add
 * nothing. `""` when it holds no text; `undefined` when the text is longer than 480 code
 * units, which the check counts as not read in full and so refuses, where
 * {@link controlText} would have no text.
 */
export function controlContent(element: Element): string | undefined {
  let content = "";
  const pending: Node[] = [element];
  while (pending.length > 0) {
    const node = pending.pop()!;
    let part = "";
    if (node instanceof Text) part = node.data;
    else if (node instanceof Element) {
      if (codeElements.has(node.localName)) continue;
      if (node instanceof HTMLImageElement) part = node.alt;
      else if (node instanceof HTMLInputElement && labelInputTypes.has(node.type))
        part = node.type === "image" ? node.alt : node.value;
      const root = node instanceof HTMLElement ? shadowRootOf(node) : undefined;
      const children = [...(root?.childNodes ?? []), ...node.childNodes];
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]!);
    }
    const text = collapseText(part);
    if (text) content = content ? `${content} ${text}` : text;
    if (content.length > contentLimit) return undefined;
  }
  return content;
}
