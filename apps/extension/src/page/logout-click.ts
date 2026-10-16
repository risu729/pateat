// A click on a control that logs out (ADR 0021 D, owner 2026-10-16): read in the page, so
// only the fact that one was clicked leaves it, never its text.
import { setsPointer } from "./account-list";
import { collapseText, isButton, isScriptButton, renderedText } from "./text";

/** Roles whose element is a control a click activates. */
const controlRoles = new Set([
  "button",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
]);
/** A control's name is a short label, not a paragraph. */
const nameLimit = 64;
const readLimit = nameLimit * 4;
/** How far up from the clicked element its control is looked for. */
const controlDepth = 8;
/** How far up a control without a name of its own looks for the text beside it. */
const besideDepth = 3;
/** At most this many elements inside a control are read for their names, as an icon's. */
const innerLimit = 16;

/** "Log out", "logout", "sign out", "log off" and the like, as whole words. */
const logoutWords = /(?:^| )(?:log|sign) ?(?:out|off)(?: |$)/u;
const logoutParts = ["ログアウト", "サインアウト", "ログオフ", "サインオフ"];
/** Words of a logout of other sessions, such as "Log out of other devices". */
const otherWords = new Set(["other", "others", "another"]);
const otherParts = ["他の", "ほかの", "他端末", "別の"];

/**
 * What a name says (ADR 0021 D): `logout` for a word that logs out, `elsewhere` when it
 * also names other sessions or devices, which logs those out and not this one, else
 * nothing. English words match whole, Japanese parts anywhere; no site name counts.
 */
export function logoutName(name: string): "logout" | "elsewhere" | undefined {
  const text = name.normalize("NFKC");
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!logoutWords.test(words) && !logoutParts.some((part) => text.includes(part)))
    return undefined;
  const elsewhere =
    words.split(" ").some((word) => otherWords.has(word)) ||
    otherParts.some((part) => text.includes(part));
  return elsewhere ? "elsewhere" : "logout";
}

/**
 * A control a click activates: a native or script button, a link, an element with a
 * control role or a `tabindex` of 0 or more, or the element that sets `cursor: pointer`.
 */
function isControl(element: Element): element is HTMLElement {
  if (!(element instanceof HTMLElement)) return false;
  if (isButton(element) || isScriptButton(element)) return true;
  if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) return true;
  const role = element.getAttribute("role")?.trim().toLowerCase().split(/\s+/u)[0];
  if (role && controlRoles.has(role)) return true;
  if (element.hasAttribute("tabindex") && element.tabIndex >= 0) return true;
  return setsPointer(element);
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

/**
 * The names a control gives itself, each collapsed, as the observation names a control
 * (ADR 0037): the text of the elements its `aria-labelledby` names, its `aria-label`, its
 * rendered text (an input button's `value` or `alt`), its `title`, the text its
 * `aria-describedby` names, and what the elements inside it are named by (an image's
 * `alt`, an SVG `<title>`, an `aria-label` or a `title`, as an icon's). None when its
 * rendered text is longer than a label, as a container of several controls is.
 */
function ownNames(control: HTMLElement): string[] {
  const text =
    control instanceof HTMLInputElement
      ? control.type === "image"
        ? control.alt
        : control.value
      : renderedText(control, readLimit);
  if (text === undefined || collapseText(text).length > nameLimit) return [];
  const inner = [...control.querySelectorAll("img[alt], svg title, [aria-label], [title]")]
    .slice(0, innerLimit)
    .flatMap((element) => [
      element instanceof HTMLImageElement ? element.alt : "",
      element.tagName.toLowerCase() === "title" ? (element.textContent ?? "") : "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("title") ?? "",
    ]);
  return [
    referencedText(control, "aria-labelledby"),
    control.getAttribute("aria-label") ?? "",
    text,
    control.title,
    referencedText(control, "aria-describedby"),
    ...inner,
  ]
    .map(collapseText)
    .filter((name) => name !== "" && name.length <= nameLimit);
}

/** Whether `node` is a control or holds one, so its text names that control instead. */
const holdsControl = (node: Node) =>
  node instanceof Element &&
  (isControl(node) ||
    [...node.querySelectorAll("*")].slice(0, innerLimit * 4).some((inner) => isControl(inner)));

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
        const name = collapseText(raw);
        if (!name) continue;
        if (name.length <= nameLimit) names.push(name);
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
 * none that names a logout of other sessions.
 */
export function clickedLogout(event: Event): boolean {
  const control = event
    .composedPath()
    .filter((target): target is Element => target instanceof Element)
    .slice(0, controlDepth)
    .find((element) => isControl(element));
  if (!control) return false;
  const own = ownNames(control);
  const read = (own.length ? own : besideNames(control)).map(logoutName);
  return read.includes("logout") && !read.includes("elsewhere");
}
