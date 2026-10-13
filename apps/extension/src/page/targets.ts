import type { LoginMarkerTarget } from "@pateat/contracts";
import {
  buttonText,
  fieldName,
  hasNativeButton,
  isButton,
  isScriptButton,
  isScriptLink,
  linkText,
} from "./text";

const attributes = { id: "id", name: "name", "test-id": "data-testid" } as const;

/**
 * A link's path on its document's own origin (ADR 0029): none for a script link, a link
 * to another origin, or one whose `href` is empty or only a fragment (`#top`).
 */
export function linkPath(element: Element): string | undefined {
  if (
    !(element instanceof HTMLAnchorElement) ||
    isScriptButton(element) ||
    element.origin !== element.ownerDocument.location?.origin
  )
    return undefined;
  const href = element.getAttribute("href")?.trim();
  return href === undefined || href === "" || href.startsWith("#") ? undefined : element.pathname;
}

/** The `<a href>` links of `document` whose {@link linkPath} is `path`. */
export function linksTo(document: Document, path: string): HTMLAnchorElement[] {
  return [...document.querySelectorAll("a[href]")].filter(
    (link): link is HTMLAnchorElement => linkPath(link) === path,
  );
}

/** The input's `autocomplete` tokens, lowercased. */
export const autocompleteTokens = (input: Element) =>
  (input.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/u).filter(Boolean);

/**
 * Every element a locator names. Attribute locators compare the attribute string, so a
 * value never becomes a selector; an `autocomplete` locator matches inputs whose
 * attribute holds the token. Text locators compare {@link buttonText}: native
 * buttons first, and only when none carries the text, even hidden, links that run a script
 * ({@link isScriptLink}), so a script link never makes a native button's locator
 * ambiguous. With `links`, and only when no button of either kind shows the text, they
 * compare other links' {@link linkText} (an account switch or a completion marker is often
 * a link). A `label` locator matches the shown fillable inputs whose {@link fieldName}
 * equals the value (ADR 0037); a hidden input never does. A signed-in marker's `href`
 * locator matches the links whose {@link linkPath} equals the value, whatever their query
 * or fragment (ADR 0029). Callers reject anything but exactly one match rather than
 * taking the first.
 */
export function findTargets(
  document: Document,
  target: LoginMarkerTarget,
  { links = false }: { links?: boolean } = {},
): Element[] {
  if (target.by === "href") return linksTo(document, target.value);
  if (target.by === "text") {
    const elements = [...document.querySelectorAll("button, input, a")];
    const named = elements.filter((element) => buttonText(element) === target.value);
    const native = named.filter(isButton);
    if (native.length > 0) return native;
    // Only script links remain; a hidden native button with the text holds them back.
    const scripted = hasNativeButton(document, target.value) ? [] : named;
    if (scripted.length > 0 || !links) return scripted;
    return elements.filter(
      (element) => !isScriptLink(element) && linkText(element) === target.value,
    );
  }
  if (target.by === "label")
    return [...document.querySelectorAll("input")].filter(
      (input) => fieldName(input) === target.value,
    );
  if (target.by === "autocomplete")
    return [...document.querySelectorAll("input[autocomplete]")].filter((input) =>
      autocompleteTokens(input).includes(target.value),
    );
  const attribute = attributes[target.by];
  return [...document.querySelectorAll(`[${attribute}]`)].filter(
    (element) => element.getAttribute(attribute) === target.value,
  );
}
