import type { LoginTarget } from "@pateat/contracts";
import { buttonText, isButton } from "./text";

const attributes = { id: "id", name: "name", "test-id": "data-testid" } as const;

/**
 * Every element a locator names. Attribute locators compare the attribute string, so a
 * value never becomes a selector; text locators compare {@link buttonText}. Callers
 * reject anything but exactly one match rather than taking the first.
 */
export function findTargets(document: Document, target: LoginTarget): Element[] {
  if (target.by === "text")
    return [...document.querySelectorAll("button, input")].filter(
      (element) => isButton(element) && buttonText(element) === target.value,
    );
  const attribute = attributes[target.by];
  return [...document.querySelectorAll(`[${attribute}]`)].filter(
    (element) => element.getAttribute(attribute) === target.value,
  );
}
