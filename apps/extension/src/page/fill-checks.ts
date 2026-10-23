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

// Alerts count anywhere on the page. Status and polite live regions also announce
// unrelated things (timers, search suggestions, banners), so they count only inside the
// filled form or when a filled input names them. `log`, `marquee` and `timer` regions
// change on their own and are never read.
const alertSelector = '[role="alert"], [aria-live="assertive"]';
const statusSelector = '[role="status"], [aria-live="polite"]';

/** An input a fill typed into, or a select a split date's part chose an option in (ADR 0061). */
export type FilledControl = HTMLInputElement | HTMLSelectElement;

/** What the page showed before a fill, to compare with once its handlers ran. */
export interface FillBaseline {
  readonly texts: ReadonlySet<string>;
  /** Per filled input: whether it was marked invalid, and its custom validity message. */
  readonly inputs: readonly { ariaInvalid: boolean; customError: string }[];
}

const validityFlags = [
  "badInput",
  "patternMismatch",
  "rangeOverflow",
  "rangeUnderflow",
  "stepMismatch",
  "tooLong",
  "tooShort",
  "typeMismatch",
  "valueMissing",
] as const satisfies readonly (keyof ValidityState)[];

const ariaInvalid = (input: FilledControl) =>
  input.getAttribute("aria-invalid")?.trim().toLowerCase() === "true";

function feedbackTexts(
  inputs: readonly FilledControl[],
  regions: "all" | "alert" = "all",
): Set<string> {
  const root = inputs[0]?.ownerDocument ?? document;
  const form = inputs[0]?.form;
  const named = new Set(
    inputs.flatMap((input) =>
      ["aria-describedby", "aria-errormessage"].flatMap((name) =>
        (input.getAttribute(name) ?? "").split(/\s+/u).filter(Boolean),
      ),
    ),
  );
  const shown = [
    ...root.querySelectorAll(alertSelector),
    ...(regions === "alert" ? [] : [...root.querySelectorAll(statusSelector)]).filter(
      (element) => form?.contains(element) || named.has(element.id),
    ),
  ];
  const texts = new Set<string>();
  for (const element of shown) {
    // A region around the inputs changes with any text of the form, such as a password
    // visibility toggle; visually hidden announcements still count as rendered.
    if (
      !(element instanceof HTMLElement) ||
      inputs.some((input) => element.contains(input)) ||
      !element.checkVisibility({ visibilityProperty: true })
    )
      continue;
    const text = element.innerText.replace(/\s+/gu, " ").trim();
    if (text) texts.add(text);
  }
  return texts;
}

export function fillBaseline(inputs: readonly FilledControl[]): FillBaseline {
  return {
    texts: feedbackTexts(inputs),
    inputs: inputs.map((input) => ({
      ariaInvalid: ariaInvalid(input),
      customError: input.validity.customError ? input.validationMessage : "",
    })),
  };
}

/**
 * Whether the page rejected a fill once its own handlers ran: a filled input fails its
 * constraint validation (read without firing `invalid`), became `aria-invalid="true"`,
 * or an alert or relevant live region shows text that none showed before the fill. A
 * mark the input already had before the fill, such as one left by an earlier failed
 * sign-in that no script clears, is not the page's answer. The caller handles a filled
 * input that is no longer connected first. Without `statuses`, only alerts and the inputs'
 * own marks count, for a fill whose status regions may announce the page's own
 * submission.
 */
export function rejectsFill(
  inputs: readonly FilledControl[],
  before: FillBaseline,
  { statuses = true }: { statuses?: boolean } = {},
): boolean {
  const rejected = inputs.some((input, index) => {
    const previous = before.inputs[index]!;
    if (ariaInvalid(input) && !previous.ariaInvalid) return true;
    const { validity } = input;
    if (validity.valid) return false;
    // Only an unchanged custom message that was already set is left over.
    const leftOver =
      validity.customError &&
      validityFlags.every((flag) => !validity[flag]) &&
      previous.customError !== "" &&
      input.validationMessage === previous.customError;
    return !leftOver;
  });
  // Compared by text, so a page that re-renders a message it already showed is not a
  // new message.
  const texts = feedbackTexts(inputs, statuses ? "all" : "alert");
  return rejected || [...texts].some((text) => !before.texts.has(text));
}

/**
 * Whether a form Pateat filled since the last click is not ready for the next one: the
 * page emptied a shown input Pateat filled, or, for a submitting click, a shown password
 * input that was not shown when the filling began is empty. `inputs` are the clicked
 * element's form's inputs. A page that switches its form as the first value goes in, as
 * St.George's logon with a remembered access number does (it clears every field and shows
 * a Security Number field), would otherwise be sent without its credentials. Forms Pateat
 * filled nothing in since the last click are not checked, so a passkey button beside an
 * empty password field is still clicked, and so is a form whose other password fields
 * (a registration panel, an off-screen trap) showed before the fill.
 */
export function unreadyForm(
  inputs: readonly HTMLInputElement[],
  {
    filled,
    shownBefore,
    writable,
    submit,
  }: {
    filled: (input: HTMLInputElement) => boolean;
    shownBefore: (input: HTMLInputElement) => boolean;
    writable: (input: HTMLInputElement) => boolean;
    submit: boolean;
  },
): boolean {
  const ours = inputs.filter(filled);
  if (ours.length === 0) return false;
  const empty = (input: HTMLInputElement) => input.value === "" && writable(input);
  return (
    ours.some(empty) ||
    (submit &&
      inputs.some(
        (input) =>
          input.type === "password" && !filled(input) && !shownBefore(input) && empty(input),
      ))
  );
}
