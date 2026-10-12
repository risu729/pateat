import type { LoginTarget } from "@pateat/contracts";
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
 * the submit button gone, hidden, busy or disabled after it was enabled, or a new busy
 * indicator in the form. A button the page renders again at the same locator, still shown
 * and enabled, and a status message alone, such as a digit counter or "Looks good", are
 * not signs. A button still disabled `CODE_ENABLE_MS` after the code went in is a sign
 * too: a page that keeps Verify disabled with the code typed is checking the code itself,
 * and may enable Verify again only to take another code.
 *
 * The moment the button becomes enabled is taken from a mutation observer, whose callbacks
 * run as microtasks, so a late poll in a background tab, whose timers Chrome throttles, or
 * on a busy page never mistakes an ordinary page for one that checks the code itself.
 * `typed` marks the code going in, just before its input event; `submitted` reads the
 * page; `stop` disconnects the observer and removes the listeners.
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
  const flags = (element: Element) => ({
    enabled: !element.matches(":disabled") && element.getAttribute("aria-disabled") !== "true",
    busy: element.getAttribute("aria-busy") === "true",
  });
  const enabledButton = () => {
    const buttons = matches(submit);
    return buttons.length === 1 && flags(buttons[0]!).enabled;
  };
  // A button disabled until the code is typed counts as disabled by the page only once it
  // was enabled; one busy from the start never counts as newly busy.
  const found = matches(submit);
  const initial = found.length === 1 ? flags(found[0]!) : undefined;
  let enabledSeen = initial?.enabled === true;
  let idleSeen = initial !== undefined && !initial.busy;
  let typedAt: number | undefined;
  /** When the button was first enabled once the code went in. */
  let enabledAt: number | undefined;
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
  const observer = new MutationObserver(() => {
    if (typedAt !== undefined && enabledAt === undefined && enabledButton()) enabledAt = now();
  });
  // The button may sit outside the form; then the whole document is watched.
  observer.observe(form ?? page.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["disabled", "aria-disabled"],
  });
  page.addEventListener("submit", onSubmit, true);
  page.defaultView?.addEventListener("beforeunload", mark, true);
  page.defaultView?.addEventListener("pagehide", mark, true);
  navigation?.addEventListener("navigate", mark);
  return {
    typed: () => {
      typedAt ??= now();
    },
    submitted: () => {
      const at = now();
      const typed = typedAt ?? at;
      const first = !checked;
      checked = true;
      if (event || page.location.pathname !== path) return true;
      const current = matches(field);
      if (current.length !== 1 || current[0] !== input || !input.isConnected) return true;
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
      const button = buttons[0]!;
      if (!(button instanceof HTMLElement) || !visible(button)) return true;
      const state = flags(button);
      if (state.enabled) {
        enabledSeen = true;
        // Enabled at the first check after the code went in, however late it runs.
        if (first) enabledAt ??= typed;
      } else if (enabledSeen) return true;
      if (!state.busy) idleSeen = true;
      else if (idleSeen) return true;
      const inTime = enabledAt !== undefined && enabledAt - typed <= CODE_ENABLE_MS;
      return !inTime && at - typed > CODE_ENABLE_MS;
    },
    stop: () => {
      observer.disconnect();
      page.removeEventListener("submit", onSubmit, true);
      page.defaultView?.removeEventListener("beforeunload", mark, true);
      page.defaultView?.removeEventListener("pagehide", mark, true);
      navigation?.removeEventListener("navigate", mark);
    },
  };
}
