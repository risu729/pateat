// The content script's side of a profile or site sign-in fill (ADR 0035): what it refuses
// to do in that mode, and how it waits for the login's next step without a set time.
import type * as v from "valibot";
import { fillOnlyStep } from "@pateat/contracts";
import { pageChange } from "../page/page-change";
import type { commandSchema } from "./wire/commands";
import type { LoginReadiness } from "./wire/readiness";

type Command = v.InferOutput<typeof commandSchema>;
type Execute = Extract<Command, { type: "login.execute" }>;
type FillChange = Extract<Command, { type: "login.fill.change" }>;

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
