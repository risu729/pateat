import { codeInput, shortNumericInput } from "../login/inputs";
import { authenticatorChoice } from "../page/authenticator-choice";
import { autocompleteTokens } from "../page/targets";
import { closestAcross, composedOrder, readingPage } from "../page/shadow";
import { observedPath } from "./path";
import {
  buttonText,
  isFragmentButton,
  isRoleButton,
  openModals,
  readBehindModal,
} from "../page/text";
import type { ObservationGap, ObservationResult, Draft } from "./extract-types";
import { maxCandidates, fillTypes } from "./extract-controls";
import { withoutNumbers, headerText, shownWords } from "./extract-text";
import { locatorIndex, locate, passwordChoiceTarget } from "./extract-locators";
import {
  autocomplete,
  leftOutInputs,
  markerWidgets,
  markerWidgetTarget,
  describeAll,
  maxSelects,
  describeSelects,
} from "./extract-candidates";
import { observe, byLandmark } from "./extract-observe";

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
 * navigation first (`byLandmark`), listed in document order.
 *
 * The judge refuses a page that still shows a sign-in field, so every field that may be
 * one must be described: more fields than the limit mark the observation incomplete,
 * and so does a field that may be a sign-in field
 * (`mayBeSignIn`) but cannot be located or filled. A field that may not, such as a search
 * box with no ID, a password change form's field or a hotel search's read-only date
 * picker, is left out (owner, 2026-10-12, ADR 0029). A disabled one is left out too, but
 * the result says so (`disabledLeftOut`): it may be a code field waiting for a timer or a
 * sent code, so such a page completes only when the judge answers `signed-in`. Up to
 * twelve shown single-choice selects follow the fields as `select`, by their label and
 * `autocomplete` and never their options, located by a lasting attribute or left out, so
 * the judge can name a split birth date's or card expiry date's parts (ADR 0061). A radio
 * button or text area, or an ARIA widget for one, is left out as well, and the result
 * says when the page shows one, or any select, that is no part of a site search
 * (`inputLeftOut`, `leftOutInputs`): an `optional` answer does not complete such a page
 * (ADR 0065). Buttons
 * and links are only possible markers; those past the limit or without a locator are
 * left out, and an ID another load may change (`changingId`) locates no element but a
 * field that may be a sign-in field. A link is located by its text too, as for an
 * account switch, and the executor looks for the completion marker the same way. A button
 * that nothing else names alone, or a link to a fragment of the page, that may go on to
 * the password is located by its accessible name (`passwordChoiceTarget`), such a link as a
 * `button`, so the judge can name it as a `password` handler's button (ADR 0048
 * amendment of 2026-10-19); no other page's description uses that locator. A shown tab,
 * menu item, tree item or link widget an attribute names is a `link` candidate too
 * (`markerWidgets`, ADR 0029 amendment of 2026-11-04). A path
 * segment that may carry a token is sent as `REDACTED_PATH_SEGMENT` (`observedPath`). A
 * page with a code field also carries up to three texts near the first one
 * (`nearCodeTexts`), and a page without one up to three texts near its buttons
 * (`nearButtonTexts`), hidden as the rest of the page. While a modal dialog is open, the
 * page behind it that the modal's script marked `aria-hidden` or `inert` is read as
 * shown (`readBehindModal`), and the modal's controls rank right after the header's.
 */
export function extractSignedInObservation(
  document: Document = globalThis.document,
): ObservationResult {
  return readingPage(() => readBehindModal(document, () => describeSignedIn(document)));
}

function describeSignedIn(document: Document): ObservationResult {
  const location = document.location;
  if (!location) return { ok: false, reason: "unsupported-page" };

  const found = describeAll(document);
  // One gap is reported; any gap makes it incomplete.
  let gap: ObservationGap | undefined;
  let disabledLeftOut = false;
  const inputLeftOut = leftOutInputs(document);
  const fieldEntries: { form: HTMLFormElement | null; draft: Draft }[] = [];
  const markers: { form: HTMLFormElement | null; draft: Draft }[] = [];
  for (const entry of found) {
    if (entry.kind === "unsupported") {
      // A disabled field may be a code field waiting for a timer or a sent code: one that
      // may not be a sign-in field is left out, but only `signed-in` completes the page.
      if (entry.field && mayBeSignIn(entry.field)) gap ??= "unfillable-field";
      else if (entry.field?.matches(":disabled")) disabledLeftOut = true;
    } else if (fillTypes[entry.draft.role]) fieldEntries.push(entry);
    else if (entry.draft.role !== "checkbox") markers.push(entry);
  }
  const index = locatorIndex(document);
  const header = headerText(document);
  const headerWords = shownWords(header);
  // A marker's locator is stored and must match every later sign-in, so text with a
  // number character, such as a balance or an unread count, never names one, nor does
  // an ID another load may change. A field that may be a sign-in field keeps such an
  // ID, as on a login page, rather than leave the page incomplete, and is located by its
  // visible name before it (ADR 0037), as a recipe's fill and a `totp` handler's code
  // field name it; a name with a number, which this page's text never shows, is not used
  // unless it numbers an input of a split code (`numbersCodeDigit`). A `role="button"`
  // element is located by its text only when it names the authenticator app's code
  // (`authenticatorChoice`, ADR 0081 amendment of 2026-11-03), as the method buttons of a
  // "Verify your identity" page often are: a login presses such a button by that text,
  // while a signed-in marker is looked up among links, never among such widgets.
  // On a page that shows a code input, any such element is located by its text too
  // (ADR 0027 amendment of 2026-11-04), as Notion's "Continue" below its code is: the
  // judge may name it as the code's button, and the service never takes a text button
  // of such a page for a signed-in marker.
  // A link that shows the same text keeps it, as on any judged page, rather than two
  // candidates sharing one target.
  // A code input as the service's `isCodeField` reads the description, which leaves a
  // number input's length out: one the service would not count would leave a widget
  // free to become a marker no later lookup finds.
  const codePage = fieldEntries.some(
    ({ draft: { element } }) =>
      element instanceof HTMLInputElement &&
      codeInput(element) &&
      (element.type !== "number" || autocompleteTokens(element).includes("one-time-code")),
  );
  const linkShares = (element: Element) => {
    const text = buttonText(element);
    return text !== undefined && index.get("link-text")!.has(text);
  };
  const located = (entries: typeof fieldEntries) =>
    entries.flatMap((entry) => {
      const { element } = entry.draft;
      const signIn =
        element instanceof HTMLInputElement && fillTypes[element.type] && mayBeSignIn(element);
      const target = locate(element, index, {
        redactAttributes: true,
        links: true,
        lasting: !signIn,
        labels: signIn,
        hidden: !signIn,
        roles:
          isRoleButton(element) &&
          (codePage || authenticatorChoice(element)) &&
          !linkShares(element),
        paths: headerWords,
      });
      return target && !(target.by === "text" && /\p{Number}/u.test(target.value))
        ? [{ ...entry, target }]
        : [];
    });
  const fieldsFound = located(fieldEntries);
  // A select is no sign-in field: one without a lasting locator, or past the limit, is
  // left out (ADR 0061).
  const selectsFound = located(describeSelects(document)).slice(0, maxSelects);
  if (fieldsFound.length > maxCandidates) gap ??= "too-many-fields";
  // A field nothing can locate is left out unless it may be a sign-in field, as a search
  // box with no ID or a password change form's fields are not (S2 of ADR 0029: a new
  // password, or a form with two or more password fields; fields outside a form count as
  // one form).
  else if (
    fieldEntries.some(
      ({ form, draft: { element } }) =>
        element instanceof HTMLInputElement &&
        mayBeSignIn(element) &&
        !(
          element.type === "password" &&
          (autocompleteTokens(element).includes("new-password") ||
            fieldEntries.filter(
              (other) =>
                other.form === form &&
                other.draft.element instanceof HTMLInputElement &&
                other.draft.element.type === "password",
            ).length >= 2)
        ) &&
        !fieldsFound.some((kept) => kept.draft.element === element),
    )
  )
    gap ??= "unlocated-field";
  // A button or link that may go on to the password is located by its accessible name when
  // nothing else names it alone, and a link to a fragment of the page by that name first,
  // as a button, since only that locator counts it as one (ADR 0048 amendment of
  // 2026-10-19).
  const markersFound = markers.flatMap((entry) => {
    const { element } = entry.draft;
    const named = () => passwordChoiceTarget(element, index);
    const fragment = isFragmentButton(element);
    const target = fragment
      ? (named() ?? located([entry])[0]?.target)
      : (located([entry])[0]?.target ?? named());
    if (!target) return [];
    return [
      {
        ...entry,
        draft:
          target.by === "accessible-name"
            ? { ...entry.draft, role: "button" as const }
            : entry.draft,
        target,
      },
    ];
  });
  // A tab, menu item or tree item an attribute names may be a marker too (ADR 0029
  // amendment of 2026-11-04), in document order among the links and buttons.
  const widgetsFound = markerWidgets(document).flatMap((draft) => {
    const target = markerWidgetTarget(draft.element, index);
    return target
      ? [{ form: closestAcross(draft.element, "form") as HTMLFormElement | null, draft, target }]
      : [];
  });
  const ranked = byLandmark(
    [...markersFound, ...widgetsFound].sort((left, right) =>
      composedOrder(left.draft.element, right.draft.element),
    ),
    openModals(document),
  );
  const fieldsShown = [...fieldsFound, ...selectsFound].slice(0, maxCandidates);
  const chosen = [
    ...fieldsShown,
    ...ranked.slice(0, Math.max(0, maxCandidates - fieldsShown.length)),
  ];
  if (chosen.length === 0) return { ok: false, reason: "no-candidates" };
  const result = observe(
    document,
    chosen,
    gap === undefined,
    (text) => withoutNumbers(text),
    undefined,
    header,
    observedPath(location.pathname),
    true,
  );
  if (!result.ok) return result;
  return {
    ...result,
    ...(gap ? { gap } : {}),
    ...(disabledLeftOut ? { disabledLeftOut: true as const } : {}),
    ...(inputLeftOut ? { inputLeftOut: true as const } : {}),
  };
}
