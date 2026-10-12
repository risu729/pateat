// The content script's side of a site's sign-in entry (ADR 0031): what the page's links
// name, whether a link may be pressed, and whether the page after the press is a sign-up
// form. Which hosts are on the page's site is the worker's answer; nothing here reads a
// public suffix list.
import { namedHosts } from "../login/entry";
import { visible } from "./code-submission";
import { autocompleteTokens } from "./targets";
import { collapseText, isScriptLink, renderedText, shown } from "./text";

/** Hosts the worker is asked about at most; a link to any other counts as off-site. */
export const MAX_ENTRY_HOSTS = 256;
const textLimit = 480;

/** The link's parsed `href`, or nothing for a link whose `href` does not parse. */
export function linkUrl(link: HTMLAnchorElement): URL | undefined {
  try {
    return new URL(link.href);
  } catch {
    return undefined;
  }
}

/**
 * The hosts the page's URL and its links name: each navigating `<a href>` link's host and
 * the hosts its query values and the page's name, at most {@link MAX_ENTRY_HOSTS}.
 */
export function entryHosts(document: Document): string[] {
  const links = [...document.querySelectorAll("a[href]")].flatMap((link) => {
    const url = link instanceof HTMLAnchorElement && !isScriptLink(link) && linkUrl(link);
    return url ? [url] : [];
  });
  return namedHosts(new URL(document.location.href), links, MAX_ENTRY_HOSTS);
}

/**
 * Text a control renders itself, collapsed: an image's `alt` does not count, so a link
 * that shows only an icon has none (ADR 0031).
 */
export function renderedControlText(element: HTMLElement): string | undefined {
  const raw =
    element instanceof HTMLInputElement
      ? element.type === "image"
        ? ""
        : element.value
      : (renderedText(element, textLimit) ?? "");
  const text = collapseText(raw);
  return text || undefined;
}

/** Why an element may not be pressed as a site's sign-in entry, before its `href` is read. */
export type EntryElementRefusal = "not-link" | "script-link" | "hidden" | "no-text" | "new-window";

/**
 * Whether an element may be pressed as an entry, apart from where its `href` leads: only a
 * shown `<a href>` link that follows its `href` (never a button or a script link), with
 * rendered text, and without a `target` other than `_self`, so a press never opens a tab
 * or window.
 */
export function entryElementRefusal(element: Element): EntryElementRefusal | undefined {
  if (!(element instanceof HTMLAnchorElement) || !element.hasAttribute("href")) return "not-link";
  // Read before `isScriptLink`, whose guard narrows a link that is not one to `never`.
  const target = element.getAttribute("target");
  if (isScriptLink(element)) return "script-link";
  if (!shown(element) || !visible(element)) return "hidden";
  if (!renderedControlText(element)) return "no-text";
  if (target !== null && target.trim().toLowerCase() !== "_self") return "new-window";
  return undefined;
}

/**
 * A sign-up form on the page after the press (ADR 0031): a shown `new-password` input
 * beside a second shown password input in the same form, or two or more shown password
 * inputs in one form. Inputs outside any form count as one form.
 */
export function showsSignUp(document: Document): boolean {
  const inputs = [...document.querySelectorAll("input")].filter(visible);
  const forms = new Set(inputs.map((input) => input.form));
  return [...forms].some((form) => {
    const own = inputs.filter((input) => input.form === form);
    const passwords = own.filter((input) => input.type === "password");
    const fresh = own.filter((input) => autocompleteTokens(input).includes("new-password"));
    return (
      passwords.length >= 2 ||
      fresh.some((input) => passwords.some((password) => password !== input))
    );
  });
}
