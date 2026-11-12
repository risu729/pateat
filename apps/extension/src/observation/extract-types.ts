import type {
  LoginObservation,
  LoginKeypadTarget,
  LoginMarkerTarget,
  ObservedCandidate,
} from "@pateat/contracts";
import type { observationGaps } from "../login/wire";

/**
 * Why no observation was produced. A page without one is never sent to inference.
 * `no-locator` is a login page where a control of a login form lacks a locator
 * that names it alone, as when a hidden copy of the form shares the ids and names, and
 * nothing else can be described; a login form with nothing to locate or act on (only
 * fields that cannot be filled) gives `no-candidates`.
 */
export type ObservationRefusal = "unsupported-page" | "no-candidates" | "no-locator";

/**
 * Why an observation is incomplete, for diagnostics only (ADR 0019): the first cause in
 * the extractor's fixed order, never a page text, attribute value or count.
 *
 * - `unfillable-field`: a fillable field that cannot be filled (faint, read-only
 *   or disabled); on a signed-in page, only one that may be a sign-in field.
 * - `unsupported-control`: a control the executor cannot act on in a login form, such as
 *   a select, a radio button or a text area.
 * - `unlocated-field`, `unlocated-checkbox`, `unlocated-button`: a field, required checkbox or
 *   button of a login form without a locator that names it alone; for buttons, also an
 *   icon button in a form with no other button to submit with.
 * - `too-many-fields` (signed-in page), `too-many-candidates` (login page): more than the
 *   48 candidates an observation holds.
 * - For a list of accounts: `too-many-accounts` (more than eight), `unlisted-accounts` (an
 *   account whose text could not be sent), `too-many-elements` (more than the page scan
 *   reads) and `too-many-controls` (more than eight other controls).
 */
export type ObservationGap = (typeof observationGaps)[number];

export type ObservationResult =
  | {
      readonly ok: true;
      readonly observation: LoginObservation;
      readonly gap?: ObservationGap;
      /**
       * A signed-in page's description leaves out a disabled field that may not be a
       * sign-in field. The page is judged, but completes only on `signed-in` (owner,
       * 2026-10-12, ADR 0029). Never sent to the service.
       */
      readonly disabledLeftOut?: true;
      /**
       * A signed-in page shows a radio button, select or text area, or an ARIA widget for
       * one, that is no part of a site search (`leftOutInputs`), which its description
       * has no role for: the page may ask for a choice or an answer, so an `optional`
       * answer does not complete it (ADR 0065). Never sent to the service.
       */
      readonly inputLeftOut?: true;
    }
  | { readonly ok: false; readonly reason: ObservationRefusal };

export type Draft = Omit<ObservedCandidate, "id" | "target" | "group"> & { element: HTMLElement };

export type Found =
  | { kind: "candidate"; form: HTMLFormElement | null; draft: Draft }
  /**
   * A visible control the executor cannot act on, such as a select or a radio button.
   * `field` holds a text or password field that cannot be filled: read-only (as with
   * software keyboards), disabled until another step, or transparent or tiny.
   */
  | {
      kind: "unsupported";
      form: HTMLFormElement | null;
      field: HTMLInputElement | undefined;
      element: HTMLElement;
    };

/**
 * A page's software keyboard (ADR 0067) and the locator that names it for every field,
 * if any; without one, each field names it by its position from that field.
 */
export interface Keypad {
  readonly container: Element;
  readonly target: LoginKeypadTarget | undefined;
}

/**
 * The page's software keyboards (ADR 0067): each field's own (`of`), and the keys of
 * every keyboard on the page, whatever field it serves, which are never described and
 * whose text is never read.
 */
export interface Keypads {
  readonly of: (field: HTMLInputElement) => Keypad | undefined;
  readonly keys: ReadonlySet<Element>;
}

export type Chosen = { form: HTMLFormElement | null; draft: Draft; target: LoginMarkerTarget };
