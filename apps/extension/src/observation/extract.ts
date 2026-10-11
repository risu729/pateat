import {
  loginObservationSchema,
  loginTargetSchema,
  type LoginObservation,
  type LoginTarget,
  type ObservedCandidate,
} from "@pateat/contracts";
import * as v from "valibot";

/** Why no observation was produced. A page without one is never sent to inference. */
export type ObservationRefusal = "unsupported-page" | "no-candidates";
export type ObservationResult =
  | { readonly ok: true; readonly observation: LoginObservation }
  | { readonly ok: false; readonly reason: ObservationRefusal };

const maxCandidates = 48;
const maxHeadings = 8;
const maxText = 120;
const labelDepth = 3;
const autocompleteTokens = [
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
const actionTypes = new Set(["submit", "button"]);
const ignoredTypes = new Set(["hidden", "reset"]);
/** Elements whose text is never page text: code, styles, raw markup and control contents. */
const textless = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "SELECT",
  "OPTION",
  "OPTGROUP",
  "DATALIST",
  "TEXTAREA",
  "INPUT",
  "IFRAME",
  "OBJECT",
  "CANVAS",
]);
const controls = "input:not([type='hidden']), select, textarea, button";
const fields = "input:not([type='hidden']), select, textarea";
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
  let text = raw.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ");
  for (const [pattern, replacement] of redactions) text = text.replace(pattern, replacement);
  text = text.replace(/\s+/gu, " ").trim();
  if (text.length > maxText) {
    text = text.slice(0, maxText);
    if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text || undefined;
}

/** Rendered on screen: not hidden by CSS, opacity, a closed `<details>` or an attribute. */
function shown(element: Element): element is HTMLElement {
  return (
    element instanceof HTMLElement &&
    element.isConnected &&
    !element.closest("[hidden], [inert], [aria-hidden='true']") &&
    element.checkVisibility({
      contentVisibilityAuto: true,
      opacityProperty: true,
      visibilityProperty: true,
    })
  );
}

/** A candidate the user could see. Trap inputs are usually tiny or moved off the page. */
function visible(element: HTMLElement): boolean {
  if (!shown(element)) return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const rect = element.getBoundingClientRect();
  // Login pages do not scroll sideways, so anything outside the viewport's width is a trap.
  const left = rect.left + view.scrollX;
  return (
    rect.width >= 2 &&
    rect.height >= 2 &&
    rect.right + view.scrollX > 0 &&
    rect.bottom + view.scrollY > 0 &&
    left < view.innerWidth
  );
}

/**
 * The rendered text inside an element, read from text nodes of shown elements only.
 * Scripts, styles, raw markup, SVG and form-control contents never contribute.
 */
function visibleText(root: Element): string | undefined {
  if (!shown(root) || textless.has(root.tagName)) return undefined;
  const walker = root.ownerDocument.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node instanceof Text
          ? NodeFilter.FILTER_ACCEPT
          : node instanceof Element && !textless.has(node.tagName) && shown(node)
            ? NodeFilter.FILTER_SKIP
            : NodeFilter.FILTER_REJECT,
    },
  );
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) text += node.nodeValue ?? "";
  return observedText(text);
}

type LocatorIndex = Map<string, Map<string, number>>;

/** Counts every locator value once, as the executor's whole-document lookup sees them. */
function locatorIndex(document: Document): LocatorIndex {
  const index: LocatorIndex = new Map(locators.map(([, attribute]) => [attribute, new Map()]));
  for (const element of document.querySelectorAll("[id], [name], [data-testid]"))
    for (const [, attribute] of locators) {
      const value = element.getAttribute(attribute);
      if (value === null) continue;
      const counts = index.get(attribute)!;
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  return index;
}

/** Mirrors the executor's lookup: an attribute value must match exactly one element. */
function locate(element: Element, index: LocatorIndex): LoginTarget | undefined {
  for (const [by, attribute] of locators) {
    const value = element.getAttribute(attribute);
    if (value === null || index.get(attribute)!.get(value) !== 1) continue;
    const target = { by, value };
    if (v.is(loginTargetSchema, target)) return target;
  }
  return undefined;
}

function referencedText(element: Element): string | undefined {
  const ids = element.getAttribute("aria-labelledby")?.split(/\s+/u).filter(Boolean) ?? [];
  const parts = ids.flatMap((id) => {
    const referenced = element.ownerDocument.getElementById(id);
    const text = referenced && visibleText(referenced);
    return text ? [text] : [];
  });
  return observedText(parts.join(" "));
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
    referencedText(input) ??
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
    referencedText(element) ??
    observedText(element.getAttribute("aria-label")) ??
    (element instanceof HTMLInputElement ? observedText(element.value) : visibleText(element)) ??
    observedText(images.join(" ")) ??
    observedText(element.title)
  );
}

function autocomplete(input: HTMLInputElement): ObservedCandidate["autocomplete"] {
  const tokens = (input.getAttribute("autocomplete") ?? "").toLowerCase().trim().split(/\s+/u);
  if (tokens.length === 1 && tokens[0] === "off") return "off";
  return autocompleteTokens.find((token) => tokens.includes(token));
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
  /** A visible control the executor cannot act on, such as a select or an image button. */
  | { kind: "unsupported"; form: HTMLFormElement | null };

function describe(element: Element): Found | undefined {
  if (!(element instanceof HTMLElement) || !visible(element)) return undefined;
  if (element instanceof HTMLInputElement) {
    const type = element.type;
    if (ignoredTypes.has(type) || element.disabled) return undefined;
    const fillRole = fillTypes[type];
    if (fillRole) {
      if (element.readOnly) return undefined;
      const label = fieldLabel(element);
      const placeholder = observedText(element.placeholder);
      const hint = autocomplete(element);
      return {
        kind: "candidate",
        form: element.form,
        draft: {
          element,
          role: fillRole,
          ...(label ? { label } : {}),
          ...(placeholder ? { placeholder } : {}),
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
    // Image buttons, radio groups and other input types have no executor support yet.
    return { kind: "unsupported", form: element.form };
  }
  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)
    return element.disabled ? undefined : { kind: "unsupported", form: element.form };
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
  if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) {
    const label = actionLabel(element);
    return {
      kind: "candidate",
      form: element.closest("form"),
      draft: { element, role: "link", ...(label ? { label } : {}) },
    };
  }
  return undefined;
}

/** True when an open shadow root holds a control the executor's document lookup cannot reach. */
function shadowControls(root: Document | ShadowRoot): boolean {
  for (const host of root.querySelectorAll("*")) {
    const shadow = host.shadowRoot;
    if (!shadow) continue;
    if (
      [...shadow.querySelectorAll(controls)].some(
        (element) => element instanceof HTMLElement && visible(element),
      ) ||
      shadowControls(shadow)
    )
      return true;
  }
  return false;
}

function language(texts: readonly string[]): LoginObservation["language"] {
  const joined = texts.join(" ");
  const japanese = joined.match(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/gu);
  const latin = joined.match(/[A-Za-zＡ-Ｚａ-ｚ]/gu);
  const ja = japanese?.length ?? 0;
  const en = latin?.length ?? 0;
  const share = ja / Math.max(ja + en, 1);
  // A Japanese page often has "ID" labels and an English page a "日本語" switcher.
  return share >= 0.5 ? "ja" : share <= 0.1 ? "en" : "mixed";
}

/**
 * Builds the value-free observation of a top-level page that recipe generation
 * receives. It reads element types, locators, labels, placeholders and declared input
 * constraints, plus the title and visible headings; never input values, hidden inputs,
 * query strings, scripts or markup. Label text comes from label elements, ARIA, or the
 * rendered text next to a field, with private-looking parts redacted.
 *
 * Only forms that hold a field matter: their buttons, checkboxes and, as context, their
 * links (or, for fields outside any form, every control outside a form). A field or
 * button there that cannot be located, a control the executor cannot act on, a
 * control in a shadow root, or more than 48 candidates marks the observation
 * incomplete, and inference rejects it. A page without a field is refused.
 */
export function extractLoginObservation(
  document: Document = globalThis.document,
): ObservationResult {
  const location = document.location;
  // Matrix parameters such as `;jsessionid=` carry session tokens in the path.
  if (!location || location.pathname.includes(";"))
    return { ok: false, reason: "unsupported-page" };

  const found = [...document.querySelectorAll("input, select, textarea, button, a[href]")]
    .map(describe)
    .filter((entry) => entry !== undefined);
  const fieldForms = new Set(
    found.flatMap((entry) =>
      entry.kind === "candidate" && fillTypes[entry.draft.role] ? [entry.form] : [],
    ),
  );
  if (fieldForms.size === 0) return { ok: false, reason: "no-candidates" };

  let complete = !shadowControls(document);
  const required: { form: HTMLFormElement | null; draft: Draft }[] = [];
  const links: { form: HTMLFormElement | null; draft: Draft }[] = [];
  for (const entry of found) {
    if (!fieldForms.has(entry.form)) continue;
    if (entry.kind === "unsupported") complete = false;
    else if (entry.draft.role === "link") {
      if (entry.form) links.push(entry);
    } else required.push(entry);
  }

  const index = locatorIndex(document);
  const located = (entries: typeof required) =>
    entries.flatMap((entry) => {
      const target = locate(entry.draft.element, index);
      return target ? [{ ...entry, target }] : [];
    });
  const kept = located(required);
  if (kept.length < required.length || kept.length > maxCandidates) complete = false;
  const chosen = [
    ...kept.slice(0, maxCandidates),
    ...located(links).slice(0, Math.max(0, maxCandidates - kept.length)),
  ].sort((left, right) =>
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
    ...candidates.flatMap((candidate) => [candidate.label ?? "", candidate.placeholder ?? ""]),
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
