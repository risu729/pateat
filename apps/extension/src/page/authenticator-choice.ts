import { namesAuthenticatorChoice, namesOtherThanAuthenticator } from "@pateat/contracts";
import { visible } from "./targets";
import { controlContent, controlName, controlText, isButton, isScriptButton } from "./text";

/**
 * A shown button or script button whose rendered text names an authenticator app's code as
 * the way to confirm the sign-in (`namesAuthenticatorChoice`, ADR 0081), such as "Use code
 * from authenticator", and none of whose text, hidden text included ({@link
 * controlContent}), and accessible name names another way, so a "Text me a code" button
 * with a visually hidden word or a label that says otherwise is never pressed; a text too
 * long to read in full refuses it. Links, radio buttons and fragment links never count.
 * The extractor gives a `role="button"` element that passes it a text locator on a judged
 * page, and the login checks it again before pressing it.
 */
export function authenticatorChoice(element: Element | undefined): boolean {
  if (
    !(element instanceof HTMLElement) ||
    !visible(element) ||
    !(isButton(element) || isScriptButton(element))
  )
    return false;
  const text = controlText(element);
  const content = controlContent(element);
  const name = controlName(element);
  return (
    text !== undefined &&
    namesAuthenticatorChoice(text) &&
    content !== undefined &&
    !namesOtherThanAuthenticator(content) &&
    (name === undefined || !namesOtherThanAuthenticator(name))
  );
}
