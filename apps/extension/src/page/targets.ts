import type { LoginTarget } from "@pateat/contracts";
import { buttonText, fieldName, hasNativeButton, isButton, isScriptLink, linkText } from "./text";

const attributes = { id: "id", name: "name", "test-id": "data-testid" } as const;

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
 * equals the value (ADR 0037); a hidden input never does. Callers reject anything but
 * exactly one match rather than taking the first.
 */
export function findTargets(
  document: Document,
  target: LoginTarget,
  { links = false }: { links?: boolean } = {},
): Element[] {
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
