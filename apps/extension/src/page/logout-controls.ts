// The controls of an account switch's logout (ADR 0063), read in the page: which control
// logs out by its words, so the page goes to the model only when that is unclear, and the
// menu items and icon-only controls a logout recipe may name.
import {
  logoutRisk,
  safeLogoutName,
  type LoginMarkerTarget,
  type LogoutPurpose,
} from "@pateat/contracts";
import { setsPointer } from "./account-list";
import { findTargets } from "./targets";
import { collapseText, isButton, isScriptButton, renderedText, shown } from "./text";

/** Roles whose element is a control a click activates. */
const controlRoles = new Set(["button", "link", "menuitem", "menuitemradio", "option", "tab"]);
/** Roles of a control that sets a state, such as "Log out when I close the browser". */
const settingRoles = new Set(["checkbox", "switch", "radio", "menuitemcheckbox", "slider"]);
/** A control's name is a short label, not a paragraph. */
const nameLimit = 64;
const readLimit = nameLimit * 4;
/** At most this many elements inside an element are read: a control's icons. */
const innerLimit = 64;
/** An `aria-label` or `title` an accessible-name locator compares is at most this long. */
const accessibleNameLimit = 120;

/** "Log out", "logout", "sign out", "log off" and the like, as whole words. */
const logoutWords = /(?:^| )(?:log|sign) ?(?:out|off)(?: |$)/u;
const logoutParts = ["ログアウト", "サインアウト", "ログオフ", "サインオフ"];
/**
 * What a name says: `logout` for words that log out, `elsewhere` when they log other
 * devices, sessions or accounts out instead, or all of them, `destructive` when they also
 * delete, close or cancel the account ({@link logoutRisk}), else nothing. English words
 * match whole after NFKC, Japanese parts anywhere; no site name counts. "Sign out and use
 * another account" logs this session out, so it counts.
 */
export function logoutName(name: string): "logout" | "elsewhere" | "destructive" | undefined {
  const text = name.normalize("NFKC");
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!logoutWords.test(words) && !logoutParts.some((part) => text.includes(part)))
    return undefined;
  return logoutRisk(name) ?? "logout";
}

const roleOf = (element: Element) =>
  element.getAttribute("role")?.trim().toLowerCase().split(/\s+/u)[0];

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

/**
 * A control a click activates: a native or script button, a link, an element with a
 * control role or a `tabindex` of 0 or more, or one that sets `cursor: pointer`. A field,
 * a `<label>` or a control that sets a state is none.
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
 * The names a control gives itself, each collapsed, as an accessible name is computed: the
 * first of the text its `aria-labelledby` names, its `aria-label`, its rendered text (an
 * input button's `value` or `alt`) and its `title`; only when it has none of them, the
 * names of its icons (an image's `alt`, an SVG `<title>`, an `aria-label` or a `title`).
 * Empty when its name or rendered text is longer than a label, as a container's is.
 */
function ownNames(control: HTMLElement): string[] {
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
  return [...inside(control)].flatMap((element) =>
    [
      element instanceof HTMLImageElement ? element.alt : "",
      element.tagName.toLowerCase() === "title" ? (element.textContent ?? "") : "",
      element.getAttribute("aria-label") ?? "",
      element.getAttribute("title") ?? "",
    ].flatMap((name) => usable(name) ?? []),
  );
}

const controlSelector = "button, input, a[href], [role], [tabindex], [onclick]";

/** What holds an open menu, as a logout's menu opens one. */
export const openMenus = "[role='menu' i], [role='menubar' i], [popover], details[open]";
const layers = `${openMenus}, dialog, [role='dialog' i], [role='alertdialog' i], [role='listbox' i]`;
/**
 * How many dialogs and menus the page shows, so a click that opened one, as a sign-out's
 * confirmation, is told from one that did nothing.
 */
export function shownLayers(document: Document): number {
  return [...document.querySelectorAll(layers)].filter((element) => shown(element)).length;
}

/**
 * The page's one shown control whose own name says it logs out of this site, as "Log out"
 * or 「ログアウト」, and none that names logging other devices, sessions or accounts, or all
 * of them, out, or deleting, closing or cancelling the account:
 * `none` when no control says so, `ambiguous` when several do, so the page goes to the
 * model instead. Of a control inside another that says the same, the inner one counts.
 */
export function localLogoutControl(document: Document): HTMLElement | "none" | "ambiguous" {
  const found = [...document.querySelectorAll(controlSelector)].filter(
    (element): element is HTMLElement => {
      if (!isControl(element) || !shown(element)) return false;
      const read = ownNames(element).map(logoutName);
      return (
        read.includes("logout") &&
        read.every((name) => name === "logout" || !name) &&
        safeLogoutControl(element, "logout")
      );
    },
  );
  const innermost = found.filter((element) =>
    found.every((other) => other === element || !element.contains(other)),
  );
  if (innermost.length === 0) return "none";
  return innermost.length === 1 ? innermost[0]! : "ambiguous";
}

/**
 * A menu item a logout may click that the observation describes no other way: an element
 * with `role="menuitem"` that is no button, link or form control and sits in no link.
 */
export function isMenuItem(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    roleOf(element) === "menuitem" &&
    !isButton(element) &&
    !isScriptButton(element) &&
    !(element instanceof HTMLAnchorElement) &&
    !(element instanceof HTMLInputElement) &&
    element.closest("a[href]") === null
  );
}

/** A menu item's rendered text, collapsed, when it is a short label. */
export function menuItemText(element: HTMLElement): string | undefined {
  if (!shown(element)) return undefined;
  const text = renderedText(element, readLimit);
  const collapsed = text === undefined ? "" : collapseText(text);
  return collapsed && collapsed.length <= nameLimit ? collapsed : undefined;
}

/**
 * The name a logout's `accessible-name` locator compares, for a shown button, link or menu
 * item: the text its `aria-labelledby` names, else its `aria-label`, else its `title`,
 * collapsed; none past {@link accessibleNameLimit} code units.
 */
export function logoutControlName(element: Element): string | undefined {
  if (
    !(element instanceof HTMLElement) ||
    !shown(element) ||
    !(
      isButton(element) ||
      isScriptButton(element) ||
      (element instanceof HTMLAnchorElement && element.hasAttribute("href")) ||
      isMenuItem(element)
    )
  )
    return undefined;
  for (const name of [
    () => referencedText(element, "aria-labelledby"),
    () => element.getAttribute("aria-label") ?? "",
    () => element.getAttribute("title") ?? "",
  ]) {
    const read = collapseText(name());
    if (read) return read.length <= accessibleNameLimit ? read : undefined;
  }
  return undefined;
}

/**
 * The elements a logout click's locator names: as a login step's (buttons, then links by
 * text), plus menu items by their text when no button or link has it, and any of them by
 * {@link logoutControlName} for an `accessible-name` locator.
 */
export function findLogoutTargets(document: Document, target: LoginMarkerTarget): Element[] {
  if (target.by === "accessible-name")
    return [...document.querySelectorAll("button, input, a, [role], [aria-label], [title]")].filter(
      (element) => logoutControlName(element) === target.value,
    );
  const found = findTargets(document, target, { links: true });
  if (found.length || target.by !== "text") return found;
  return [...document.querySelectorAll("[role]")].filter(
    (element) => isMenuItem(element) && menuItemText(element) === target.value,
  );
}

/**
 * Whether an account switch may press this control for `purpose` (ADR 0063): none of the
 * names it gives itself, its menu text or its accessible name says it deletes, closes or
 * cancels the account, and for a logout or confirmation none says it logs out elsewhere or
 * everywhere ({@link safeLogoutName}). Checked before every click, also a stored or a
 * model's one.
 */
export function safeLogoutControl(element: HTMLElement, purpose: LogoutPurpose): boolean {
  const names = [
    ...ownNames(element),
    ...(isMenuItem(element) ? [menuItemText(element) ?? ""] : []),
    logoutControlName(element) ?? "",
  ].filter(Boolean);
  return names.every((name) => safeLogoutName(name, purpose));
}
