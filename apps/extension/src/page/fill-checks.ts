import { valueMismatch, type ValueMismatch } from "@pateat/contracts";

// The executor's local fill checks (ADR 0010). They read only the page and the values
// already in the content script; nothing they see, including alert text that may echo
// a value, leaves it.

/** Why the page would reject `value` in `input` (its type, `maxlength` and `minlength`). */
export function inputValueMismatch(
  input: HTMLInputElement,
  value: string,
): ValueMismatch | undefined {
  // The properties read -1 when the attribute is absent or invalid.
  return valueMismatch(
    {
      type: input.type,
      maxLength: input.maxLength >= 0 ? input.maxLength : undefined,
      minLength: input.minLength >= 0 ? input.minLength : undefined,
    },
    value,
  );
}

// Alerts and the live regions that announce messages. `log`, `marquee` and `timer`
// regions change on their own and are not read.
const feedbackSelector =
  '[role="alert"], [role="status"], [aria-live="polite"], [aria-live="assertive"]';

/** The rendered texts of the alerts and live regions, to compare after a fill. */
export function pageFeedback(root: ParentNode): ReadonlySet<string> {
  const texts = new Set<string>();
  for (const element of root.querySelectorAll(feedbackSelector)) {
    // Visually hidden announcements (clipped to one pixel) still count as rendered.
    if (!(element instanceof HTMLElement) || !element.checkVisibility({ visibilityProperty: true }))
      continue;
    const text = element.innerText.replace(/\s+/gu, " ").trim();
    if (text) texts.add(text);
  }
  return texts;
}

/**
 * Whether the page rejected a fill once its own handlers ran: a filled input fails its
 * constraint validation (read without firing `invalid`) or has `aria-invalid="true"`,
 * or an alert or live region shows text that none showed before the fill.
 */
export function rejectsFill(
  inputs: readonly HTMLInputElement[],
  before: ReadonlySet<string>,
  root: ParentNode,
): boolean {
  if (
    inputs.some(
      (input) =>
        input.isConnected &&
        (!input.validity.valid ||
          input.getAttribute("aria-invalid")?.trim().toLowerCase() === "true"),
    )
  )
    return true;
  // Compared by text, so a page that re-renders a message it already showed is not a
  // new message.
  return [...pageFeedback(root)].some((text) => !before.has(text));
}
