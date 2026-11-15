// The content script's side of a profile or site sign-in fill (ADR 0035): what it refuses
// to do in that mode, and how it waits for the login's next step without a set time.
import type * as v from "valibot";
import { fillOnlyStep } from "@pateat/contracts";
import { pageChange } from "../page/page-change";
import type { commandSchema } from "./wire/commands";
import type { LoginReadiness } from "./wire/readiness";
import type { FormDestination } from "../page/form-destination";

type Command = v.InferOutput<typeof commandSchema>;
type Execute = Extract<Command, { type: "login.execute" }>;
type FillChange = Extract<Command, { type: "login.fill.change" }>;

/** Marks the attempt ID of a confirmation page's fill (ADR 0035 delivery 3). */
export const CONFIRM_ATTEMPT_PREFIX = "confirm:";
/** Whether a fill operation fills a confirmation page for an authenticated login. */
export const confirmOperation = (operation: { attemptId: string }): boolean =>
  operation.attemptId.startsWith(CONFIRM_ATTEMPT_PREFIX);

/**
 * Reads where a passive fill's values may go now, and answers later whether they still go
 * only there. Only destinations that need the background's word or are refused are read
 * (`passiveDestinations`), so the page's own same-origin buttons may come and go.
 */
export function destinationWatch(read: () => FormDestination[]): () => boolean {
  const before = JSON.stringify(read());
  return () => JSON.stringify(read()) === before;
}

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
