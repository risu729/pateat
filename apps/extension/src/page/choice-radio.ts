/** Input types that take no typed text: a radio or any other non-text control. */
const untyped = new Set([
  "hidden",
  "file",
  "submit",
  "button",
  "image",
  "reset",
  "checkbox",
  "radio",
  "range",
  "color",
]);
const typed = (element: Element) =>
  element instanceof HTMLTextAreaElement ||
  (element instanceof HTMLInputElement && !untyped.has(element.type));

/**
 * The radio button that chooses `input` (ADR 0061): of a group of two or more radios with
 * one `name` in the input's form (or outside every form, with the input), the only radio
 * between the input and the text-like input or textarea before it, in document order.
 * Undefined when there is none, or more than one.
 */
export function choosingRadio(input: HTMLInputElement): HTMLInputElement | undefined {
  const form = input.form;
  const scope = [...input.ownerDocument.querySelectorAll("input, textarea")].filter(
    (element) => (element as HTMLInputElement | HTMLTextAreaElement).form === form,
  );
  let radios: HTMLInputElement[] = [];
  for (const element of scope) {
    if (element === input) break;
    if (element instanceof HTMLInputElement && element.type === "radio") radios.push(element);
    else if (typed(element)) radios = [];
  }
  const [radio] = radios;
  if (radios.length !== 1 || !radio?.name) return undefined;
  const group = scope.filter(
    (element) =>
      element instanceof HTMLInputElement &&
      element.type === "radio" &&
      element.name === radio.name,
  );
  return group.length >= 2 ? radio : undefined;
}

/**
 * Checks the radio button that chooses `input`, when it has one that is not checked and
 * can be used, with a click so the page's own handlers run. Returns whether the input is
 * still the one to fill: no radio, a checked one, or one checked now.
 */
export function chooseFor(input: HTMLInputElement): boolean {
  const radio = choosingRadio(input);
  if (!radio || radio.checked) return true;
  if (radio.disabled) return false;
  radio.click();
  return radio.checked;
}
