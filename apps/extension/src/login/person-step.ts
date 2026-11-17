import { autocompleteTokens } from "../page/targets";
import { formOf, inputsOf } from "../page/shadow";

/**
 * The person's own sign-in step in the tab's top document (ADR 0034 amendment of
 * 2026-11-17): a form that holds an identifier input (an email, a username or a phone
 * number, by its type or its `autocomplete`) or a password input, sent by the person. It is
 * the form's trusted `submit`, or a trusted Enter in one of its inputs or click on its
 * submit button, as a single-page site may handle those without a `submit`, each while the
 * page has the person's transient activation. A script's event, an event without that
 * activation and a frame's form are none. Only the fact is reported, never a value.
 */
export function watchPersonSteps(
  document: Document,
  report: () => void,
  { top = window.top === window }: { top?: boolean } = {},
): () => void {
  if (!top) return () => undefined;
  const active = () =>
    (navigator as { userActivation?: { isActive: boolean } }).userActivation?.isActive === true;
  const stepped = (form: HTMLFormElement | null, event: Event) => {
    if (form && event.isTrusted && active() && signInForm(form, document)) report();
  };
  const onSubmit = (event: Event) =>
    stepped(event.target instanceof HTMLFormElement ? event.target : null, event);
  const onKey = (event: KeyboardEvent) => {
    const target = event.composedPath()[0];
    if (event.key === "Enter" && target instanceof HTMLInputElement) stepped(formOf(target), event);
  };
  const onClick = (event: MouseEvent) => {
    const control = submitControl(event.composedPath());
    if (control) stepped(formOf(control), event);
  };
  const listeners = new AbortController();
  const options = { capture: true, signal: listeners.signal };
  document.addEventListener("submit", onSubmit, options);
  document.addEventListener("keydown", onKey, options);
  document.addEventListener("click", onClick, options);
  return () => listeners.abort();
}

/** The submit button an event's path goes through, if any. */
function submitControl(path: EventTarget[]): HTMLButtonElement | HTMLInputElement | undefined {
  for (const target of path)
    if (
      (target instanceof HTMLButtonElement && target.type === "submit") ||
      (target instanceof HTMLInputElement && (target.type === "submit" || target.type === "image"))
    )
      return target;
  return undefined;
}

const IDENTIFIER_TYPES = new Set(["email", "tel", "password"]);
const IDENTIFIER_TOKENS = ["username", "email", "tel", "current-password", "new-password"];

/** Whether a form holds an identifier input or a password input. */
export function signInForm(form: HTMLFormElement, document: Document): boolean {
  return inputsOf(form, document).some(
    (input) =>
      input instanceof HTMLInputElement &&
      (IDENTIFIER_TYPES.has(input.type) ||
        (input.type !== "hidden" &&
          autocompleteTokens(input).some((token) => IDENTIFIER_TOKENS.includes(token)))),
  );
}
