// The content script's check of where a step's form sends the values it fills or clicks
// (ADR 0051): the page reads the destinations, and the background answers for each one
// off the document's origin by the login's vault item.
import * as v from "valibot";
import type { FormDestination } from "../page/form-destination";
import { destinationAnswerSchema, type ExecutionDetail } from "./wire";

/**
 * Why the step may not send its form where `read` says it goes: a destination the page
 * refuses, or one off the document's origin that the background does not allow by the
 * login's vault item (`ask`). The destinations are read again after the answers, and one
 * that changed meanwhile refuses the step as a changed form. `stopped` says why the step
 * ended while the background answered, if it did.
 */
export async function destinationRefusal(
  read: () => FormDestination[],
  ask: (destination: string) => Promise<unknown>,
  stopped: () => "document-cancelled" | "operation-expired" | undefined,
): Promise<ExecutionDetail | undefined> {
  const destinations = read();
  if (destinations.some((entry) => entry.kind === "refused")) return "form-off-origin";
  const answers = await Promise.all(
    destinations.flatMap((entry) =>
      entry.kind === "other-origin"
        ? [
            ask(entry.url)
              // A worker that cannot answer, as while it restarts, leaves it unchecked.
              .catch(() => undefined)
              .then((answer) => v.safeParse(destinationAnswerSchema, answer)),
          ]
        : [],
    ),
  );
  const stop = stopped();
  if (stop) return stop;
  if (answers.some((answer) => !answer.success)) return "form-destination-unchecked";
  const refusals = answers.flatMap((answer) =>
    answer.success && !answer.output.ok ? [answer.output.reason] : [],
  );
  if (refusals.some((reason) => reason !== "unchecked")) return "form-off-origin";
  if (refusals.length) return "form-destination-unchecked";
  if (JSON.stringify(read()) !== JSON.stringify(destinations)) return "form-changed";
  return undefined;
}
