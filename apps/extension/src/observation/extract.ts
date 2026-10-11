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
const controls = "input, select, textarea, button";

/**
 * Normalizes untrusted page text to the observed-text contract: whitespace collapsed,
 * control/format/separator characters removed, and at most 120 UTF-16 code units
 * without splitting a surrogate pair.
 */
function observedText(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let text = raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length > maxText) {
    text = text.slice(0, maxText);
    if (/[\uD800-\uDBFF]$/u.test(text)) text = text.slice(0, -1);
    text = text.trimEnd();
  }
  return text || undefined;
}

function rendered(element: Element): string | undefined {
  return observedText(element instanceof HTMLElement ? element.innerText : element.textContent);
}

/** The same visibility test the executor applies, plus off-page and hidden-subtree checks. */
function visible(element: HTMLElement): boolean {
  if (!element.isConnected || element.closest("[hidden], [inert], [aria-hidden='true']"))
    return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(element);
  if (style.display === "none" || style.visibility !== "visible") return false;
  const rect = element.getBoundingClientRect();
  // Trap fields are often moved off the page rather than hidden.
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right + view.scrollX > 0 &&
    rect.bottom + view.scrollY > 0
  );
}

/** Mirrors the executor's lookup: an attribute value must match exactly one element. */
function locate(element: Element): LoginTarget | undefined {
  for (const [by, attribute] of [
    ["id", "id"],
    ["name", "name"],
    ["test-id", "data-testid"],
  ] as const) {
    const value = element.getAttribute(attribute);
    if (value === null) continue;
    const target = { by, value };
    if (!v.is(loginTargetSchema, target)) continue;
    const matches = [...element.ownerDocument.querySelectorAll(`[${attribute}]`)].filter(
      (other) => other.getAttribute(attribute) === value,
    );
    if (matches.length === 1) return target;
  }
  return undefined;
}

function referencedText(element: Element): string | undefined {
  const ids = element.getAttribute("aria-labelledby")?.split(/\s+/u).filter(Boolean) ?? [];
  const parts = ids.flatMap((id) => {
    const referenced = element.ownerDocument.getElementById(id);
    const text = referenced && rendered(referenced);
    return text ? [text] : [];
  });
  return observedText(parts.join(" "));
}

/** Text of a nearby element that labels a control by layout, as table and form rows do. */
function adjacentText(element: Element): string | undefined {
  let node: Element | null = element;
  for (let depth = 0; node && depth <= labelDepth; depth += 1) {
    // Stop before a container that also holds another control's area.
    if (depth > 0 && node.querySelectorAll("input, select, textarea").length > 1) return undefined;
    if (node instanceof HTMLFormElement || node === node.ownerDocument.body) return undefined;
    for (let sibling = node.previousElementSibling; sibling;) {
      if (sibling.matches(controls) || sibling.querySelector(controls)) return undefined;
      const text = rendered(sibling);
      if (text) return text;
      sibling = sibling.previousElementSibling;
    }
    node = node.parentElement;
  }
  return undefined;
}

function fieldLabel(input: HTMLInputElement): string | undefined {
  const labels = [...(input.labels ?? [])].flatMap((label) => {
    const text = rendered(label);
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
  const images = [...element.querySelectorAll("img[alt]")].map((image) =>
    image.getAttribute("alt"),
  );
  return (
    referencedText(element) ??
    observedText(element.getAttribute("aria-label")) ??
    (element instanceof HTMLInputElement ? observedText(element.value) : rendered(element)) ??
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

type Draft = Omit<ObservedCandidate, "id" | "target" | "group"> & {
  element: HTMLElement;
  form: HTMLFormElement | null;
};

/** Classifies one element; `unsupported` is a visible control the executor cannot act on. */
function describe(element: Element): Draft | "unsupported" | undefined {
  if (element instanceof HTMLInputElement) {
    const type = element.type;
    if (type === "hidden" || !visible(element)) return undefined;
    const fillRole = fillTypes[type];
    if (fillRole) {
      if (element.disabled || element.readOnly) return undefined;
      const label = fieldLabel(element);
      const placeholder = observedText(element.placeholder);
      const hint = autocomplete(element);
      return {
        element,
        form: element.form,
        role: fillRole,
        ...(label ? { label } : {}),
        ...(placeholder ? { placeholder } : {}),
        ...(hint ? { autocomplete: hint } : {}),
        ...constraints(element, fillRole),
      };
    }
    if (type === "checkbox" || type === "submit" || type === "button") {
      const label = type === "checkbox" ? fieldLabel(element) : actionLabel(element);
      return {
        element,
        form: element.form,
        role: type === "checkbox" ? "checkbox" : "button",
        ...(label ? { label } : {}),
      };
    }
    // Image buttons are common on Japanese bank pages but the executor cannot click them yet.
    if (type === "image") return "unsupported";
    return undefined;
  }
  if (element instanceof HTMLButtonElement) {
    if (element.type === "reset" || !visible(element)) return undefined;
    const label = actionLabel(element);
    // A disabled button often enables once fields are filled, so it stays a candidate.
    return { element, form: element.form, role: "button", ...(label ? { label } : {}) };
  }
  if (element instanceof HTMLAnchorElement && element.hasAttribute("href")) {
    if (!visible(element)) return undefined;
    const label = actionLabel(element);
    return {
      element,
      form: element.closest("form"),
      role: "link",
      ...(label ? { label } : {}),
    };
  }
  return undefined;
}

/** True when an open shadow root holds an input the executor's document lookup cannot reach. */
function shadowInputs(root: Document | ShadowRoot): boolean {
  for (const host of root.querySelectorAll("*")) {
    const shadow = host.shadowRoot;
    if (!shadow) continue;
    if (
      [...shadow.querySelectorAll("input, button")].some(
        (element) => element instanceof HTMLElement && visible(element),
      ) ||
      shadowInputs(shadow)
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
 * Builds the value-free observation of a top-level page that recipe
 * generation receives. It reads element types, locators, labels, placeholders and
 * declared input constraints; never input values, hidden inputs, query strings or
 * page body text.
 *
 * Links matter only as context, so only links inside a form that holds a field are
 * kept, after every field and button. When a field or button cannot be located or
 * acted on, or the candidates exceed the contract limit, the observation is marked
 * incomplete and inference rejects it.
 */
export function extractLoginObservation(
  document: Document = globalThis.document,
): ObservationResult {
  const { origin, pathname } = document.location;

  let complete = !shadowInputs(document);
  const primary: Draft[] = [];
  const links: Draft[] = [];
  for (const element of document.querySelectorAll("input, button, a[href]")) {
    const draft = describe(element);
    if (draft === undefined) continue;
    if (draft === "unsupported") {
      complete = false;
      continue;
    }
    (draft.role === "link" ? links : primary).push(draft);
  }

  const located = (drafts: Draft[], required: boolean) =>
    drafts.flatMap((draft) => {
      const target = locate(draft.element);
      if (!target && required) complete = false;
      return target ? [{ draft, target }] : [];
    });
  const fields = located(primary, true);
  if (fields.length > maxCandidates) complete = false;
  const fieldForms = new Set(
    fields
      .filter(({ draft }) => draft.role !== "button" && draft.role !== "checkbox")
      .map(({ draft }) => draft.form),
  );
  const contextLinks = located(
    links.filter((draft) => draft.form && fieldForms.has(draft.form)),
    false,
  );
  const chosen = [...fields, ...contextLinks]
    .slice(0, maxCandidates)
    .sort((left, right) =>
      left.draft.element.compareDocumentPosition(right.draft.element) &
      Node.DOCUMENT_POSITION_FOLLOWING
        ? -1
        : 1,
    );

  const groups = new Map<HTMLFormElement, string>();
  const candidates = chosen.map(({ draft: { element: _element, form, ...rest }, target }, index) => {
    if (form && !groups.has(form)) groups.set(form, `f${groups.size + 1}`);
    return {
      id: `c${index + 1}`,
      ...rest,
      target,
      ...(form ? { group: groups.get(form)! } : {}),
    } satisfies ObservedCandidate;
  });
  if (candidates.length === 0) return { ok: false, reason: "no-candidates" };

  const title = observedText(document.title);
  const headings = [
    ...new Set(
      [...document.querySelectorAll("h1, h2, h3")].flatMap((heading) =>
        heading instanceof HTMLElement && visible(heading) ? [rendered(heading) ?? ""] : [],
      ),
    ),
  ]
    .filter(Boolean)
    .slice(0, maxHeadings);
  const texts = [
    title ?? "",
    ...headings,
    ...candidates.flatMap((candidate) => [candidate.label ?? "", candidate.placeholder ?? ""]),
  ];
  const parsed = v.safeParse(loginObservationSchema, {
    version: 1,
    origin,
    path: pathname,
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
