// A click on a control that logs out (ADR 0021 D, owner 2026-10-16): read in the page, so
// only the fact that one was clicked leaves it, never its text.
import { setsPointer } from "./account-list";
import { collapseText, isButton, isScriptButton, renderedText } from "./text";

/** Roles whose element is a control a click activates. */
const controlRoles = new Set(["button", "link", "menuitem", "menuitemradio", "option", "tab"]);
/** Roles of a control that sets a state, such as "Log out when I close the browser". */
const settingRoles = new Set(["checkbox", "switch", "radio", "menuitemcheckbox", "slider"]);
/** A control's name is a short label, not a paragraph. */
const nameLimit = 64;
const readLimit = nameLimit * 4;
/** How far up from the clicked element its control is looked for. */
const controlDepth = 8;
/** How far up a control without a name of its own looks for the text beside it. */
const besideDepth = 3;
/** At most this many elements inside an element are read: a control's icons, a sibling. */
const innerLimit = 64;

/** "Log out", "logout", "sign out", "log off" and the like, as whole words. */
const logoutWords = /(?:^| )(?:log|sign) ?(?:out|off)(?: |$)/u;
const logoutParts = ["ログアウト", "サインアウト", "ログオフ", "サインオフ"];
/**
 * Words of a logout of other devices, sessions or accounts, such as "Log out of other
 * devices", "Sign out everywhere else" or 「このデバイス以外からログアウト」: "other" and
 * the like within three words before a word for a device, session or browser, or
 * "other" before an account. "Sign out and use another account" logs this session out,
 * so it counts.
 */
const otherWords = new Set(["other", "others", "another"]);
const placeWords = /^(?:devices?|sessions?|browsers?|computers?|phones?|places?|locations?)$/u;
const accountWords = /^accounts?$/u;
const elsewherePhrases = /(?:^| )(?:(?:except|but) this|everywhere else)(?: |$)/u;
const otherPlaces =
  /(?:他|ほか|別)の[^、。]{0,8}?(?:端末|デバイス|セッション|ブラウザ|場所|機器)|(?:他|ほか)の[^、。]{0,8}?アカウント|他端末|以外/u;

/**
 * What a name says (ADR 0021 D): `logout` for words that log out, `elsewhere` when they
 * log other devices, sessions or accounts out instead, else nothing. English words match
 * whole, Japanese parts anywhere; no site name counts.
 */
export function logoutName(name: string): "logout" | "elsewhere" | undefined {
  const text = name.normalize("NFKC");
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!logoutWords.test(words) && !logoutParts.some((part) => text.includes(part)))
    return undefined;
  const list = words.split(" ");
  const elsewhere =
    list.some((word, index) => {
      if (!otherWords.has(word)) return false;
      const next = list.slice(index + 1, index + 4);
      return (
        next.some((later) => placeWords.test(later)) ||
        (word !== "another" && next.some((later) => accountWords.test(later)))
      );
    }) ||
    elsewherePhrases.test(words) ||
    otherPlaces.test(text);
  return elsewhere ? "elsewhere" : "logout";
}

const roleOf = (element: Element) =>
  element.getAttribute("role")?.trim().toLowerCase().split(/\s+/u)[0];

/**
 * A control a click activates: a native or script button, a link, an element with a
 * control role or a `tabindex` of 0 or more, or the element that sets `cursor: pointer`.
 * A field, a `<label>` or a control that sets a state is none: its words describe a
 * value or a setting, not an action.
 */
function isControl(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement) || isSetting(element)) return false;
  if (isButton(element) || isScriptButton(element)) return true;
  if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) return true;
  const role = roleOf(element);
  if (role && controlRoles.has(role)) return true;
  if (element.hasAttribute("tabindex") && element.tabIndex >= 0) return true;
  return setsPointer(element);
}

/** A field, a `<label>` or a control that sets a state, which a click does not act on. */
function isSetting(element: Element): boolean {
  if (isButton(element)) return false;
  const role = roleOf(element);
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLLabelElement ||
    (element instanceof HTMLElement && element.isContentEditable) ||
    (role !== undefined && settingRoles.has(role))
  );
}

/** The text of the elements an attribute such as `aria-labelledby` names. */
function referencedText(element: HTMLElement, attribute: string): string {
  const root = element.getRootNode();
  if (!(root instanceof Document || root instanceof ShadowRoot)) return "";
  return (element.getAttribute(attribute) ?? "")
    .split(/\s+/u)
    .filter(Boolean)
    .map((id) => root.getElementById(id)?.textContent ?? "")
    .join(" ");
}

/** Up to {@link innerLimit} elements inside `root`, in document order. */
function* inside(root: Node): Generator<Element> {
  const walker = root.ownerDocument!.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let count = 0; count < innerLimit && walker.nextNode(); count += 1)
    yield walker.currentNode as Element;
}

const usable = (name: string) => {
  const collapsed = collapseText(name);
  return collapsed && collapsed.length <= nameLimit ? collapsed : undefined;
};

/**
 * The names a control gives itself, each collapsed, in the order an accessible name is
 * computed and the observation names a control (ADR 0037): the first of the text its
 * `aria-labelledby` names, its `aria-label`, its rendered text (an input button's `value`
 * or `alt`) and its `title`; only when it has none of them, the names of the elements
 * inside it (an image's `alt`, an SVG `<title>`, an `aria-label` or a `title`, as an
 * icon's) and the text its `aria-describedby` names. Empty when its name, or its
 * rendered text, is longer than a label, as a container of several controls is: such a
 * control is named, just not by a label. `undefined` when it names nothing at all.
 */
function ownNames(control: HTMLElement): string[] | undefined {
  const text =
    control instanceof HTMLInputElement
      ? control.type === "image"
        ? control.alt
        : control.value
      : renderedText(control, readLimit);
  if (text === undefined || collapseText(text).length > nameLimit) return [];
  for (const name of [
    () => referencedText(control, "aria-labelledby"),
    () => control.getAttribute("aria-label") ?? "",
    () => text,
    () => control.title,
  ]) {
    const read = collapseText(name());
    if (read) return read.length <= nameLimit ? [read] : [];
  }
  const inner = [...inside(control)].flatMap((element) => [
    element instanceof HTMLImageElement ? element.alt : "",
    element.tagName.toLowerCase() === "title" ? (element.textContent ?? "") : "",
    element.getAttribute("aria-label") ?? "",
    element.getAttribute("title") ?? "",
  ]);
  const names = [...inner, referencedText(control, "aria-describedby")].flatMap(
    (name) => usable(name) ?? [],
  );
  return names.length ? names : undefined;
}

/** Whether `node` is a control or holds one, so its text names that control instead. */
const holdsControl = (node: Node) =>
  node instanceof Element && (isControl(node) || [...inside(node)].some(isControl));

/**
 * The text beside a control that names nothing itself, as an icon button beside the
 * words "Log out": the nearest text before and after it, at most three levels up, never
 * across another control or out of a form.
 */
function besideNames(control: HTMLElement): string[] {
  let node: Element | null = control;
  for (let depth = 0; node && depth <= besideDepth; depth += 1) {
    if (node instanceof HTMLFormElement || node === node.ownerDocument.body) return [];
    const names: string[] = [];
    for (const next of [(at: Node) => at.previousSibling, (at: Node) => at.nextSibling])
      for (let sibling = next(node); sibling; sibling = next(sibling)) {
        if (holdsControl(sibling)) break;
        const raw =
          sibling instanceof Text
            ? sibling.data
            : sibling instanceof Element
              ? (renderedText(sibling, readLimit) ?? "")
              : "";
        if (!collapseText(raw)) continue;
        const name = usable(raw);
        if (name) names.push(name);
        break;
      }
    if (names.length) return names;
    node = node.parentElement;
  }
  return [];
}

/**
 * Whether a click activated a control that logs out (ADR 0021 D, owner 2026-10-16): the
 * nearest control around the clicked element (in an open shadow root too) has a name, or,
 * naming nothing itself, text beside it, that {@link logoutName} reads as a logout, and
 * none that names a logout of other devices or sessions.
 */
export function clickedLogout(event: Event): boolean {
  // A click on a field, a label or a setting, or inside one, sets a value, even inside a
  // clickable row whose text says log out ("Log out when I close the browser").
  const path = event
    .composedPath()
    .filter((target): target is Element => target instanceof Element)
    .slice(0, controlDepth);
  const control = path.find((element) => isSetting(element) || isControl(element));
  if (!control || !isControl(control)) return false;
  const read = (ownNames(control) ?? besideNames(control)).map(logoutName);
  return read.includes("logout") && !read.includes("elsewhere");
}
