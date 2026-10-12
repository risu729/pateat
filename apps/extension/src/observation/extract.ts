import {
  loginAutocompleteTokens,
  loginObservationSchema,
  loginTargetSchema,
  type LoginObservation,
  type LoginTarget,
  type ObservedCandidate,
} from "@pateat/contracts";
import * as v from "valibot";
import { shortNumericInput } from "../login/inputs";
import type { observationGaps } from "../login/wire";
import { autocompleteTokens } from "../page/targets";
import {
  buttonText,
  collapseText,
  hasNativeButton,
  isScriptButton,
  isScriptLink,
  linkText,
  renderedText,
  shown,
} from "../page/text";

/**
 * Why no observation was produced. A page without one is never sent to inference.
 * `no-locator` is a login page where a control of a login form lacks a locator
 * that names it alone, as when a hidden copy of the form shares the ids and names, and
 * nothing else can be described; a login form with nothing to locate or act on (only
 * fields that cannot be filled) gives `no-candidates`.
 */
export type ObservationRefusal = "unsupported-page" | "no-candidates" | "no-locator";
/**
 * Why a signed-in page's observation is incomplete, for diagnostics only: a fillable field
 * in a shadow root, one that cannot be filled and is disabled or may be a sign-in field,
 * one without a usable locator, or more fields than the candidate limit.
 */
export type ObservationGap = (typeof observationGaps)[number];
export type ObservationResult =
  | { readonly ok: true; readonly observation: LoginObservation; readonly gap?: ObservationGap }
  | { readonly ok: false; readonly reason: ObservationRefusal };

const maxCandidates = 48;
/** Where account menus usually sit: the page's header and navigation. */
const landmarks = "header, nav, [role='banner'], [role='navigation']";
/**
 * How far above a login form a button outside every form still counts as the form's,
 * such as a passkey button beside the password form (SBI Securities: form, list item,
 * list). The body and the root element never count, so this never takes the whole page.
 */
const besideDepth = 2;
const maxBeside = 4;
const maxHeadings = 8;
const maxText = 120;
const rawLimit = maxText * 4;
const labelDepth = 3;
const observedAutocomplete = [
  "username",
  "email",
  "current-password",
  "new-password",
  "one-time-code",
] as const;
const inputModes = ["none", "text", "decimal", "numeric", "tel", "search", "email", "url"] as const;
const fillTypes: Record<string, ObservedCandidate["role"]> = {
  text: "text",
  email: "email",
  tel: "tel",
  number: "number",
  password: "password",
};
const actionTypes = new Set(["submit", "button", "image"]);
const ignoredTypes = new Set(["hidden", "reset"]);
const controls = "input:not([type='hidden']), select, textarea, button";
const fields = "input:not([type='hidden']), select, textarea";
/** Every element `describe` may accept, script buttons included. */
const observed = "input, select, textarea, button, a[href], a[onclick], [role]";
/** Fillable inputs only; consent banners in shadow roots often hold checkboxes. */
const shadowFields = Object.keys(fillTypes)
  .map((type) => `input[type='${type}' i]`)
  .concat("input:not([type])")
  .join(", ");
const locators = [
  ["id", "id"],
  ["name", "name"],
  ["test-id", "data-testid"],
] as const;

/**
 * Text that can reveal an account or a number is replaced before it is observed
 * (owner decision, 2026-10-11): email-like strings, including masked ones, become
 * `[email]`; runs of three or more mask characters become `[masked]`; runs of four or
 * more digits, ASCII or fullwidth, become `[number]`.
 */
const redactions: readonly (readonly [RegExp, string])[] = [
  [/[A-Za-z0-9._%+\-*●•＊]+[@＠][A-Za-z0-9.\-*●•＊]+/gu, "[email]"],
  [/[*●•＊]{3,}/gu, "[masked]"],
  [/[0-9０-９]{4,}/gu, "[number]"],
];

/**
 * Normalizes untrusted page text to the observed-text contract: whitespace collapsed,
 * control/format/separator characters removed, private-looking parts redacted, and at
 * most 120 UTF-16 code units without splitting a surrogate pair.
 */
function observedText(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  // Format characters (zero-width spaces, soft hyphens) vanish before redaction so
  // they cannot split a digit run.
  let text = collapseText(raw);
  for (const [pattern, replacement] of redactions) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/gu, " ").trim();
  if (text.length > maxText) {
    text = text.slice(0, maxText);
    if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text || undefined;
}

/**
 * Whether a control is on the page: `visible`, `faint` when it is rendered but
 * transparent or tiny (a trap, or a real input under a styled widget), or `absent`
 * when it is hidden or moved before the page's start, where trap inputs usually go.
 */
function presence(element: HTMLElement): "visible" | "faint" | "absent" {
  const view = element.ownerDocument.defaultView;
  if (!view || !shown(element, false)) return "absent";
  const rect = element.getBoundingClientRect();
  if (rect.right + view.scrollX <= 0 || rect.bottom + view.scrollY <= 0) return "absent";
  return shown(element) && rect.width >= 2 && rect.height >= 2 ? "visible" : "faint";
}
const visible = (element: HTMLElement) => presence(element) === "visible";

/** Rendered text, normalized and redacted; a little beyond the limit is read so redaction sees whole tokens. */
const visibleText = (root: Element) => observedText(renderedText(root, rawLimit));

type LocatorIndex = Map<string, Map<string, number>>;

/** Counts every locator value once, as the executor's whole-document lookup sees them. */
function locatorIndex(document: Document): LocatorIndex {
  const index: LocatorIndex = new Map(
    [
      ...locators.map(([, attribute]) => attribute),
      "autocomplete",
      "text",
      "script-text",
      "link-text",
    ].map((key) => [key, new Map()]),
  );
  const count = (key: string, value: string) => {
    const counts = index.get(key)!;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  };
  for (const element of document.querySelectorAll("[id], [name], [data-testid]"))
    for (const [, attribute] of locators) {
      const value = element.getAttribute(attribute);
      if (value !== null) count(attribute, value);
    }
  for (const input of document.querySelectorAll("input[autocomplete]"))
    for (const token of new Set(autocompleteTokens(input))) count("autocomplete", token);
  for (const element of document.querySelectorAll("button, input, a")) {
    const text = buttonText(element);
    if (text !== undefined) count(isScriptLink(element) ? "script-text" : "text", text);
  }
  for (const element of document.querySelectorAll("a[href]")) {
    const text = isScriptLink(element) ? undefined : linkText(element);
    if (text !== undefined) count("link-text", text);
  }
  return index;
}

/**
 * Mirrors the executor's lookup: an attribute value, or else a fillable input's
 * `autocomplete` token, or else a button's text, that matches exactly one element. A
 * script link's text must also name no native button, shown or not, which the executor
 * would take first. Button text is used only when redaction leaves it unchanged, so a
 * locator never carries an email address or a long number. With
 * `redactAttributes` the same holds for attribute values, since a signed-in page's ids
 * and names often carry the account. With `links`, a link is located by its text too,
 * which only an account switch uses: the text must name no other link and no button.
 */
function locate(
  element: Element,
  index: LocatorIndex,
  { redactAttributes = false, links = false } = {},
): LoginTarget | undefined {
  for (const [by, attribute] of locators) {
    const value = element.getAttribute(attribute);
    if (value === null || index.get(attribute)!.get(value) !== 1) continue;
    if (redactAttributes && observedText(value) !== value) continue;
    const target = { by, value };
    if (v.is(loginTargetSchema, target)) return target;
  }
  // Only a field the login fills; a button is named by its own attributes or text.
  if (element instanceof HTMLInputElement && fillTypes[element.type])
    for (const value of autocompleteTokens(element)) {
      if (!(loginAutocompleteTokens as readonly string[]).includes(value)) continue;
      if (index.get("autocomplete")!.get(value) !== 1) continue;
      const target = { by: "autocomplete" as const, value };
      if (v.is(loginTargetSchema, target)) return target;
    }
  if (
    element instanceof HTMLAnchorElement &&
    element.hasAttribute("href") &&
    !isScriptLink(element)
  ) {
    const text = links ? linkText(element) : undefined;
    if (
      text === undefined ||
      index.get("link-text")!.get(text) !== 1 ||
      index.get("text")!.has(text) ||
      index.get("script-text")!.has(text) ||
      observedText(text) !== text
    )
      return undefined;
    const target = { by: "text" as const, value: text };
    return v.is(loginTargetSchema, target) ? target : undefined;
  }
  const text = buttonText(element);
  if (text === undefined || observedText(text) !== text) return undefined;
  const unique = isScriptLink(element)
    ? !index.get("text")!.has(text) &&
      !hasNativeButton(element.ownerDocument, text) &&
      index.get("script-text")!.get(text) === 1
    : index.get("text")!.get(text) === 1;
  if (!unique) return undefined;
  const target = { by: "text" as const, value: text };
  return v.is(loginTargetSchema, target) ? target : undefined;
}

const idList = (element: Element, attribute: string) =>
  element.getAttribute(attribute)?.split(/\s+/u).filter(Boolean) ?? [];

/**
 * Visible text of the elements `ids` name. With `skip`, the text of an element matching
 * it, or of one inside such an element, is left out.
 */
function referencedText(
  element: Element,
  ids: readonly string[],
  skip?: string,
): string | undefined {
  const parts = ids.flatMap((id) => {
    const referenced = element.ownerDocument.getElementById(id);
    if (!referenced || (skip && referenced.closest(skip))) return [];
    const text = observedText(renderedText(referenced, rawLimit, skip ? { skip } : {}));
    return text ? [text] : [];
  });
  return observedText(parts.join(" "));
}

/** Regions that announce changes, such as a failed sign-in's message. */
const liveRegions = [
  ...["alert", "status", "log", "marquee", "timer"].map((role) => `[role='${role}']`),
  "[aria-live]:not([aria-live='off'])",
].join(", ");

/**
 * A field's `aria-describedby` text, such as a hint that it takes three digits. Error
 * messages can echo the value the user typed, so a field marked `aria-invalid="true"`
 * gets none, and an element its `aria-errormessage` names or a live region, around the
 * description or inside it, never counts.
 * Text that repeats the label is left out.
 */
function fieldDescription(input: HTMLInputElement, label: string | undefined) {
  if (input.getAttribute("aria-invalid")?.trim().toLowerCase() === "true") return undefined;
  const errors = new Set(idList(input, "aria-errormessage"));
  const text = referencedText(
    input,
    idList(input, "aria-describedby").filter((id) => !errors.has(id)),
    liveRegions,
  );
  return text === label ? undefined : text;
}

/** True for an element that belongs to another control: a control or its `<label for>`. */
function otherControl(node: Element, element: Element): boolean {
  const labelsOther = (label: Element) =>
    label instanceof HTMLLabelElement && label.htmlFor !== "" && label.control !== element;
  return (
    node.matches(controls) ||
    labelsOther(node) ||
    node.querySelector(controls) !== null ||
    [...node.querySelectorAll("label[for]")].some(labelsOther)
  );
}

/**
 * Text of a nearby element that labels a field by layout, as table and form rows do:
 * the nearest preceding sibling with rendered text, at most three levels up, never
 * across another control's area or out of the field's form.
 */
function adjacentText(element: Element): string | undefined {
  let node: Element | null = element;
  for (let depth = 0; node && depth <= labelDepth; depth += 1) {
    if (depth > 0 && node.querySelectorAll(fields).length > 1) return undefined;
    if (node instanceof HTMLFormElement || node === node.ownerDocument.body) return undefined;
    for (let sibling = node.previousElementSibling; sibling;) {
      if (otherControl(sibling, element)) return undefined;
      const text = visibleText(sibling);
      if (text) return text;
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return undefined;
}

function fieldLabel(input: HTMLInputElement): string | undefined {
  const labels = [...(input.labels ?? [])].flatMap((label) => {
    const text = visibleText(label);
    return text ? [text] : [];
  });
  return (
    referencedText(input, idList(input, "aria-labelledby")) ??
    observedText(input.getAttribute("aria-label")) ??
    observedText(labels.join(" ")) ??
    adjacentText(input) ??
    observedText(input.title)
  );
}

function actionLabel(element: HTMLElement): string | undefined {
  const images = [...element.querySelectorAll("img[alt]")].flatMap((image) =>
    shown(image) ? [image.getAttribute("alt")] : [],
  );
  return (
    referencedText(element, idList(element, "aria-labelledby")) ??
    observedText(element.getAttribute("aria-label")) ??
    (element instanceof HTMLInputElement
      ? observedText(element.type === "image" ? element.alt : element.value)
      : visibleText(element)) ??
    observedText(images.join(" ")) ??
    observedText(element.title)
  );
}

function autocomplete(input: HTMLInputElement): ObservedCandidate["autocomplete"] {
  const tokens = autocompleteTokens(input);
  if (tokens.length === 1 && tokens[0] === "off") return "off";
  return observedAutocomplete.find((token) => tokens.includes(token));
}

function constraints(input: HTMLInputElement, role: ObservedCandidate["role"]) {
  const inRange = (value: number) => value >= 1 && value <= 1024;
  const max = input.maxLength;
  const min = input.minLength;
  const lengths =
    role === "number" || (inRange(max) && inRange(min) && min > max)
      ? {}
      : {
          ...(inRange(max) ? { maxLength: max } : {}),
          ...(inRange(min) ? { minLength: min } : {}),
        };
  const mode = input.getAttribute("inputmode")?.trim().toLowerCase();
  const inputMode = inputModes.find((entry) => entry === mode);
  return { ...lengths, ...(inputMode ? { inputMode } : {}) };
}

type Draft = Omit<ObservedCandidate, "id" | "target" | "group"> & { element: HTMLElement };
type Found =
  | { kind: "candidate"; form: HTMLFormElement | null; draft: Draft }
  /**
   * A visible control the executor cannot act on, such as a select or a radio button.
   * `field` holds a text or password field that cannot be filled: read-only (as with
   * software keyboards), disabled until another step, or transparent or tiny.
   */
  | { kind: "unsupported"; form: HTMLFormElement | null; field: HTMLInputElement | undefined };

function describe(element: Element): Found | undefined {
  if (!(element instanceof HTMLElement)) return undefined;
  const present = presence(element);
  if (element instanceof HTMLInputElement && fillTypes[element.type] && present !== "absent") {
    if (present === "faint" || element.readOnly || element.disabled)
      return { kind: "unsupported", form: element.form, field: element };
  } else if (present !== "visible") return undefined;
  if (element instanceof HTMLInputElement) {
    const type = element.type;
    if (ignoredTypes.has(type)) return undefined;
    // A disabled submit often enables once fields are filled, so it stays a candidate.
    if (element.disabled && !actionTypes.has(type)) return undefined;
    const fillRole = fillTypes[type];
    if (fillRole) {
      const label = fieldLabel(element);
      const placeholder = observedText(element.placeholder);
      const description = fieldDescription(element, label);
      const hint = autocomplete(element);
      return {
        kind: "candidate",
        form: element.form,
        draft: {
          element,
          role: fillRole,
          ...(label ? { label } : {}),
          ...(placeholder ? { placeholder } : {}),
          ...(description ? { description } : {}),
          ...(hint ? { autocomplete: hint } : {}),
          ...constraints(element, fillRole),
        },
      };
    }
    if (type === "checkbox" || actionTypes.has(type)) {
      const label = type === "checkbox" ? fieldLabel(element) : actionLabel(element);
      return {
        kind: "candidate",
        form: element.form,
        draft: {
          element,
          role: type === "checkbox" ? "checkbox" : "button",
          ...(label ? { label } : {}),
        },
      };
    }
    // Radio groups and other input types have no executor support yet.
    return { kind: "unsupported", form: element.form, field: undefined };
  }
  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)
    return element.disabled
      ? undefined
      : { kind: "unsupported", form: element.form, field: undefined };
  if (element instanceof HTMLButtonElement) {
    if (element.type === "reset") return undefined;
    const label = actionLabel(element);
    // A disabled button often enables once fields are filled, so it stays a candidate.
    return {
      kind: "candidate",
      form: element.form,
      draft: { element, role: "button", ...(label ? { label } : {}) },
    };
  }
  if (
    isScriptButton(element) ||
    (element instanceof HTMLAnchorElement && element.hasAttribute("href"))
  ) {
    const label = actionLabel(element);
    return {
      kind: "candidate",
      form: element.closest("form"),
      draft: {
        element,
        role: isScriptButton(element) ? "button" : "link",
        ...(label ? { label } : {}),
      },
    };
  }
  return undefined;
}

/**
 * An icon button that never submits its form on its own, such as the eye that shows the
 * password: `type="button"` and no text of its own, so no text locator either. One with
 * text, such as an `<input type="button" value="Login">` that submits by script, is not.
 */
const iconButton = (element: Element) =>
  (element instanceof HTMLButtonElement || element instanceof HTMLInputElement) &&
  element.type === "button" &&
  buttonText(element) === undefined;

/** True when an open shadow root holds a visible match, which the executor cannot reach. */
function inShadow(shadow: ShadowRoot, selector: string): boolean {
  return (
    [...shadow.querySelectorAll(selector)].some(
      (element) => element instanceof HTMLElement && visible(element),
    ) ||
    [...shadow.querySelectorAll("*")].some(
      (element) => element.shadowRoot !== null && inShadow(element.shadowRoot, selector),
    )
  );
}

/**
 * True for a run whose letters and digits, ignoring `-` and `_`, switch between digits,
 * lower case and upper case at least once every three or so characters, as a random
 * base64url token does and a slug such as `campaign-2024-summer-login` does not.
 */
function scrambled(run: string): boolean {
  const kinds = [...run.replace(/[-_]/gu, "")].map((character) =>
    /\d/u.test(character) ? 0 : /[a-z]/u.test(character) ? 1 : 2,
  );
  const changes = kinds.filter((kind, at) => at > 0 && kind !== kinds[at - 1]).length;
  return changes >= run.length * 0.3;
}

/**
 * True for a path that may carry a session ID or another token, which the observation
 * would send to the service and its request log. Any segment counts, as it is and
 * percent-decoded up to three times, when it holds a matrix parameter such as
 * `;jsessionid=`, an ASP.NET cookieless part such as `(S(lit3py55t21z5))`, a query
 * such as Magento's base64-encoded `referer/<URL with ?SID=...>` (`?`, `&` or `=`), a
 * UUID, a run of 16 or more letters and digits that contains a digit, or a run of 16 or
 * more letters, digits, `-` and `_` that contains a digit and switches between them as
 * often as a base64url token does. Short or plain-looking tokens are missed.
 */
function tokenPath(pathname: string): boolean {
  return pathname.split("/").some((raw) => {
    const forms = [raw];
    for (let round = 0; round < 3; round += 1) {
      try {
        const decoded = decodeURIComponent(forms.at(-1)!);
        if (decoded === forms.at(-1)) break;
        forms.push(decoded);
      } catch {
        // A malformed escape is checked as it is.
        break;
      }
    }
    return forms.some(
      (segment) =>
        /[;?&=]|\([A-Z]\(/u.test(segment) ||
        /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/iu.test(segment) ||
        (segment.match(/[A-Za-z\d]{16,}/gu) ?? []).some((run) => /\d/u.test(run)) ||
        (segment.match(/[\w-]{16,}/gu) ?? []).some((run) => /\d/u.test(run) && scrambled(run)),
    );
  });
}

function language(texts: readonly string[]): LoginObservation["language"] {
  const joined = texts.join(" ").replace(/\[(?:email|masked|number)\]/gu, " ");
  const japanese = joined.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu);
  const latin = joined.match(/[A-Za-zＡ-Ｚａ-ｚ]/gu);
  const ja = japanese?.length ?? 0;
  const en = latin?.length ?? 0;
  const share = ja / Math.max(ja + en, 1);
  // A Japanese page often has "ID" labels and an English page a "日本語" switcher.
  return share >= 0.5 ? "ja" : share <= 0.1 ? "en" : "mixed";
}

/**
 * The forms, among those holding a field (`null` for fields outside any form), whose
 * controls a login needs: those with one password field that is not `new-password` or
 * with a `username` or `one-time-code` field, as ADR 0016 detects a login; failing that,
 * any with a password field; otherwise all of them.
 */
function loginFormsOf(
  found: readonly Found[],
  fieldForms: ReadonlySet<HTMLFormElement | null>,
): ReadonlySet<HTMLFormElement | null> {
  const inputs = new Map<HTMLFormElement | null, HTMLInputElement[]>();
  for (const entry of found) {
    const input =
      entry.kind === "candidate"
        ? entry.draft.element instanceof HTMLInputElement && fillTypes[entry.draft.element.type]
          ? entry.draft.element
          : undefined
        : entry.field;
    if (input) inputs.set(entry.form, [...(inputs.get(entry.form) ?? []), input]);
  }
  const hints = (form: HTMLFormElement | null) =>
    (inputs.get(form) ?? []).map((input) => autocomplete(input));
  const passwords = (form: HTMLFormElement | null) =>
    (inputs.get(form) ?? []).filter((input) => input.type === "password");
  const tiers: ((form: HTMLFormElement | null) => boolean)[] = [
    (form) =>
      !hints(form).includes("new-password") &&
      (passwords(form).length === 1 ||
        (passwords(form).length === 0 &&
          hints(form).some((hint) => hint === "username" || hint === "one-time-code"))),
    (form) => passwords(form).length > 0,
  ];
  for (const tier of tiers) {
    const forms = new Set([...fieldForms].filter(tier));
    if (forms.size > 0) return forms;
  }
  return fieldForms;
}

/**
 * Builds the value-free observation of a top-level page that recipe generation
 * receives. It reads element types, locators, labels, placeholders, descriptions and
 * declared input constraints, plus the title and visible headings; never input values,
 * hidden inputs, query strings, scripts or markup. Label text comes from label elements,
 * ARIA, or the rendered text next to a field, with private-looking parts redacted.
 *
 * Only forms that hold a field matter: their buttons, checkboxes and, as context, their
 * links (or, for fields outside any form, every control outside a form). Up to four
 * buttons outside every form but near a login form with a password field
 * (`besideDepth`), such as a passkey button, are kept when they can be located and never
 * make the observation incomplete. A field or button that cannot be located (other than
 * a script button, or an icon button that never submits in a form with another button,
 * which is left out), a control
 * the executor cannot act on or a control in a shadow root marks the observation
 * incomplete when it is in a login form (`loginFormsOf`); any other form with one is
 * left out entirely. A field in any shadow root, or more than 48 candidates, marks it
 * incomplete too, and inference rejects an incomplete observation. A page without a
 * field is refused, and so is one where nothing can be located.
 */
export function extractLoginObservation(
  document: Document = globalThis.document,
): ObservationResult {
  const location = document.location;
  if (!location || tokenPath(location.pathname)) return { ok: false, reason: "unsupported-page" };

  const found = [...document.querySelectorAll(observed)]
    .map(describe)
    .filter((entry) => entry !== undefined);
  const fieldForms = new Set(
    found.flatMap((entry) =>
      (entry.kind === "candidate" && fillTypes[entry.draft.role]) ||
      (entry.kind === "unsupported" && entry.field)
        ? [entry.form]
        : [],
    ),
  );
  if (fieldForms.size === 0) return { ok: false, reason: "no-candidates" };
  const loginForms = loginFormsOf(found, fieldForms);
  // Forms with a control the executor cannot act on or locate. In a login form that
  // makes the observation incomplete; any other such form is left out entirely, so
  // every form the observation describes is fully described.
  const flawed = new Set<HTMLFormElement | null>();

  // A shadow-root field anywhere may be the real login; other shadow controls such as
  // chat widgets matter only inside the forms that are kept.
  let complete = true;
  for (const host of document.querySelectorAll("*")) {
    if (host.shadowRoot === null) continue;
    if (inShadow(host.shadowRoot, shadowFields)) complete = false;
    else if (fieldForms.has(host.closest("form")) && inShadow(host.shadowRoot, controls))
      flawed.add(host.closest("form"));
  }
  const required: { form: HTMLFormElement | null; draft: Draft }[] = [];
  // Script buttons are often widgets (menus, toggles), and text locators name only the
  // `<a>` ones, so one without a locator is left out rather than marking the page
  // incomplete.
  const scripted: typeof required = [];
  // Icon buttons follow the same rule, but only in a form that has another button to
  // submit with: an icon-only button may itself be the form's script submit.
  const icons: typeof required = [];
  const links: typeof required = [];
  const beside: typeof required = [];
  // Only a form with a password field has such neighbours; a search form does not.
  const passwordForms = new Set(
    found.flatMap((entry) => {
      const input = entry.kind === "candidate" ? entry.draft.element : entry.field;
      return input instanceof HTMLInputElement && input.type === "password" ? [entry.form] : [];
    }),
  );
  const areas = [...loginForms].flatMap((form) => {
    if (!passwordForms.has(form)) return [];
    let area: Element | null = form;
    for (let depth = 0; depth < besideDepth && area; depth++) area = area.parentElement;
    // Never the whole page, as when the form sits directly in the body.
    return area && area !== document.body && area !== document.documentElement ? [area] : [];
  });
  for (const entry of found) {
    if (
      entry.kind === "candidate" &&
      entry.form === null &&
      !loginForms.has(null) &&
      entry.draft.role === "button" &&
      !entry.draft.element.closest(landmarks) &&
      areas.some((area) => area.contains(entry.draft.element))
    ) {
      beside.push(entry);
      continue;
    }
    if (!fieldForms.has(entry.form)) continue;
    if (entry.kind === "unsupported") flawed.add(entry.form);
    else if (entry.draft.role === "link") {
      if (entry.form) links.push(entry);
    } else if (isScriptButton(entry.draft.element)) scripted.push(entry);
    else if (iconButton(entry.draft.element)) icons.push(entry);
    else required.push(entry);
  }

  const index = locatorIndex(document);
  // Links and script buttons without a locator are left out without flawing their form.
  let unlocated = false;
  const located = (entries: typeof required, { optional = false } = {}) =>
    entries.flatMap((entry) => {
      const target = locate(entry.draft.element, index, { links: true });
      if (!target) unlocated = true;
      if (!target && !optional) flawed.add(entry.form);
      return target ? [{ ...entry, target }] : [];
    });
  const keep = <Entry extends (typeof required)[number]>(entries: Entry[]) =>
    entries.filter((entry) => !flawed.has(entry.form) || loginForms.has(entry.form));
  const kept = (entries: typeof required, options?: { optional: boolean }) =>
    keep(located(entries, options));
  const requiredFound = located(required);
  const iconsFound = located(icons, { optional: true });
  const submitting = new Set(
    requiredFound.filter((entry) => entry.draft.role === "button").map((entry) => entry.form),
  );
  for (const entry of icons)
    if (!submitting.has(entry.form) && !iconsFound.some((icon) => icon.draft === entry.draft))
      flawed.add(entry.form);
  const described = keep(requiredFound);
  if ([...flawed].some((form) => loginForms.has(form)) || described.length > maxCandidates)
    complete = false;
  const buttons = [
    ...described,
    ...kept(scripted, { optional: true }),
    ...keep(iconsFound),
    // More than a few is page content around the form, not its alternatives.
    ...(beside.length <= maxBeside ? located(beside, { optional: true }) : []),
  ].slice(0, maxCandidates);
  const chosen = [
    ...buttons,
    ...kept(links, { optional: true }).slice(0, Math.max(0, maxCandidates - buttons.length)),
  ];
  if (chosen.length === 0) return { ok: false, reason: unlocated ? "no-locator" : "no-candidates" };
  return observe(document, chosen, complete);
}

type Chosen = { form: HTMLFormElement | null; draft: Draft; target: LoginTarget };

/** Numbers the chosen elements in document order and adds the page's title and headings. */
function observe(document: Document, chosen: Chosen[], complete: boolean): ObservationResult {
  const location = document.location!;
  chosen.sort((left, right) =>
    left.draft.element.compareDocumentPosition(right.draft.element) &
    Node.DOCUMENT_POSITION_FOLLOWING
      ? -1
      : 1,
  );

  const groups = new Map<HTMLFormElement, string>();
  const candidates = chosen.map(({ form, draft: { element: _element, ...rest }, target }, at) => {
    if (form && !groups.has(form)) groups.set(form, `f${groups.size + 1}`);
    return {
      id: `c${at + 1}`,
      ...rest,
      target,
      ...(form ? { group: groups.get(form)! } : {}),
    } satisfies ObservedCandidate;
  });

  const title = observedText(document.title);
  const headings = [
    ...new Set(
      [...document.querySelectorAll("h1, h2, h3")].flatMap((heading) => {
        const text = visibleText(heading);
        return text ? [text] : [];
      }),
    ),
  ].slice(0, maxHeadings);
  const texts = [
    title ?? "",
    ...headings,
    ...candidates.flatMap((candidate) => [
      candidate.label ?? "",
      candidate.placeholder ?? "",
      candidate.description ?? "",
    ]),
  ];
  const parsed = v.safeParse(loginObservationSchema, {
    version: 1,
    origin: location.origin,
    path: location.pathname,
    language: language(texts),
    ...(title ? { title } : {}),
    ...(headings.length ? { headings } : {}),
    complete,
    candidates,
  });
  return parsed.success
    ? { ok: true, observation: parsed.output }
    : { ok: false, reason: "unsupported-page" };
}

/**
 * Whether a control may show the signed-in account: those in a page header or navigation
 * rank ahead of the rest of the page, such as carousels, ads and news tabs. The rank
 * reads only the page's structure, never words of one language.
 */
const accountSignal = (draft: Draft) => (draft.element.closest(landmarks) ? 1 : 0);

/**
 * Whether a field the executor cannot fill may still be a sign-in field: a password or an
 * email field, one marked for a username, an email, a password or a one-time code, or a
 * short numeric field as a code goes in (the executor's rule). Read-only password fields
 * are common with software keyboards.
 */
function mayBeSignIn(input: HTMLInputElement): boolean {
  const hint = autocomplete(input);
  return (
    input.type === "password" ||
    input.type === "email" ||
    (hint !== undefined && hint !== "off") ||
    shortNumericInput(input)
  );
}

/**
 * Builds the observation of the page shown after a generated recipe's final submission,
 * which the service judges for a signed-in marker (ADR 0018). It reads the same
 * value-free details as `extractLoginObservation`, but from the whole page: every field,
 * then buttons and links up to the candidate limit, those in the page header or
 * navigation first (`accountSignal`), listed in document order.
 *
 * The judge refuses a page that still shows a sign-in field, so every field must be
 * described: a field that cannot be located, a field in a shadow root, or more fields than
 * the limit marks the observation incomplete, and so does a field that cannot be filled
 * when it is disabled, as a code field waiting for a timer is, or may be a sign-in field
 * (`mayBeSignIn`). A read-only, transparent or tiny field that may not, such as a hotel
 * search's read-only date picker, is left out. Buttons and links are only
 * possible markers; those past the limit or without a locator are left out. A link is
 * located by its text too, as for an account switch, and the executor looks for the
 * completion marker the same way.
 */
export function extractSignedInObservation(
  document: Document = globalThis.document,
): ObservationResult {
  const location = document.location;
  if (!location || tokenPath(location.pathname)) return { ok: false, reason: "unsupported-page" };

  const found = [...document.querySelectorAll(observed)]
    .map(describe)
    .filter((entry) => entry !== undefined);
  // One gap is reported (a shadow-root field first); any gap makes it incomplete.
  let gap: ObservationGap | undefined = [...document.querySelectorAll("*")].some(
    (host) => host.shadowRoot !== null && inShadow(host.shadowRoot, shadowFields),
  )
    ? "shadow-field"
    : undefined;
  const fieldEntries: { form: HTMLFormElement | null; draft: Draft }[] = [];
  const markers: { form: HTMLFormElement | null; draft: Draft }[] = [];
  for (const entry of found) {
    if (entry.kind === "unsupported") {
      // A disabled field may be a code field waiting for a timer or a sent code.
      if (entry.field && (entry.field.disabled || mayBeSignIn(entry.field)))
        gap ??= "unfillable-field";
    } else if (fillTypes[entry.draft.role]) fieldEntries.push(entry);
    else if (entry.draft.role !== "checkbox") markers.push(entry);
  }
  const index = locatorIndex(document);
  // A marker's text locator is stored and must match every later sign-in, so text with a
  // digit, such as a balance or an unread count, never names one.
  const located = (entries: typeof fieldEntries) =>
    entries.flatMap((entry) => {
      const target = locate(entry.draft.element, index, { redactAttributes: true, links: true });
      return target && !(target.by === "text" && /\p{Decimal_Number}/u.test(target.value))
        ? [{ ...entry, target }]
        : [];
    });
  const fieldsFound = located(fieldEntries);
  if (fieldsFound.length > maxCandidates) gap ??= "too-many-fields";
  else if (fieldsFound.length < fieldEntries.length) gap ??= "unlocated-field";
  // A stable sort keeps document order within each rank; `observe` restores it overall.
  const ranked = located(markers)
    .map((entry) => ({ entry, rank: accountSignal(entry.draft) }))
    .sort((left, right) => right.rank - left.rank)
    .map(({ entry }) => entry);
  const chosen = [
    ...fieldsFound.slice(0, maxCandidates),
    ...ranked.slice(0, Math.max(0, maxCandidates - fieldsFound.length)),
  ];
  if (chosen.length === 0) return { ok: false, reason: "no-candidates" };
  const result = observe(document, chosen, gap === undefined);
  return result.ok && gap ? { ...result, gap } : result;
}
