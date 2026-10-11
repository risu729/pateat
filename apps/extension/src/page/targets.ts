import type { LoginTarget } from "@pateat/contracts";
import { buttonText, hasNativeButton, isButton, isScriptLink, linkText } from "./text";

const attributes = { id: "id", name: "name", "test-id": "data-testid" } as const;

/**
 * Every element a locator names. Attribute locators compare the attribute string, so a
 * value never becomes a selector. Text locators compare {@link buttonText}: native
 * buttons first, and only when none carries the text, even hidden, links that run a script
 * ({@link isScriptLink}), so a script link never makes a native button's locator
 * ambiguous. With `links`, and only when no button of either kind shows the text, they
 * compare other links' {@link linkText} (an account switch is often a link). Callers
 * reject anything but exactly one match rather than taking the first.
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
    if (native.length > 0 || hasNativeButton(document, target.value)) return native;
    if (named.length > 0 || !links) return named;
    return elements.filter(
      (element) => !isScriptLink(element) && linkText(element) === target.value,
    );
  }
  const attribute = attributes[target.by];
  return [...document.querySelectorAll(`[${attribute}]`)].filter(
    (element) => element.getAttribute(attribute) === target.value,
  );
}
