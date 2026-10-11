import type { LoginTarget } from "@pateat/contracts";
import { buttonText, linkText } from "./text";

const attributes = { id: "id", name: "name", "test-id": "data-testid" } as const;

/**
 * Every element a locator names. Attribute locators compare the attribute string, so a
 * value never becomes a selector; text locators compare {@link buttonText} (buttons and
 * links that run a script), and with `links` also {@link linkText} (an account switch
 * is often a link). Callers reject
 * anything but exactly one match rather than taking the first.
 */
export function findTargets(
  document: Document,
  target: LoginTarget,
  { links = false }: { links?: boolean } = {},
): Element[] {
  if (target.by === "text")
    return [...document.querySelectorAll("button, input, a")].filter(
      (element) =>
        (buttonText(element) ?? (links ? linkText(element) : undefined)) === target.value,
    );
  const attribute = attributes[target.by];
  return [...document.querySelectorAll(`[${attribute}]`)].filter(
    (element) => element.getAttribute(attribute) === target.value,
  );
}
