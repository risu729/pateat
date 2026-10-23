import type { LoginMarkerTarget } from "@pateat/contracts";
import {
  buttonText,
  controlName,
  fieldName,
  hasNativeButton,
  isButton,
  isRoleButton,
  isScriptButton,
  isScriptLink,
  linkText,
} from "./text";
import { queryAll } from "./shadow";

const attributes = { id: "id", name: "name", "test-id": "data-testid" } as const;
/** Every element an `accessible-name` locator may name ({@link isNamedControl}). */
export const namedControls = "button, input, a, [role]";

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
  return queryAll(document, "a[href]").filter(
    (link): link is HTMLAnchorElement => linkPath(link) === path,
  );
}

/**
 * The input's `autocomplete` attribute tokens, lowercased. Read from the attribute, as
 * Chromium's `autocomplete` property is empty for a token list that is not a valid
 * autofill detail, such as `off one-time-code`.
 */
export const autocompleteTokens = (input: Pick<Element, "getAttribute">) =>
  (input.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/u).filter(Boolean);

/**
 * Whether the element is rendered and not hidden by its own or an ancestor's style.
 * Content the browser skips with `content-visibility: hidden`, as inside a closed
 * `<details>` or under `hidden="until-found"`, still has a box but counts as hidden;
 * content that `content-visibility: auto` skips off screen counts as shown.
 */
export function visible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return (
    element.isConnected &&
    !element.hidden &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getClientRects().length > 0 &&
    element.checkVisibility()
  );
}

/**
 * Of several elements one attribute or `autocomplete` locator names, only the
 * {@link visible} ones, as a hidden copy of a form that shares its fields' names (owner,
 * 2026-10-22, #832); without `hidden`, which a signed-in marker and the elements it needs
 * missing ask for (ADR 0029), since those count hidden elements. One element is kept as it
 * is, so a step's element the page has not shown yet is still found hidden.
 */
const shownAmong = (found: Element[], hidden: boolean) =>
  hidden || found.length < 2
    ? found
    : found.filter((element) => element instanceof HTMLElement && visible(element));

/**
 * Every element a locator names. Attribute locators compare the attribute string, so a
 * value never becomes a selector; an `autocomplete` locator matches inputs whose
 * attribute holds the token. Text locators compare {@link buttonText}: native buttons
 * first, and only when none carries the text, even hidden, links that run a script
 * ({@link isScriptLink}), so a script link never makes a native button's locator
 * ambiguous. When no native or script-link button has the text, a lookup without `links`
 * compares other `role="button"` elements ({@link isRoleButton}), such as a login form's
 * `<div>` submit, and one with `links` compares other links' {@link linkText} instead (an
 * account switch or a completion marker is often a link), so a widget elsewhere on the
 * page never stands in for a link. A `label` locator matches the shown fillable inputs
 * whose {@link fieldName} equals the value (ADR 0037); a hidden input never does. An
 * `accessible-name` locator matches the shown controls, buttons, script buttons and links
 * to a fragment of their own document, whose {@link controlName} equals the value (ADR
 * 0048 amendment of 2026-10-19), never a field and never a hidden control. When an
 * attribute or `autocomplete` locator names several elements, only the visible ones count,
 * unless `hidden` asks for every one (`shownAmong`, ADR 0037). A
 * signed-in marker's `href` locator matches the links whose {@link linkPath} equals the
 * value, whatever their query or fragment (ADR 0029). Every locator looks in the
 * document and in every shadow tree in it, open or closed, so an ID or name counts once
 * for the whole page (ADR 0070). Callers reject anything but exactly one match rather
 * than taking the first.
 */
export function findTargets(
  document: Document,
  target: LoginMarkerTarget,
  { links = false, hidden = false }: { links?: boolean; hidden?: boolean } = {},
): Element[] {
  if (target.by === "href") return linksTo(document, target.value);
  if (target.by === "text") {
    const elements = queryAll(document, "button, input, a");
    const named = elements.filter((element) => buttonText(element) === target.value);
    const linkMatches = () =>
      elements.filter((element) => !isScriptLink(element) && linkText(element) === target.value);
    const native = named.filter(isButton);
    if (native.length > 0) return native;
    // Only script buttons remain; a hidden native button with the text holds them back.
    if (hasNativeButton(document, target.value)) return links ? linkMatches() : [];
    if (named.length > 0) return named;
    if (links) return linkMatches();
    return queryAll(document, "[role]").filter(
      (element) => isRoleButton(element) && buttonText(element) === target.value,
    );
  }
  if (target.by === "label")
    return queryAll(document, "input").filter((input) => fieldName(input) === target.value);
  if (target.by === "accessible-name")
    return queryAll(document, namedControls).filter(
      (element) => controlName(element) === target.value,
    );
  if (target.by === "autocomplete")
    return shownAmong(
      queryAll(document, "input[autocomplete]").filter((input) =>
        autocompleteTokens(input).includes(target.value),
      ),
      hidden,
    );
  const attribute = attributes[target.by];
  return shownAmong(
    queryAll(document, `[${attribute}]`).filter(
      (element) => element.getAttribute(attribute) === target.value,
    ),
    hidden,
  );
}
