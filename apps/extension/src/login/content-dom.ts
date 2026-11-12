import { sameLoginTarget, type LoginMarkerTarget, type LoginTarget } from "@pateat/contracts";

import { autocompleteTokens, findTargets } from "../page/targets";
import { closestAcross, formOf, queryAll, readingPage, shadowRoots } from "../page/shadow";
import {
  choosable,
  clickable,
  codeMarked,
  keyable,
  targetCheck,
  writable,
} from "../page/target-state";
import { chooseOption, optionFor, type WantedOption } from "../page/select-option";
import { findKeypad, keypadField, keypadInput } from "../page/keypad";

import { inputValueMismatch } from "../page/fill-checks";
import { typeValue } from "../page/enter-value";
import { nextFrame } from "../page/frames";
import { pageWatch } from "../page/quiet";
import { presence } from "../observation/extract";
import { clickableSwitch, entryLike, listControls } from "../page/account-list";
import { listsAccounts } from "./no-input-offer";
import { observedPath } from "../observation/path";
import { askedQuestion, type AskedQuestion } from "../page/question";
import { type LoginReadiness, type AwaitMiss, type LaterMiss, type LoginSecretKind } from "./wire";

/**
 * This page's path as observations and recipes carry it, each token-like segment replaced
 * (`observedPath`, ADR 0039): every path this script reports, or compares with a step's,
 * reads this, so a step on `/[id]/login` runs on the same page of any tenant.
 */
export const pagePath = () => observedPath(location.pathname);
/** The page's URL without its fragment, which changes no page. */
export const pageUrl = () => location.href.split("#")[0]!;
/** Fixed locators deliberately reject duplicates rather than taking the first match. */
export function matches(target: LoginMarkerTarget, links = false): Element[] {
  return findTargets(document, target, { links });
}
/** A button that submits its form: `<button type=submit>` or `<input type=submit|image>`. */
export function submitButton(element: Element): element is HTMLButtonElement | HTMLInputElement {
  return (
    (element instanceof HTMLButtonElement && element.type === "submit") ||
    (element instanceof HTMLInputElement && (element.type === "submit" || element.type === "image"))
  );
}
/**
 * Whether `input` still asks the secret question the fill names, when it names one (ADR
 * 0061): its field's name, or the question the owner confirmed for that field as one whole
 * question beside it. A split date's select asks none.
 */
export const stillAsks = (input: Control, question: AskedQuestion | undefined) =>
  question === undefined ||
  (input instanceof HTMLInputElement && askedQuestion(input, [question]) === 0);
/** An input a fill types into, or a select a split date's part sets (ADR 0061). */
export type Control = HTMLInputElement | HTMLSelectElement;
/**
 * Empties inputs a fill typed into, with the page's `input` and `change` events, as when
 * the account check it left to the click found another account (ADR 0049).
 */
export function clearTyped(inputs: Control[]): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return;
  for (const input of inputs)
    if (input instanceof HTMLInputElement && input.isConnected && input.value !== "") {
      setter.call(input, "");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
}
/**
 * Whether `element` may take a value of `secret` now: a writable input, or, for a split
 * birth date's or card expiry date's part only (ADR 0061), a choosable select.
 */
export const takes = (element: Element | undefined, secret: LoginSecretKind | undefined) =>
  writable(element) || (secret === "date-part" && choosable(element));
/** A fill value as the content script checks it against its input (ADR 0010, ADR 0061). */
export type FitValue = WantedOption & { group?: number | undefined };
/**
 * Whether `value` fits `control` before anything is filled (ADR 0010): an input's type and
 * declared lengths, and for a card number's or PIN's digit group a `maxlength` of exactly
 * the group's; a select needs one option that says the number (`optionFor`, ADR 0061).
 */
export function fitsControl(control: Control, value: FitValue) {
  if (control instanceof HTMLSelectElement) return optionFor(control, value) !== undefined;
  return (
    inputValueMismatch(control, value.value) === undefined &&
    (value.group === undefined || control.maxLength === value.group)
  );
}
/**
 * Puts `value` into `control` as a person would: types it into an input (`typeValue`), or
 * chooses a select's one option that says it (ADR 0061), never one by its position, and
 * passes it to `chosen`. A select whose choice the page's handlers undid is `refused`.
 */
export async function enter<Cause extends string>(
  control: Control,
  value: FitValue,
  setter: (this: HTMLInputElement, value: string) => void,
  options: Parameters<typeof typeValue<Cause>>[3],
  chosen?: (option: HTMLOptionElement) => void,
): Promise<Cause | "refused" | undefined> {
  if (control instanceof HTMLInputElement) return typeValue(control, value.value, setter, options);
  options?.beforeInput?.();
  const option = optionFor(control, value);
  if (!option || !chooseOption(control, option)) return "refused";
  chosen?.(option);
  return undefined;
}
export const isOnly = (found: readonly Element[], element: Element) =>
  found.length === 1 && found[0] === element;
/** How long after a `wrong-account` result its account switch may still be clicked. */
export const switchTimeoutMs = 10_000;
/**
 * Whether a recipe's account switch may be clicked: by the same rule as the page's own
 * control for another account and a list's (ADR 0078), whatever its element type.
 */
export function switchable(element: Element | undefined): element is HTMLElement {
  return element !== undefined && entryLike(element) && clickableSwitch(element);
}
/** Whether a step's elements are ready now: the path matches and each target is unique and usable. */
export const ready = (readiness: LoginReadiness) => readingPage(() => readyNow(readiness));
export function readyNow(readiness: LoginReadiness): boolean {
  if (pagePath() !== readiness.path) return false;
  // A chooser's list (ADR 0028): one of its buttons, or an account it lists by email.
  if (readiness.accounts)
    return (
      !showsSignIn() &&
      (readiness.targets.some(
        (target) =>
          listControls(document, target, "other").length === 1 ||
          listControls(document, target, "continue").length === 1,
      ) ||
        listsAccounts(document))
    );
  return stepMiss(readiness) === undefined;
}
/**
 * Why a step is not ready now, for the log when its wait runs out (`AwaitMiss`): another
 * path, the first target's check that failed, or what else a later step's page shows. A
 * field entered on the page's keypad, which may be read-only (ADR 0067), counts as ready
 * once it shows; a chooser's list is not explained.
 */
export function readinessMiss(readiness: LoginReadiness): AwaitMiss | undefined {
  if (pagePath() !== readiness.path) return "path";
  if (readiness.accounts) return undefined;
  for (const target of readiness.targets) {
    if (
      readiness.keypad?.some((other) => sameLoginTarget(other, target)) &&
      matches(target).length === 1 &&
      keyable(matches(target)[0])
    )
      continue;
    const check = targetCheck(document, target, readiness.require);
    if (check !== "ok") return check;
  }
  const miss = stepMiss(readiness);
  return miss === "target" ? undefined : miss;
}
/**
 * Why a step on this path is not ready (`LaterMiss`): a target that matches no unique
 * usable element, a username or password target on a code input, or for a later step (ADR 0049) the page's other identifier input, or what
 * else the page asks for beside a password started alone.
 */
export function stepMiss(readiness: LoginReadiness): LaterMiss | undefined {
  const usable = readiness.targets.every((target) => {
    const found = matches(target);
    if (found.length !== 1) return false;
    // A field entered on the page's keypad may be read-only (ADR 0067).
    if (readiness.require === "writable")
      return readiness.keypad?.some((other) => sameLoginTarget(other, target))
        ? keyable(found[0])
        : writable(found[0]);
    if (readiness.require === "settable") return writable(found[0]) || choosable(found[0]);
    // A control named by its accessible name may be a link to a fragment of its page.
    if (readiness.require === "clickable")
      return clickable(found[0], { fragment: target.by === "accessible-name" });
    return true;
  });
  if (!usable) return "target";
  // A username or password never goes into a code input (issue #1413).
  if (readiness.signIn?.some((target) => codeMarked(matches(target)[0]))) return "code-input";
  // A later step is no start while the page also asks for an identifier the step does not
  // fill, as a form for another account with its own email input (ADR 0049).
  if (readiness.later && credentialInputs(readiness.targets).identifier) return "identifier";
  return readiness.absent ? passwordAloneMiss(readiness.targets, readiness.absent) : undefined;
}
/**
 * Whether a recipe's final `advance` click waits on a button the page keeps from clicks
 * beside a password input that opened in its form (ADR 0018 amendment of 2026-11-03): its
 * one target shows but takes no click, and a visible writable password input that is no
 * new password or one-time code shares the button's form (outside any form, the page
 * outside forms). Its page may then be sent to replace the click.
 */
export function revealsPassword(readiness: LoginReadiness): boolean {
  const [target] = readiness.targets;
  if (pagePath() !== readiness.path || readiness.targets.length !== 1 || !target) return false;
  if (targetCheck(document, target, "clickable") !== "not-clickable") return false;
  const button = matches(target)[0]!;
  const form =
    button instanceof HTMLButtonElement || button instanceof HTMLInputElement
      ? formOf(button)
      : (closestAcross(button, "form") as HTMLFormElement | null);
  return queryAll<HTMLInputElement>(document, "input").some((input) => {
    const tokens = autocompleteTokens(input);
    return (
      input.type === "password" &&
      formOf(input) === form &&
      writable(input) &&
      presence(input) === "visible" &&
      !tokens.includes("new-password") &&
      !tokens.includes("one-time-code")
    );
  });
}
/** Input types a person types an account identifier or a code into. */
export const textTypes = new Set(["text", "email", "tel", "number", "url"]);
/**
 * What a page that shows a later step's password input also asks for beside the password,
 * so the step may not start with its password alone (ADR 0049): `absent`, one of the
 * targets the step drops shows writable; `form-input`, another visible writable text input
 * shares the password input's form; `new-password`, the password input or another input of
 * its form (of the page outside forms, without one) is marked `new-password`, as on a
 * sign-up or password change form.
 */
export function passwordAloneMiss(
  targets: readonly LoginTarget[],
  absent: readonly LoginTarget[],
): "absent" | "form-input" | "new-password" | undefined {
  const shown = (element: Element) => writable(element) && presence(element) === "visible";
  if (absent.some((target) => matches(target).some(shown))) return "absent";
  const own = new Set(
    targets
      .flatMap((target) => matches(target))
      .filter((element) => element instanceof HTMLInputElement),
  );
  // A password input outside any form counts every input outside a form as its form.
  const forms = new Set([...own].map(formOf));
  const newPassword = (input: HTMLInputElement) =>
    autocompleteTokens(input).includes("new-password");
  let miss: "form-input" | "new-password" | undefined;
  for (const input of queryAll<HTMLInputElement>(document, "input")) {
    const form = formOf(input);
    if (own.has(input) ? newPassword(input) : forms.has(form) && newPassword(input))
      return "new-password";
    // Outside a form, another text input, as a page's search box, tells nothing.
    if (
      !own.has(input) &&
      form !== null &&
      forms.has(form) &&
      textTypes.has(input.type) &&
      shown(input)
    )
      miss = "form-input";
  }
  return miss;
}
/**
 * Whether the page shows a visible password input, or one marked for a username or a
 * one-time code: the only pages without a recipe that may be sent for generation
 * (ADR 0016). A read-only one counts beside a software keyboard (`keypadField`,
 * ADR 0067).
 */
export function showsSignIn(): boolean {
  return queryAll<HTMLInputElement>(document, "input").some((input) => {
    const tokens = autocompleteTokens(input);
    // The keypad is looked for only for a read-only input that may take its characters.
    if (!writable(input) && keyable(input) && keypadInput(input))
      return keypadField(input, findKeypad(document, input));
    return (
      (input.type === "password" ||
        tokens.includes("username") ||
        tokens.includes("one-time-code")) &&
      writable(input)
    );
  });
}
/**
 * The HTTP status of this document's own load, when the browser reports one (ADR 0041); a
 * status the page cannot see, as for a cached or cross-origin redirected load, reads as 0
 * and is left out.
 */
export function navigationStatus(): number | undefined {
  try {
    const [entry] = performance.getEntriesByType("navigation") as (PerformanceEntry & {
      responseStatus?: number;
    })[];
    const status = entry?.responseStatus;
    return typeof status === "number" && status >= 100 && status <= 599 ? status : undefined;
  } catch {
    return undefined;
  }
}
/**
 * The sign-in inputs the page shows that a generated recipe can continue on after its final
 * `advance` step (ADR 0018), other than the inputs the recipe's own `targets` each find
 * alone: `password`, a visible writable password input; `identifier`, a visible writable
 * email input or one marked for a username or an email address. Visible as the page's description reads it, so an input
 * hidden from assistive technology, transparent, tiny or moved before the page's start, as
 * a password input kept on an email form for the browser to fill, never counts. An input marked
 * `new-password` or `one-time-code`, and every input of a form that holds one, never
 * counts: a sign-up, password change or code form is not a sign-in page to continue on,
 * and a code page is judged instead (ADR 0027).
 */
export function credentialInputs(targets: readonly LoginMarkerTarget[]): {
  password: boolean;
  identifier: boolean;
} {
  // A target names the recipe's field only when it finds that one element alone, as a step
  // fills it: a test attribute an identifier input shares with the password input added
  // beside it names neither (issue #1413).
  const own = new Set(
    targets.flatMap((target) => {
      const found = matches(target);
      return found.length === 1 ? found : [];
    }),
  );
  const other = (input: HTMLInputElement) =>
    autocompleteTokens(input).some(
      (token) => token === "new-password" || token === "one-time-code",
    );
  const all = queryAll<HTMLInputElement>(document, "input");
  // A form's inputs include those tied to it by a `form` attribute and those in the shadow
  // trees of its components (ADR 0070).
  const otherForms = new Set(all.filter(other).map(formOf));
  const inputs = all.filter((input) => {
    if (own.has(input) || !writable(input) || presence(input) !== "visible" || other(input))
      return false;
    const form = formOf(input);
    return !(form && otherForms.has(form));
  });
  return {
    password: inputs.some((input) => input.type === "password"),
    identifier: inputs.some(
      (input) =>
        input.type === "email" ||
        autocompleteTokens(input).some((token) => token === "username" || token === "email"),
    ),
  };
}
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * How often at most the page watch checks a page that keeps changing (ADR 0082). A set
 * time that bounds the watch's work, not a wait for the page: the first change after a
 * quiet spell is checked at the next frame.
 */
export const checkGapMs = 100;
/**
 * How long a preparing fill waits for the page's own input handlers before checking that
 * the page accepted the values (ADR 0010). A set time still to be replaced (ADR 0082): a
 * page validator debounced by 100 ms or more would show its error only after a click.
 */
export const fillSettleMs = 500;
/**
 * What a first-visit page without a sign-in input is gets decided once its DOM has had no
 * change for `offerQuietMs`, or `offerWaitMs` after the wait began while it keeps changing
 * (ADR 0057). A sign-in input is still offered until `LOGIN_STEP_WAIT_MS` (ADR 0016).
 */
export const offerQuietMs = 1000;
export const offerWaitMs = 5000;
/**
 * A fill compared with the account the page shows, while the page shows no identifier
 * to compare with, waits until the document has loaded and its DOM has had no change for
 * `accountQuietMs`, or `accountWaitMs` while it keeps changing: Duolingo's sign-in shows its remembered account's address after the password
 * field (2026-10-23), and a check before it would pass. It ends `accountReserveMs` before
 * the operation expires, so a page that keeps changing is still compared and filled.
 */
export const accountQuietMs = 1000;
export const accountWaitMs = 5000;
export const accountReserveMs = 2000;

/**
 * Calls `look` at the page's next frame after a DOM change in `document` or in a shadow
 * tree an earlier look found (ADR 0070), however many changes come before it and at most
 * once per `checkGapMs` (ADR 0082). `later` asks for a look as a change does; after
 * `stop`, no look runs.
 */
export function lookOnChange(
  document: Document,
  look: () => void,
): { later: () => void; stop: () => void } {
  let pending = false;
  let stopped = false;
  let lookedAt = Number.NEGATIVE_INFINITY;
  const observed = new WeakSet<ShadowRoot>();
  const run = () => {
    pending = false;
    if (stopped) return;
    lookedAt = Date.now();
    // Shadow trees attached since the last look are watched too.
    for (const root of shadowRoots(document))
      if (!observed.has(root)) {
        observed.add(root);
        changes.observe(root, pageWatch);
      }
    look();
  };
  const later = () => {
    if (pending || stopped) return;
    pending = true;
    const gap = lookedAt + checkGapMs - Date.now();
    if (gap <= 0) void nextFrame().then(run);
    else setTimeout(() => void nextFrame().then(run), gap);
  };
  const changes = new MutationObserver(later);
  changes.observe(document, pageWatch);
  return {
    later,
    stop: () => {
      stopped = true;
      changes.disconnect();
    },
  };
}
