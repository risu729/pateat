import { autocompleteTokens, visible } from "../page/targets";
import { formOf, inputsOf } from "../page/shadow";
import { submitButton } from "./content-dom";

/**
 * The person's own sign-in step in the tab's top document (ADR 0034 amendment of
 * 2026-11-17): the person's own input that sends a form holding a shown identifier input
 * (an email, a username or a phone number, by its type or its `autocomplete`) or password
 * input that is not empty. That input is a trusted Enter in one of the form's inputs,
 * outside an IME composition, or a trusted click whose path holds the form's submit button.
 * A `submit` event is never read: a page's own `requestSubmit` or a script's click on a
 * submit button fires a trusted one, also while an earlier click of the person still lends
 * the page its activation. A frame's form is none. Only the fact is reported: whether the
 * input is empty is read here, and nothing about it is sent.
 */
export function watchPersonSteps(
  document: Document,
  report: () => void,
  { top = window.top === window }: { top?: boolean } = {},
): () => void {
  if (!top) return () => undefined;
  const stepped = (form: HTMLFormElement | null) => {
    if (form && signInForm(form, document)) report();
  };
  const onKey = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.key !== "Enter" || event.isComposing) return;
    const target = event.composedPath()[0];
    if (target instanceof HTMLInputElement) stepped(formOf(target));
  };
  const onClick = (event: MouseEvent) => {
    if (!event.isTrusted) return;
    const control = event
      .composedPath()
      .find((target): target is HTMLButtonElement | HTMLInputElement =>
        target instanceof Element ? submitButton(target) : false,
      );
    if (control) stepped(formOf(control));
  };
  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  document.addEventListener("keydown", onKey, options);
  document.addEventListener("click", onClick, options);
  return () => listeners.abort();
}

const IDENTIFIER_TYPES = new Set(["email", "tel", "password"]);
const IDENTIFIER_TOKENS = ["username", "email", "tel", "current-password", "new-password"];

/**
 * Whether a form holds a shown identifier or password input that is not empty. Only
 * whether its value is empty is read.
 */
export function signInForm(form: HTMLFormElement, document: Document): boolean {
  return inputsOf(form, document).some(
    (input) =>
      input instanceof HTMLInputElement &&
      (IDENTIFIER_TYPES.has(input.type) ||
        (input.type !== "hidden" &&
          autocompleteTokens(input).some((token) => IDENTIFIER_TOKENS.includes(token)))) &&
      input.value !== "" &&
      visible(input),
  );
}
