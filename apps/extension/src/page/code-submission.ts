import type { LoginTarget } from "@pateat/contracts";
import { acceptsSecret } from "../login/inputs";
import { observedPath } from "../observation/path";
import { findTargets } from "./targets";

/** Whether the element is rendered and not hidden by its own style. */
export function visible(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return (
    element.isConnected &&
    !element.hidden &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    element.getClientRects().length > 0
  );
}

/**
 * The inputs of a code split into one input per digit that starts at `first` (ADR 0027,
 * owner decision 2026-10-12 19:21 UTC), in page order: the inputs of its form, or of no
 * form when it has none, that `usable` accepts, the TOTP fill rule accepts and that take
 * one character (`maxlength` 1), when `first` is the first of them and there are `length`
 * of them, 6 to 8. A `totp` handler's code goes into them one digit per input.
 */
export function splitCodeInputs(
  first: HTMLInputElement,
  length: number,
  usable: (input: HTMLInputElement) => boolean,
): HTMLInputElement[] | undefined {
  if (first.maxLength !== 1 || length < 6 || length > 8) return undefined;
  const inputs = first.form
    ? [...first.form.elements].filter((element) => element instanceof HTMLInputElement)
    : [...first.ownerDocument.querySelectorAll("input")].filter((input) => input.form === null);
  const digits = inputs.filter(
    (input) => input.maxLength === 1 && acceptsSecret(input, "otp") && usable(input),
  );
  return digits[0] === first && digits.length === length ? digits : undefined;
}

/**
 * How long a `totp` handler's code fill watches for the page submitting the code by itself
 * before its button may be clicked (ADR 0027). A code input that submits on its last digit
 * usually shows it at once (a submit event, a navigation, a disabled or busy form or
 * button); 2 seconds also covers one that verifies first and then moves on.
 */
export const CODE_SETTLE_MS = 2_000;
/**
 * How soon a Verify button disabled until the code is typed must be enabled once it is
 * in; the page's own handlers run at once or within a render. One still disabled after
 * this is checking the code itself (ADR 0027).
 */
export const CODE_ENABLE_MS = 500;
const busySelector = '[aria-busy="true"], [role="progressbar"], progress';

/**
 * Watches the page for signs that it submits a code by itself, from before the code is
 * typed (ADR 0027): a submit event of the field's form, the document starting to unload or
 * navigate, the field or form disabled, read-only, removed or replaced, the field cleared,
 * the submit button gone, hidden, busy after it was idle or disabled after it was enabled,
 * or a new busy indicator in the form. A button the page renders again at the same
 * locator, still shown and enabled, and a status message alone, such as a digit counter or
 * "Looks good", are not signs. A button still disabled `CODE_ENABLE_MS` after the code went
 * in is a sign too: a page that keeps Verify disabled with the code typed is checking the
 * code itself, and may enable Verify again only to take another code. So the button is
 * clicked only when, after the code went in, it was enabled within `CODE_ENABLE_MS` and
 * stayed enabled and idle since, with no other sign.
 *
 * The button's states come from a mutation observer, whose callbacks run as microtasks,
 * and from the old values its records carry, so neither a late poll in a background tab,
 * whose timers Chrome throttles, or on a busy page, nor an enable that lasts only until the
 * page disables the button again to check the code, is missed. Polling reads the rest and
 * stands in for the observer. `typed` marks the code going in, just before its input event
 * (for a split code, its last digit's) or at once for a field that already holds it, from
 * when the button's states and the busy indicators are read afresh;
 * `submitted` reads the page; `stop` disconnects the observer and removes the listeners.
 */
export function watchCodeSubmission(
  input: HTMLInputElement,
  field: LoginTarget,
  submit: LoginTarget,
  path: string,
  now: () => number = () => performance.now(),
): { typed: () => void; submitted: () => boolean; stop: () => void } {
  const page = input.ownerDocument;
  const matches = (target: LoginTarget) => findTargets(page, target);
  const form = input.form;
  let typedAt: number | undefined;
  /** When the button was first seen enabled once the code went in. */
  let enabledAt: number | undefined;
  // A button disabled until the code is typed counts as disabled by the page only once it
  // was enabled; one busy from the start never counts as newly busy.
  let enabledSeen = false;
  let idleSeen = false;
  /** The button went disabled after it was enabled, or busy after it was idle. */
  let changed = false;
  /** Feeds one state of the button, now or just before a recorded change, in order. */
  const see = (enabled: boolean, busy: boolean) => {
    if (enabled) {
      enabledSeen = true;
      if (typedAt !== undefined) enabledAt ??= now();
    } else if (enabledSeen) changed = true;
    if (!busy) idleSeen = true;
    else if (idleSeen) changed = true;
  };
  const isEnabled = (element: Element) =>
    !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true";
  const isBusy = (element: Element) => element.getAttribute("aria-busy") === "true";
  const button = () => {
    const found = matches(submit);
    return found.length === 1 ? found[0]! : undefined;
  };
  const current = button();
  if (current) see(isEnabled(current), isBusy(current));
  /** Feeds recorded changes in order, then the button's state now. */
  const feed = (records: readonly MutationRecord[]) => {
    const watched = button();
    if (!watched) return;
    // Each change's old value is the button's state just before it, so an enable the page
    // undid within the same task still counts as seen.
    for (const record of records) {
      if (record.type !== "attributes" || record.target !== watched) continue;
      const old = record.oldValue;
      if (record.attributeName === "disabled")
        see(old === null && watched.getAttribute("aria-disabled") !== "true", isBusy(watched));
      else if (record.attributeName === "aria-disabled")
        see(old !== "true" && !watched.hasAttribute("disabled"), isBusy(watched));
      else if (record.attributeName === "aria-busy") see(isEnabled(watched), old === "true");
    }
    see(isEnabled(watched), isBusy(watched));
  };
  const observer = new MutationObserver(feed);
  // The button may sit outside the form, joined to it by its `form` attribute or not at
  // all; then the whole document is watched.
  observer.observe(current && form?.contains(current) ? form : page.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: ["disabled", "aria-disabled", "aria-busy"],
  });
  let checked = false;
  const busyBefore = new Set(form ? form.querySelectorAll(busySelector) : []);
  let event = false;
  const mark = () => {
    event = true;
  };
  const onSubmit = (submitted: Event) => {
    if (submitted.target === form || (submitted.target as Node | null)?.contains?.(input))
      event = true;
  };
  const navigation = (page.defaultView as { navigation?: EventTarget } | null)?.navigation;
  const controller = new AbortController();
  const { signal } = controller;
  page.addEventListener("submit", onSubmit, { capture: true, signal });
  page.defaultView?.addEventListener("beforeunload", mark, { capture: true, signal });
  page.defaultView?.addEventListener("pagehide", mark, { capture: true, signal });
  navigation?.addEventListener("navigate", mark, { signal });
  return {
    typed: () => {
      if (typedAt !== undefined) return;
      // What the page did while the earlier digits of a split code went in answers a
      // partial code, such as Verify disabled until the code is whole, not a submission:
      // the button's states and the busy indicators count from the last digit.
      feed(observer.takeRecords());
      changed = false;
      enabledSeen = false;
      idleSeen = false;
      const shown = button();
      if (shown) see(isEnabled(shown), isBusy(shown));
      if (form) for (const element of form.querySelectorAll(busySelector)) busyBefore.add(element);
      typedAt = now();
    },
    submitted: () => {
      const at = now();
      const typed = typedAt ?? at;
      const first = !checked;
      checked = true;
      // `path` is a step's, as observations carry it (ADR 0039).
      if (event || observedPath(page.location.pathname) !== path) return true;
      const fields = matches(field);
      if (fields.length !== 1 || fields[0] !== input || !input.isConnected) return true;
      if (input.matches(":disabled") || input.readOnly || input.closest("[inert]")) return true;
      if (input.value === "") return true;
      if (
        form &&
        (!form.isConnected ||
          form.getAttribute("aria-busy") === "true" ||
          form.getAttribute("aria-disabled") === "true" ||
          [...form.querySelectorAll(busySelector)].some(
            (element) =>
              !busyBefore.has(element) &&
              element instanceof HTMLElement &&
              element.checkVisibility({ visibilityProperty: true }),
          ))
      )
        return true;
      const buttons = matches(submit);
      if (buttons.length === 0) return true;
      // Several matches leave the click step to refuse the button.
      if (buttons.length > 1) return false;
      const shown = buttons[0]!;
      if (!(shown instanceof HTMLElement) || !visible(shown)) return true;
      // Enabled at the first check after the code went in, however late it runs.
      if (first && isEnabled(shown)) enabledAt ??= typed;
      // Changes not yet delivered to the observer come first, so states stay in order.
      feed(observer.takeRecords());
      see(isEnabled(shown), isBusy(shown));
      if (changed) return true;
      const inTime = enabledAt !== undefined && enabledAt - typed <= CODE_ENABLE_MS;
      return !inTime && at - typed > CODE_ENABLE_MS;
    },
    stop: () => {
      observer.disconnect();
      controller.abort();
    },
  };
}
