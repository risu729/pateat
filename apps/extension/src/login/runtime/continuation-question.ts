import * as v from "valibot";
import {
  builtInLoginSlots,
  isFieldExcluded,
  sameLoginTarget,
  type LoginObservation,
} from "@pateat/contracts";
import { extractResultSchema } from "../wire";
import { type Execution, type GenerationScope } from "./types";
import { change, current, report, send, spinning, spend } from "./attempt";

import { logCode, acceptedObservation, branchField, outcomeFields } from "./steps";

import { generationSlotsFor, usernameReads, customSlots } from "./generation-scope";
import { readUsernames, usernameShape, hideUsernames } from "./markers";
import { type GenerationOutcome } from "./report";
import type { Runtime } from "./state";

/** What `askContinuation` came to; `wait` and `refuse` were logged as `unsent`. */
export type AskedContinuation =
  | "moved"
  | "wait"
  | "refuse"
  | "not-described"
  | {
      answer: GenerationOutcome;
      /** Logs the answer once, with whether the login took its revision over. */
      reportGeneration: (takenOver?: boolean, notTakenOver?: string) => void;
      /** Forgets the request kept in memory for a later document, if this one took it. */
      settle: () => void;
    };

/**
 * Describes the page a recipe is continued on (ADR 0018) and sends it, recorded first in
 * the attempt under `key`: after a final `advance` step `operationId`, or in place of the
 * final `advance` click at plan step `before`, whose button stayed disabled while a
 * password input opened (ADR 0018 amendment of 2026-11-03). The description must show the
 * input the page qualified with (`byPassword`, `byIdentifier`), the login's own item must
 * match the page (ADR 0016), and only the slots the recipe does not fill yet are offered.
 * `unsent` logs, once per document, why the page is not sent; `wait` means a later round
 * may send it, `refuse` that this document will not. `asking` keeps the request for a
 * later document of the login and returns how to forget it.
 */
export async function askContinuation(
  rt: Runtime,
  run: Execution,
  options: {
    key: { operationId: string } | { before: number };
    path: string;
    byPassword: boolean;
    byIdentifier: boolean;
    unsent: (reason: string, detail?: string) => unknown;
    asking?: (answer: Promise<GenerationOutcome>) => () => void;
  },
): Promise<AskedContinuation> {
  const { recipe, metadata } = run;
  const { key, path, byPassword, byIdentifier, unsent } = options;
  const generation = rt.generation;
  if (!generation) return "refuse";
  const filled = new Set(
    recipe.steps.flatMap((step) =>
      step.kind === "fill" ? step.fields.map((field) => field.slot) : [],
    ),
  );
  // The fields the recipe already filled, on any path, may show again read-only, as an
  // email a password page on another path of the same document keeps (#831).
  const known = recipe.steps
    .flatMap((step) => (step.kind === "fill" ? step.fields.map((field) => field.target) : []))
    .slice(0, 24);
  let observation: LoginObservation | undefined;
  let missing = "extract-failed";
  // Why a described page is not sent, for the log (ADR 0019).
  let detail: string | undefined;
  try {
    const extracted = v.safeParse(
      extractResultSchema,
      await send(rt, run.live, {
        type: "login.extract",
        page: "login",
        ...(known.length ? { known } : {}),
        shown: true,
      }),
    );
    // The content script's refusal, such as `no-locator` or `extract-error`, as for a
    // first page; `extract-failed` for an answer that fails its check or never came.
    if (extracted.success && !extracted.output.ok) {
      missing = extracted.output.reason;
      if (extracted.output.detail) detail = logCode(extracted.output.detail);
    } else if (extracted.success && extracted.output.ok) {
      const accepted = acceptedObservation(extracted.output, {
        origin: run.live.document.origin,
        path,
      });
      if ("observation" in accepted) observation = accepted.observation;
      else {
        missing = "incomplete-observation";
        detail = accepted.detail;
      }
    }
  } catch {
    observation = undefined;
  }
  if (!current(rt, run)) return "moved";
  // An incomplete description is not sent and does not count; a later round tries again.
  if (!observation) {
    unsent(missing, detail);
    return "wait";
  }
  // The description must show the input the page qualified with, which it can leave out
  // where the two read the page differently, as an input in a form the description does
  // not keep.
  const fillTargets = recipe.steps.flatMap((step) =>
    step.kind === "fill" ? step.fields.map((field) => field.target) : [],
  );
  const described = observation.candidates.some(
    (candidate) =>
      (byPassword &&
        candidate.role === "password" &&
        candidate.autocomplete !== "new-password" &&
        candidate.autocomplete !== "one-time-code") ||
      (byIdentifier &&
        (candidate.role === "email" ||
          candidate.autocomplete === "username" ||
          candidate.autocomplete === "email") &&
        !fillTargets.some((target) => sameLoginTarget(target, candidate.target))),
  );
  if (!described) {
    unsent("field-not-described");
    return "not-described";
  }
  // The login's own item must match the page, as for a recipe's first page (ADR 0016).
  const scope = await generationSlotsFor(rt, run.live).catch(() => undefined);
  if (!current(rt, run)) return "moved";
  // The tab or the vault could not answer now, or no item matches; a later round asks again.
  if (!scope) {
    unsent("no-vault-match");
    return "wait";
  }
  if (
    !scope.items.some(
      ({ connection, item }) =>
        connection.id === metadata.account.connectionId && item.id === metadata.account.itemId,
    )
  ) {
    // A connection that did not answer or an item whose URI rules were not evaluated may
    // still hold it: a later round asks again.
    if (!scope.complete) {
      unsent("scope-incomplete");
      return "wait";
    }
    unsent("no-vault-match");
    return "refuse";
  }
  const pageOrigin = run.live.document.origin;
  // A slot the recipe already fills is not offered again, so the model cannot map it to a
  // field the page still shows (the service refuses such a page too).
  // A login that stops before its item's missing password offers the password slot too,
  // so the page can be continued up to its password step, which this login never runs
  // (ADR 0036). Only the slot goes out, never a value.
  const offered =
    metadata.stopAt !== undefined &&
    !scope.slots.some((slot) => slot.id === "password") &&
    ownPasswordField(rt, scope, metadata.account)
      ? [...scope.slots, builtInLoginSlots.password]
      : scope.slots;
  const slots = offered.filter((slot) => !filled.has(slot.id));
  // Likewise a custom field the recipe's generated slot map already names (ADR 0027).
  const named = await Promise.resolve(generation.slotFields(recipe.id)).catch(() => undefined);
  const offers = scope.offers.filter(
    (offer) =>
      !named?.some(
        ({ field }) =>
          typeof field !== "string" &&
          field.custom === offer.reference.custom &&
          field.position === offer.reference.position &&
          field.count === offer.reference.count,
      ),
  );
  const usernames = await readUsernames(rt, pageOrigin, usernameReads(rt, scope));
  const shape = usernames && usernameShape(rt, scope, usernames);
  // The page after an `advance` step can show the identifier just entered.
  const hidden = hideUsernames(rt, observation, usernames, run.live);
  if (!current(rt, run)) return "moved";
  // A username that could not be read now may be read on a later round; one that shows
  // where it cannot be hidden shows again.
  if ("reason" in hidden) {
    unsent(hidden.reason);
    return hidden.reason === "username-unread" ? "wait" : "refuse";
  }
  const custom = await customSlots(rt, pageOrigin, { ...scope, offers });
  if (!current(rt, run)) return "moved";
  if (!slots.length && !custom.length) {
    unsent("no-slots");
    return "refuse";
  }
  // Recorded before the request, so a restart never sends this step's page again.
  await change(rt, run, { type: "CONTINUING", ...key });
  // Left during the write, the record may hold `CONTINUING` with nothing sent: fail-closed,
  // the step's page then settles `unknown` unless the cache brings the continuation.
  if (!current(rt, run)) return "moved";
  if (!recordedContinuation(run, key)) return "refuse";
  // The page that asks, logged when its request leaves the device (ADR 0019).
  const page = run.live.document;
  const spin = spinning(rt, page.tabId);
  const askedAt = Date.now();
  const asked = generation
    .generate(
      {
        version: 1,
        observation: hidden.observation,
        slots: [
          ...slots.map((slot) =>
            slot.id === "username" && shape ? { ...slot, valueShape: shape } : slot,
          ),
          ...custom,
        ],
        base: {
          recipeId: recipe.id,
          revision: recipe.revision,
          ...("before" in key ? { replacesLast: true as const } : {}),
        },
        // The page continues the login's layout (ADR 0060); a chooser login's is its
        // branch's next page (ADR 0028).
        ...branchField(metadata),
      },
      spin.sent(() =>
        report(rt, page, {
          type: "generation",
          tabId: page.tabId,
          origin: pageOrigin,
          outcome: "sent",
          recipeId: recipe.id,
          baseRevision: recipe.revision,
        }),
      ),
    )
    .finally(spin.stop)
    // A thrown request frees its claim, so it is given back like any request that did not
    // reach the model.
    .catch((): GenerationOutcome => ({ outcome: "failed", reason: "error", retry: true }))
    // Counted once, for whichever document of the login takes the answer (ADR 0019).
    .then((answer) => {
      if (answer.outcome !== "skipped") spend(rt, metadata.id, Date.now() - askedAt, answer.timing);
      return answer;
    });
  const settle = options.asking?.(asked) ?? (() => undefined);
  const answer = await asked;
  const reportGeneration = (takenOver?: boolean, notTakenOver?: string) =>
    report(rt, run.live.document, {
      type: "generation",
      tabId: run.live.document.tabId,
      origin: pageOrigin,
      ...outcomeFields(answer),
      recipeId: recipe.id,
      baseRevision: recipe.revision,
      ...(takenOver === undefined ? {} : { takenOver }),
      ...(notTakenOver === undefined ? {} : { notTakenOver }),
    });
  return { answer, reportGeneration, settle };
}

/** Whether the attempt records the continuation request `key` as sent. */
export function recordedContinuation(
  run: Execution,
  key: { operationId: string } | { before: number },
): boolean {
  const recorded = run.metadata.continuation;
  if (!recorded) return false;
  return "before" in key
    ? "before" in recorded && recorded.before === key.before
    : "operationId" in recorded && recorded.operationId === key.operationId;
}

/**
 * Whether the login's own item, among a page's matching items, has a password field the
 * account may use, empty or not (ADR 0036).
 */
export function ownPasswordField(
  _rt: Runtime,
  scope: GenerationScope,
  owner: { connectionId: string; itemId: string },
): boolean {
  return scope.items.some(
    ({ connection, item }) =>
      connection.id === owner.connectionId &&
      item.id === owner.itemId &&
      item.fields.some((field) => field.id === "login.password") &&
      !isFieldExcluded(scope.settings, scope.catalog, connection.id, item.id, "login.password"),
  );
}
