// The content script's side of a profile or site sign-in fill (ADR 0035): what it refuses
// to do in that mode, and how it waits for the login's next step without a set time.
import type * as v from "valibot";
import { fillOnlyStep } from "@pateat/contracts";
import { pageChange } from "../page/page-change";
import { fillUntouched, fillWrote } from "../page/fill-edits";
import type { commandSchema } from "./wire/commands";
import type { LoginReadiness } from "./wire/readiness";
import type { FormDestination } from "../page/form-destination";

type Command = v.InferOutput<typeof commandSchema>;
type Execute = Extract<Command, { type: "login.execute" }>;
type FillChange = Extract<Command, { type: "login.fill.change" }>;

/** Marks the attempt ID of a confirmation page's fill (ADR 0035 delivery 3). */
export const CONFIRM_ATTEMPT_PREFIX = "confirm:";
/**
 * Marks the attempt ID of a confirmation page's fill the person asked for with **Fill** in
 * the popup (ADR 0035, amended 2026-11-17): it is also a confirmation fill.
 */
export const CONFIRM_PICK_ATTEMPT_PREFIX = `${CONFIRM_ATTEMPT_PREFIX}pick:`;
/** Whether a fill operation fills a confirmation page, for a login or the person's press. */
export const confirmOperation = (operation: { attemptId: string }): boolean =>
  operation.attemptId.startsWith(CONFIRM_ATTEMPT_PREFIX);
/** Whether a confirmation page's fill is the person's own **Fill** press. */
export const confirmPickOperation = (operation: { attemptId: string }): boolean =>
  operation.attemptId.startsWith(CONFIRM_PICK_ATTEMPT_PREFIX);

/**
 * Whether a passive fill leaves the value already in `input` as it is. As Bitwarden's
 * autofill on page load fills only empty password fields (`onlyEmptyFields`), a sign-in
 * fill keeps a password already in its input. A confirmation fill keeps any value already
 * there (ADR 0035 delivery 3), except that the person's own **Fill** replaces a value
 * Pateat wrote unless trusted input events show it was edited since; an edited input is
 * kept without reading its value (amended 2026-11-17).
 */
export function keepsValue(
  window: Window,
  operation: { attemptId: string },
  input: Element & { value: string },
  secret: string | undefined,
): boolean {
  if (confirmPickOperation(operation)) {
    if (!fillUntouched(window, input)) return true;
    return !fillWrote(window, input) && input.value !== "";
  }
  if (confirmOperation(operation)) return input.value !== "";
  return (
    (secret === "password" || (input instanceof HTMLInputElement && input.type === "password")) &&
    input.value.trim() !== ""
  );
}

/**
 * Reads where a passive fill's values may go now, and answers later whether they still go
 * only there. Only destinations that need the background's word or are refused are read
 * (`passiveDestinations`), so the page's own same-origin buttons may come and go. Once they
 * changed, the fill's inputs the person has not edited get back the values they had before
 * it, so no part of a value is left where Enter or a click could send it to the new
 * destination (ADR 0051). Any other fill reads its destinations once, beforehand.
 */
export function destinationWatch(
  operation: { signInFill?: boolean | undefined },
  read: () => FormDestination[],
  inputs: readonly Element[],
): () => boolean {
  if (!operation.signInFill) return () => true;
  const before = JSON.stringify(read());
  const values = inputs.map((input) => valueOf(input));
  return () => {
    if (JSON.stringify(read()) === before) return true;
    for (const [index, input] of inputs.entries()) {
      const value = values[index];
      const view = input.ownerDocument.defaultView;
      if (
        value === undefined ||
        !input.isConnected ||
        valueOf(input) === value ||
        !view ||
        !fillUntouched(view, input)
      )
        continue;
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value")?.set?.call(
        input,
        value,
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    return false;
  };
}

const valueOf = (input: Element): string | undefined =>
  input instanceof HTMLInputElement ||
  input instanceof HTMLTextAreaElement ||
  input instanceof HTMLSelectElement
    ? input.value
    : undefined;

/**
 * Just before a passive fill changes its first field: readiness may have awaited the page
 * since the operation was first authorized, so the background answers again, and the
 * destinations it checked must still be the ones the values go to. Returns why the fill
 * stops, if it does.
 */
export async function passiveRecheck(
  authorize: () => Promise<unknown>,
  destinationsCurrent: () => boolean,
): Promise<"not-authorized" | "form-changed" | undefined> {
  const authorized = await authorize().catch(() => undefined);
  if (authorized !== true) return "not-authorized";
  return destinationsCurrent() ? undefined : "form-changed";
}

/**
 * Whether a sign-in fill's command asks for more than filling ordinary fields or checking
 * the page: a click, an effectful fill, a keypad, a code, a choice, an account list or an
 * account switch. The document refuses it whatever the background sent.
 */
export function beyondSignInFill(command: Execute): boolean {
  const { step } = command.operation;
  return (
    step.kind === "click" ||
    fillOnlyStep(step) !== step ||
    command.code !== undefined ||
    command.choose === true ||
    command.list !== undefined ||
    command.accountSwitch !== undefined ||
    command.otherSwitch === true ||
    command.passwordChoice === true ||
    command.authenticatorChoice === true
  );
}

/**
 * Answers `login.fill.change`. Without a step, at the page's next sign of a change. With
 * one, once that step or one of `handlers` is ready, or with `settled` once the page moved
 * to another path; the page is checked again at each change, and the timeout is only the
 * bound (ADR 0082). With `changed`, the page waits for one change before its first check.
 */
export async function awaitFillChange(
  document: Document,
  command: FillChange,
  page: {
    ready: (readiness: LoginReadiness) => boolean;
    path: () => string;
    cancelled: () => boolean;
    signal: AbortSignal;
  },
): Promise<{ ok: boolean; timedOut?: true }> {
  const until = Date.now() + command.timeoutMs;
  const { readiness } = command;
  if (!readiness) {
    await pageChange(document, until, page.signal);
    return { ok: !page.cancelled() };
  }
  const from = page.path();
  const shown = () =>
    (command.settled ? page.path() !== from : page.ready(readiness)) ||
    (command.handlers ?? []).some((handler) => page.ready(handler));
  if (command.changed) {
    await pageChange(document, until, page.signal);
    if (Date.now() >= until) return { ok: !page.cancelled(), timedOut: true };
  }
  /* eslint-disable no-await-in-loop */
  while (!page.cancelled() && !shown()) {
    if (Date.now() >= until) return { ok: true, timedOut: true };
    await pageChange(document, until, page.signal);
  }
  /* eslint-enable no-await-in-loop */
  return { ok: !page.cancelled() };
}
