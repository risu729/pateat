import type { LoginTarget, ObservedCandidate } from "@pateat/contracts";
import { findTargets } from "../page/targets";
import { closestAcross, composedParent, containsAcross, formOf, readingPage } from "../page/shadow";
import { redactsPath } from "./path";
import { buttonText, fieldName, isButton, isScriptButton } from "../page/text";
import type { ObservationGap, ObservationResult, Draft, Found } from "./extract-types";
import { withGap, observe } from "./extract-observe";
import { maxCandidates, landmarks, fillTypes, presence } from "./extract-controls";
import { locators, locatorIndex, locate } from "./extract-locators";
import { autocomplete, siteSearch, describeAll, pageKeypads } from "./extract-candidates";

/** Login-page gaps, the first one present reported (`extractLoginObservation`). */
const loginGaps = [
  "unfillable-field",
  "unsupported-control",
  "unlocated-field",
  "unlocated-checkbox",
  "unlocated-button",
  "too-many-candidates",
] as const satisfies readonly ObservationGap[];

type LoginGap = (typeof loginGaps)[number];

/**
 * How far above a login form a button outside every form still counts as the form's,
 * such as a passkey button beside the password form (SBI Securities: form, list item,
 * list). The body and the root element never count, so this never takes the whole page.
 */
const besideDepth = 2;

/**
 * How far above the fields outside every form a control the executor cannot act on still
 * counts as theirs (`formlessFieldsArea`); a footer's language picker is farther away.
 */
const formlessDepth = 4;

const maxBeside = 4;

/**
 * An icon button that never submits a form on its own, such as the eye that shows the
 * password: `type="button"` and no text of its own, so no text locator either. One with
 * text, such as an `<input type="button" value="Login">` that submits by script, is not.
 * A textless button of any type outside every form has no form to submit either, but
 * one near the fields outside every form (`nearFields`) may be their script-run submit;
 * one away from them, such as a cookie banner's close button on Bank of America's home
 * page (2026-10-23), counts.
 */
const iconButton = (element: Element, nearFields: (element: Element) => boolean) =>
  isButton(element) &&
  (element.type === "button" || (formOf(element) === null && !nearFields(element))) &&
  buttonText(element) === undefined;

/**
 * Whether a checkbox must be checked before its form submits: `required`, or
 * `aria-required="true"` for a script that checks it.
 */
const mustCheck = (element: Element) =>
  (element instanceof HTMLInputElement && element.required) ||
  element.getAttribute("aria-required")?.trim().toLowerCase() === "true";

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
 * links (or, for fields outside any form, every control outside a form; a site search box
 * outside every form is no such field, and a control the executor cannot act on counts
 * there only near those fields, `formlessFieldsArea`). Up to four
 * buttons outside every form but near a login form with a password field
 * (`besideDepth`), such as a passkey button, are kept when they can be located and never
 * make the observation incomplete. A field or button that cannot be located (other than
 * a script button, an icon button that never submits in a form with another button, a
 * textless button away from the fields outside every form when another button outside
 * every form is located, or a checkbox the page does not require, which is left out) or
 * a control the executor cannot act on marks the observation
 * incomplete when it is in a login form (`loginFormsOf`); any other form with one is
 * left out entirely. More than 48 candidates mark it incomplete too, and inference rejects an incomplete observation. An incomplete result
 * names its first cause in `loginGaps` order as `gap`, for the log only. A page without a
 * field is refused, and so is one where nothing can be located. As on every observed
 * page, a path segment that may carry a token is sent as `REDACTED_PATH_SEGMENT`
 * (`observedPath`, ADR 0039); on such a page an ID, name or test ID that may be a token
 * locates nothing.
 *
 * `known` names the fields a recipe already fills, on any of its paths, for a page that
 * continues it after an `advance` step (ADR 0018). Such a field shown read-only or disabled, as an
 * email address shown again beside the password, is left out instead: the recipe has
 * filled it, and no step of this page needs it.
 */
export function extractLoginObservation(
  document: Document = globalThis.document,
  known: readonly LoginTarget[] = [],
): ObservationResult {
  return readingPage(() => readLogin(document, known));
}

function readLogin(document: Document, known: readonly LoginTarget[]): ObservationResult {
  const location = document.location;
  if (!location) return { ok: false, reason: "unsupported-page" };
  const tokens = redactsPath(location.pathname);

  const index = locatorIndex(document);
  const filled = (field: HTMLInputElement) =>
    (field.readOnly || field.matches(":disabled")) &&
    known.some((target) => {
      if ("within" in target && target.within) {
        const found = findTargets(document, target, { hidden: true });
        return found.length === 1 && found[0] === field;
      }
      if (target.by === "label")
        return fieldName(field) === target.value && index.get("label")!.get(target.value) === 1;
      if (target.by === "password-form-name") {
        const found = findTargets(document, target);
        return found.length === 1 && found[0] === field;
      }
      const attribute = locators.find(([by]) => by === target.by)?.[1];
      return (
        attribute !== undefined &&
        field.getAttribute(attribute) === target.value &&
        index.get(attribute)!.get(target.value) === 1
      );
    });
  const keypads = pageKeypads(document, index, tokens);
  const { keys } = keypads;
  // A field both faint and disabled takes input from no one, neither the person nor a
  // widget drawn over it, so a login page leaves it out as a decoy; Bitwarden never picks
  // a disabled field as the username or password field either. The signed-in page still
  // sees it, as a code field may wait there for a timer (`describeSignedIn`).
  const found = describeAll(document, keypads).filter(
    (entry) =>
      !(
        entry.kind === "unsupported" &&
        entry.field &&
        (filled(entry.field) ||
          (entry.field.matches(":disabled") && presence(entry.field) === "faint"))
      ) &&
      !(
        entry.kind === "candidate" &&
        ((entry.draft.keypad &&
          entry.draft.element instanceof HTMLInputElement &&
          filled(entry.draft.element)) ||
          keys.has(entry.draft.element))
      ),
  );
  // A site search box outside every form, as in a navigation bar beside a sign-in form, is
  // no field of the sign-in, so it never draws that bar's other controls into the
  // description (LeetCode, 2026-11-07).
  const fieldForms = new Set(
    found.flatMap((entry) => {
      const field = entry.kind === "candidate" ? entry.draft.element : entry.field;
      return ((entry.kind === "candidate" && fillTypes[entry.draft.role]) ||
        (entry.kind === "unsupported" && entry.field)) &&
        !(entry.form === null && field && siteSearch(field))
        ? [entry.form]
        : [];
    }),
  );
  if (fieldForms.size === 0) return { ok: false, reason: "no-candidates" };
  const loginForms = loginFormsOf(found, fieldForms);
  // Forms with a control the executor cannot act on or locate, and why. In a login form
  // that makes the observation incomplete; any other such form is left out entirely, so
  // every form the observation describes is fully described.
  const flawed = new Map<HTMLFormElement | null, Set<LoginGap>>();
  const flaw = (form: HTMLFormElement | null, gap: LoginGap) =>
    flawed.getOrInsertComputed(form, () => new Set<LoginGap>()).add(gap);
  const gaps = new Set<LoginGap>();

  const required: { form: HTMLFormElement | null; draft: Draft }[] = [];
  // Script buttons are often widgets (menus, toggles), and text locators name only the
  // `<a>` ones and, in a login form or beside a password form, the `role="button"` ones
  // and pointer tab stops, so one without a locator is left out rather than marking the
  // page incomplete.
  const scripted: typeof required = [];
  // Icon buttons follow the same rule, but only in a form that has another button to
  // submit with: an icon-only button may itself be the form's script submit.
  const icons: typeof required = [];
  const links: typeof required = [];
  // A checkbox is context only, never checked by a recipe, so one the page does not
  // require, as "Remember me", is left out without a locator; a required one, as an
  // agreement the form cannot submit without, still marks the form incomplete.
  const checks: typeof required = [];
  const beside: typeof required = [];
  // Only a form with a password field has such neighbours; a search form does not.
  const passwordForms = new Set(
    found.flatMap((entry) => {
      const input = entry.kind === "candidate" ? entry.draft.element : entry.field;
      return input instanceof HTMLInputElement && input.type === "password" ? [entry.form] : [];
    }),
  );
  // Fields outside every form, and whether a button is near them: one of them within the
  // button's `besideDepth` nearest ancestors, or the button within one of theirs, so a
  // button wrapped deeper beside the fields still counts. Reaching the body or the root
  // counts as near; a mistake that way only marks the page incomplete.
  const formless = found.flatMap((entry) => {
    const input =
      entry.kind === "candidate" ? fillTypes[entry.draft.role] && entry.draft.element : entry.field;
    return input && entry.form === null ? [input] : [];
  });
  const areaOf = (element: Element) => {
    let area: Element | null = element;
    for (let depth = 0; depth < besideDepth && area; depth++) area = composedParent(area);
    return area && area !== document.body && area !== document.documentElement ? area : undefined;
  };
  const nearFields = (element: Element) => {
    const area = areaOf(element);
    return (
      !area ||
      formless.some((field) => {
        const around = areaOf(field);
        return containsAcross(area, field) || !around || containsAcross(around, element);
      })
    );
  };
  const areas = [...loginForms].flatMap((form) => {
    if (!passwordForms.has(form)) return [];
    let area: Element | null = form;
    for (let depth = 0; depth < besideDepth && area; depth++) area = composedParent(area);
    // Never the whole page, as when the form sits directly in the body.
    return area && area !== document.body && area !== document.documentElement ? [area] : [];
  });
  const formlessArea = loginForms.has(null) ? formlessFieldsArea(found, document) : undefined;
  for (const entry of found) {
    if (
      entry.kind === "candidate" &&
      entry.form === null &&
      !loginForms.has(null) &&
      entry.draft.role === "button" &&
      !closestAcross(entry.draft.element, landmarks) &&
      areas.some((area) => containsAcross(area, entry.draft.element))
    ) {
      beside.push(entry);
      continue;
    }
    if (!fieldForms.has(entry.form)) continue;
    if (entry.kind === "unsupported") {
      // Outside every form, a control far from the sign-in fields, such as a language
      // picker in the page's footer, is not one the sign-in needs.
      if (
        !entry.field &&
        entry.form === null &&
        formlessArea !== undefined &&
        !containsAcross(formlessArea, entry.element)
      )
        continue;
      flaw(entry.form, entry.field ? "unfillable-field" : "unsupported-control");
    } else if (entry.draft.role === "link") {
      if (entry.form) links.push(entry);
    } else if (entry.draft.role === "checkbox" && !mustCheck(entry.draft.element))
      checks.push(entry);
    else if (isScriptButton(entry.draft.element)) scripted.push(entry);
    else if (iconButton(entry.draft.element, nearFields)) icons.push(entry);
    else required.push(entry);
  }

  // Links and script buttons without a locator are left out without flawing their form.
  // A `role="button"` element or pointer tab stop is named by its text only inside a login
  // form or beside a password form, where it is the form's own control rather than a widget elsewhere; a
  // search form beside the login form names none. A link never takes the text of such an
  // element, whatever its form, since one observation's candidates need distinct targets
  // and the login's own control needs that text more.
  let unlocated = false;
  // A login form's native button that nothing else names alone is named by its accessible
  // name, which a route step's click may press (ADR 0048 amendment of 2026-10-23).
  const located = (
    entries: typeof required,
    { optional = false, near = false, names = false } = {},
  ) =>
    entries.flatMap((entry) => {
      const target = locate(entry.draft.element, index, {
        tokens,
        links: true,
        labels: true,
        roles:
          near ||
          entry.draft.role === "link" ||
          (entry.form !== null && loginForms.has(entry.form)),
        names: names && entry.draft.role === "button" && loginForms.has(entry.form),
      });
      if (!target) unlocated = true;
      if (!target && !optional) flaw(entry.form, unlocatedGap(entry.draft.role));
      return target ? [{ ...entry, target }] : [];
    });
  const keep = <Entry extends (typeof required)[number]>(entries: Entry[]) =>
    entries.filter((entry) => !flawed.has(entry.form) || loginForms.has(entry.form));
  const kept = (entries: typeof required, options?: { optional: boolean }) =>
    keep(located(entries, options));
  const requiredFound = located(required, { names: true });
  const iconsFound = located(icons, { optional: true });
  const submitting = new Set(
    requiredFound.filter((entry) => entry.draft.role === "button").map((entry) => entry.form),
  );
  for (const entry of icons)
    if (!submitting.has(entry.form) && !iconsFound.some((icon) => icon.draft === entry.draft))
      flaw(entry.form, "unlocated-button");
  const described = keep(requiredFound);
  for (const [form, causes] of flawed)
    if (loginForms.has(form)) for (const cause of causes) gaps.add(cause);
  if (described.length > maxCandidates) gaps.add("too-many-candidates");
  const gap = loginGaps.find((cause) => gaps.has(cause));
  const buttons = [
    ...described,
    ...kept(checks, { optional: true }),
    ...kept(scripted, { optional: true }),
    ...keep(iconsFound),
    // More than a few is page content around the form, not its alternatives.
    ...(beside.length <= maxBeside ? located(beside, { optional: true, near: true }) : []),
  ].slice(0, maxCandidates);
  const chosen = [
    ...buttons,
    ...kept(links, { optional: true }).slice(0, Math.max(0, maxCandidates - buttons.length)),
  ];
  if (chosen.length === 0) return { ok: false, reason: unlocated ? "no-locator" : "no-candidates" };
  return withGap(observe(document, chosen, gap === undefined), gap);
}

/**
 * Where the fillable fields outside every form sit: their nearest common ancestor (a
 * lone field itself) and up to `formlessDepth` levels above it, or `undefined` when that
 * reaches the body or the root element, so the whole page counts. With no `<form>` to
 * start from, this reaches a little further than `besideDepth` does above a form, so a
 * row of fields beside a row with a select still holds both.
 */
function formlessFieldsArea(found: readonly Found[], document: Document): Element | undefined {
  const inputs = found.flatMap((entry) =>
    entry.kind === "candidate" && entry.form === null && fillTypes[entry.draft.role]
      ? [entry.draft.element]
      : [],
  );
  let area: Element | null = inputs[0] ?? null;
  while (area && !inputs.every((input) => containsAcross(area!, input)))
    area = composedParent(area);
  for (let depth = 0; depth < formlessDepth && area; depth++) area = composedParent(area);
  return area && area !== document.body && area !== document.documentElement ? area : undefined;
}

/** The gap a login form's control without a locator makes, by its role. */
const unlocatedGap = (role: ObservedCandidate["role"]): LoginGap =>
  fillTypes[role]
    ? "unlocated-field"
    : role === "checkbox"
      ? "unlocated-checkbox"
      : "unlocated-button";
