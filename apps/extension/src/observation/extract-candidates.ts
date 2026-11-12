import {
  loginKeypadTargetSchema,
  observedAutocompleteTokens,
  observedInputModes,
  type LoginKeypadTarget,
  type LoginMarkerTarget,
  type ObservedCandidate,
} from "@pateat/contracts";
import * as v from "valibot";
import {
  findKeypad,
  findKeypads,
  KEYPAD_MIN_KEYS,
  keypadField,
  keypadKeys,
  keypadPosition,
} from "../page/keypad";
import { autocompleteTokens } from "../page/targets";
import { closestAcross, composedParent, controlsOf, formOf, queryAll } from "../page/shadow";
import { elementProperty } from "../page/form-native";
import { tokenSegment } from "./path";
import { isScriptButton, readOwnInert } from "../page/text";
import {
  fillTypes,
  actionTypes,
  ignoredTypes,
  controls,
  observed,
  presence,
  presenceMiss,
  visible,
} from "./extract-controls";
import { generatedId, changingId, counterId, type LocatorIndex, locate } from "./extract-locators";
import { uncutText } from "./extract-text";
import { fieldDescription, fieldLabel, actionLabel } from "./extract-labels";
import type { Draft, Found, Keypad, Keypads } from "./extract-types";

export function autocomplete(
  input: HTMLInputElement | HTMLSelectElement,
): ObservedCandidate["autocomplete"] {
  const tokens = autocompleteTokens(input);
  if (tokens.length === 1 && tokens[0] === "off") return "off";
  return observedAutocompleteTokens.find((token) => tokens.includes(token));
}

function constraints(input: HTMLInputElement, role: ObservedCandidate["role"]) {
  const inRange = (value: number) => value >= 1 && value <= 1024;
  const max = input.maxLength;
  const min = input.minLength;
  // A `minlength` over the `maxlength` is dropped alone: the browser still limits typing to
  // the `maxlength`, which the fill checks too.
  const lengths =
    role === "number"
      ? {}
      : {
          ...(inRange(max) ? { maxLength: max } : {}),
          ...(inRange(min) && !(inRange(max) && min > max) ? { minLength: min } : {}),
        };
  const mode = input.getAttribute("inputmode")?.trim().toLowerCase();
  const inputMode = observedInputModes.find((entry) => entry === mode);
  return { ...lengths, ...(inputMode ? { inputMode } : {}) };
}

/** A control a click step may press: a button, a submit, button or image input, or a script button. */
const actionControl = (element: HTMLElement) =>
  element instanceof HTMLButtonElement ||
  (element instanceof HTMLInputElement && actionTypes.has(element.type)) ||
  isScriptButton(element);

/**
 * Describes one element. With `keypads`, the page's software keyboards (ADR 0067), a
 * visible, enabled, empty read-only field beside its keypad (`keypadField`) is a fill
 * candidate entered on that keypad instead of a field that cannot be filled, and no
 * label or description holds a key's text.
 */
export function describe(element: Element, keypads?: Keypads): Found | undefined {
  if (!(element instanceof HTMLElement)) return undefined;
  // An action control the page keeps `inert` itself until its fields are filled stays a
  // candidate, as a disabled one does (`readOwnInert`, #853).
  const present = actionControl(element)
    ? readOwnInert(element, () => presence(element))
    : presence(element);
  let keyed = false;
  let keypadLocator: LoginKeypadTarget | undefined;
  const keypad = element instanceof HTMLInputElement ? keypads?.of(element) : undefined;
  if (element instanceof HTMLInputElement && fillTypes[element.type] && present !== "absent") {
    keyed = keypad !== undefined && present === "visible" && keypadField(element, keypad.container);
    if (keyed && keypad)
      keypadLocator = keypad.target ?? keypadPositionTarget(element, keypad.container);
    if (keyed && !keypadLocator) keyed = false;
    if (!keyed && (present === "faint" || element.readOnly || element.matches(":disabled")))
      return { kind: "unsupported", form: formOf(element), field: element, element };
  } else if (present !== "visible") return undefined;
  if (element instanceof HTMLInputElement) {
    const type = element.type;
    if (ignoredTypes.has(type)) return undefined;
    // A disabled submit often enables once fields are filled, so it stays a candidate.
    if (element.matches(":disabled") && !actionTypes.has(type)) return undefined;
    const fillRole = fillTypes[type];
    if (fillRole) {
      const label = fieldLabel(element, keypads?.keys);
      const placeholder = uncutText(element.placeholder);
      const description = fieldDescription(element, label, keypads?.keys);
      const hint = autocomplete(element);
      return {
        kind: "candidate",
        form: formOf(element),
        draft: {
          element,
          role: fillRole,
          ...(label ? { label } : {}),
          ...(placeholder ? { placeholder } : {}),
          ...(description ? { description } : {}),
          ...(hint ? { autocomplete: hint } : {}),
          ...constraints(element, fillRole),
          ...(keyed && keypadLocator ? { keypad: keypadLocator } : {}),
        },
      };
    }
    if (type === "checkbox" || actionTypes.has(type)) {
      const label = type === "checkbox" ? fieldLabel(element, keypads?.keys) : actionLabel(element);
      return {
        kind: "candidate",
        form: formOf(element),
        draft: {
          element,
          role: type === "checkbox" ? "checkbox" : "button",
          ...(label ? { label } : {}),
        },
      };
    }
    // Radio groups and other input types have no executor support yet.
    return { kind: "unsupported", form: formOf(element), field: undefined, element };
  }
  if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)
    return element.matches(":disabled")
      ? undefined
      : { kind: "unsupported", form: formOf(element), field: undefined, element };
  if (element instanceof HTMLButtonElement) {
    if (element.type === "reset") return undefined;
    const label = actionLabel(element);
    // A disabled button often enables once fields are filled, so it stays a candidate.
    return {
      kind: "candidate",
      form: formOf(element),
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
      form: closestAcross(element, "form") as HTMLFormElement | null,
      draft: {
        element,
        role: isScriptButton(element) ? "button" : "link",
        ...(label ? { label } : {}),
      },
    };
  }
  return undefined;
}

/** Radio buttons, selects, text areas and the ARIA widgets that stand for them. */
const answerControls = [
  "input[type='radio' i]",
  "select",
  "textarea",
  ...["radio", "radiogroup", "combobox", "listbox", "textbox"].map((role) => `[role~='${role}' i]`),
].join(", ");

const searchWords = /\bsearch\b|検索|探す/iu;

/** A search box: a search input, or an input whose name for the person says search. */
const searchBox = (element: Element) =>
  (element instanceof HTMLInputElement &&
    (element.type === "search" || element.inputMode === "search")) ||
  element.matches("[role~='searchbox' i]") ||
  ["aria-label", "placeholder", "title"].some((name) =>
    searchWords.test(element.getAttribute(name) ?? ""),
  );

/** A search box, or a field in a search landmark. */
export const siteSearch = (element: Element) =>
  searchBox(element) || closestAcross(element, "search, [role~='search' i]") !== null;

/**
 * Whether `form` is a small search form: at most four controls in all, as a box, a
 * category select and a button, whose typed inputs are all search boxes, so a whole page
 * wrapped in one form, or a sign-in form with a site search box, is none.
 */
function searchForm(form: HTMLFormElement): boolean {
  const held = controlsOf(form, elementProperty(form, "ownerDocument")).filter(
    (element) => !(element instanceof HTMLInputElement && element.type === "hidden"),
  );
  const typed = held.filter(
    (element) =>
      element instanceof HTMLInputElement &&
      !["checkbox", "radio", "submit", "button", "reset", "image"].includes(element.type),
  );
  return held.length <= 4 && typed.length > 0 && typed.every(searchBox);
}

/**
 * Whether `element` is in the page's footer: `contentinfo`, or a `footer` that is no
 * part of an article, section, dialog or form, as HTML maps it to that landmark.
 */
function pageFooter(element: HTMLElement): boolean {
  if (closestAcross(element, "[role~='contentinfo' i]")) return true;
  const footer = closestAcross(element, "footer");
  return (
    footer !== null &&
    !closestAcross(
      footer,
      "article, aside, main, nav, section, dialog, form, [role~='dialog' i], [role~='alertdialog' i]",
    )
  );
}

/**
 * Whether the page shows a radio button, select or text area, or an ARIA radio, radio
 * group, combo box, list box or text box, that is no part of a site search: an answer
 * the person may be asked for that the description has no role for (ADR 0065). A
 * disabled one counts, and so does a transparent, tiny or unrendered one under a label
 * or container that shows, as a styled radio under its label "card" is. One in a search
 * landmark, a search box itself, a select or combo box of a small search form, and a
 * select or combo box in the page footer, such as a language picker, do not.
 */
export function leftOutInputs(document: Document): boolean {
  // Each form is checked once per scan, however many selects it holds.
  const searchForms = new Map<HTMLFormElement, boolean>();
  for (const element of queryAll<HTMLElement>(document, answerControls)) {
    if (siteSearch(element)) continue;
    const picker = element instanceof HTMLSelectElement || element.matches("[role~='combobox' i]");
    // A page footer's select, as a language or region picker, asks nothing of the sign-in.
    if (picker && pageFooter(element)) continue;
    const choice = picker || element.matches("[role~='listbox' i]");
    const form = closestAcross(element, "form") as HTMLFormElement | null;
    if (choice && form) {
      let search = searchForms.get(form);
      if (search === undefined) searchForms.set(form, (search = searchForm(form)));
      if (search) continue;
    }
    if (presence(element) !== "absent") return true;
    // A styled control hides its input under a label or card that shows.
    const labels =
      element instanceof HTMLInputElement ||
      element instanceof HTMLSelectElement ||
      element instanceof HTMLTextAreaElement
        ? [...(element.labels ?? [])]
        : [];
    const container = (closestAcross(element, "label") ??
      composedParent(element)) as HTMLElement | null;
    if ([...labels, ...(container ? [container] : [])].some((shownBy) => visible(shownBy)))
      return true;
  }
  return false;
}

/** The ARIA widget roles a signed-in page's marker may be besides links and buttons. */
const markerWidgetRoles = new Set([
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "treeitem",
  "link",
]);

/**
 * A signed-in page's ARIA widgets that `describe` does not accept (ADR 0029 amendment of
 * 2026-11-04): a shown element whose first role is a tab, menu item, tree item or link,
 * as Notion's sidebar `<div role="tab" id="sidebar-tab-default-home">` is, that is no
 * native control, `<a>`, script button or part of a link, and holds no `<a>`, control,
 * `role="button"` element or pointer tab stop, in its shadow tree either, that would be
 * described itself. It is drafted as a link, which no step or handler
 * presses, and a marker takes it only by an attribute (`markerWidgetTarget`).
 */
export function markerWidgets(document: Document): Draft[] {
  return queryAll<HTMLElement>(document, "[role]").flatMap((element) => {
    const role = element.getAttribute("role")!.trim().toLowerCase().split(/\s+/u)[0];
    if (
      role === undefined ||
      !markerWidgetRoles.has(role) ||
      !(element instanceof HTMLElement) ||
      element instanceof HTMLAnchorElement ||
      element.matches(controls) ||
      isScriptButton(element) ||
      closestAcross(element, "a[href]") !== null ||
      queryAll(element, `a, [role~='button' i], ${controls}`).length > 0 ||
      queryAll(element, "[tabindex]").some(isScriptButton) ||
      presence(element) !== "visible"
    )
      return [];
    const label = actionLabel(element);
    return [{ element, role: "link" as const, ...(label ? { label } : {}) }];
  });
}

/**
 * The locator of a signed-in page's ARIA widget (`markerWidgets`): an attribute that names
 * it alone as a marker's would (`locate` with `lasting`), never its text, as a marker's
 * text is looked up among links and buttons only, and never an ID shaped like a render
 * counter (`counterId`), as a widget library numbers its tabs (`headlessui-tabs-tab-1`).
 */
export function markerWidgetTarget(
  element: Element,
  index: LocatorIndex,
): LoginMarkerTarget | undefined {
  const target = locate(element, index, { redactAttributes: true, lasting: true, hidden: true });
  if (!target || target.by === "text") return undefined;
  const ids = [target, ...("within" in target ? (target.within ?? []) : [])];
  return ids.some((named) => named.by === "id" && counterId(named.value)) ? undefined : target;
}

/**
 * Every element the page shows that `describe` accepts, in document order, shadow trees
 * included (ADR 0070).
 */
export const describeAll = (document: Document, keypads?: Keypads) =>
  queryAll(document, observed)
    .map((element) => describe(element, keypads))
    .filter((entry) => entry !== undefined);

/**
 * The locator of the page's software keyboard (`findKeypad`, ADR 0067): the `id`,
 * `data-testid` or class of the keypad or its nearest ancestor below the body that names
 * it alone in the document, skipping an ID React generated or another load may change, a
 * class that looks generated the same way, and, with `tokens`, a value that may be a
 * token. Without one, each field names the keypad by its position (`keypadPositionTarget`).
 */
function keypadTarget(
  container: Element,
  index: LocatorIndex,
  tokens: boolean,
): LoginKeypadTarget | undefined {
  const { body } = container.ownerDocument;
  for (let node: Element | null = container; node && node !== body; node = node.parentElement) {
    for (const [by, attribute] of [
      ["id", "id"],
      ["test-id", "data-testid"],
    ] as const) {
      const value = node.getAttribute(attribute);
      if (value === null) continue;
      if (attribute === "id" && (generatedId.test(value) || changingId(value))) continue;
      if (tokens && tokenSegment(value)) continue;
      const target = { by, value };
      if (v.is(loginKeypadTargetSchema, target) && index.get(attribute)!.get(value) === 1)
        return target;
    }
    for (const value of node.classList) {
      if (generatedId.test(value) || changingId(value) || (tokens && tokenSegment(value))) continue;
      const target = { by: "class" as const, value };
      if (
        v.is(loginKeypadTargetSchema, target) &&
        container.ownerDocument.getElementsByClassName(value).length === 1
      )
        return target;
    }
  }
  return undefined;
}

/**
 * The page's software keyboards (ADR 0067). Each input's own is the keypad beside it
 * (`findKeypad`), described with its locator; the keys of every keypad on the page, those
 * beside a writable field with an optional keyboard and those of the document's key
 * groups (`findKeypads`) included, are left out of the candidates and of every label and
 * description, as no step presses one by name and their labels and order never reach the
 * service.
 */
export function pageKeypads(document: Document, index: LocatorIndex, tokens: boolean): Keypads {
  const own = new Map<Element, Keypad>();
  const all = keypadKeys(document);
  if (all.length < KEYPAD_MIN_KEYS) return { of: () => undefined, keys: new Set() };
  const containers = new Set<Element>(findKeypads(document, all));
  const targets = new Map<Element, LoginKeypadTarget | undefined>();
  for (const field of document.querySelectorAll("input")) {
    const container = findKeypad(document, field, all);
    if (!container) continue;
    if (!targets.has(container)) targets.set(container, keypadTarget(container, index, tokens));
    containers.add(container);
    own.set(field, { container, target: targets.get(container) });
  }
  return {
    of: (field) => own.get(field),
    keys: new Set([...containers].flatMap((container) => keypadKeys(container))),
  };
}

/** The keypad's position from `field` (`keypadPosition`), as a locator. */
function keypadPositionTarget(field: Element, container: Element): LoginKeypadTarget | undefined {
  const value = keypadPosition(field, container);
  return value === undefined ? undefined : { by: "position", value };
}

/** How many selects a judged page's description carries at most (ADR 0061). */
export const maxSelects = 12;

/**
 * The shown, enabled single-choice selects of a judged page (ADR 0061), each as a `select`
 * with its label and `autocomplete`, never its options: the judge may name one as a split
 * birth date's or card expiry date's part, and the fill matches an option by its number.
 */
export function describeSelects(
  document: Document,
): { form: HTMLFormElement | null; draft: Draft }[] {
  return queryAll<HTMLSelectElement>(document, "select").flatMap((select) => {
    if (select.multiple || select.matches(":disabled") || presence(select) !== "visible") return [];
    const label = fieldLabel(select);
    const hint = autocomplete(select);
    return [
      {
        form: formOf(select),
        draft: {
          element: select,
          role: "select" as const,
          ...(label ? { label } : {}),
          ...(hint ? { autocomplete: hint } : {}),
        },
      },
    ];
  });
}

/**
 * Why a page's description found no field, as a log code of codes only (ADR 0019): how
 * many inputs other than hidden ones the page holds (`n`), how many fields `describe`
 * accepted (`d`), and the first three such inputs as `type-presence`, the presence being
 * `shown` or {@link presenceMiss}'s reason, with `-out` for one outside every form. Added
 * after x.com's sign-in was described without its field in the owner's Chrome only
 * (2026-10-23).
 */
export function fieldsMissDetail(document: Document): string {
  const inputs = queryAll<HTMLInputElement>(document, "input:not([type='hidden'])");
  const described = describeAll(document).filter(
    (entry) =>
      (entry.kind === "candidate" && fillTypes[entry.draft.role]) ||
      (entry.kind === "unsupported" && entry.field),
  ).length;
  const first = inputs
    .slice(0, 3)
    .map(
      (input) => `${input.type}-${presenceMiss(input) ?? "shown"}${formOf(input) ? "" : "-out"}`,
    );
  return [`n${inputs.length}`, `d${described}`, ...first].join(".");
}
