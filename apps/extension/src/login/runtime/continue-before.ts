import {
  attemptPlan,
  continuesRecipe,
  loginStepEffect,
  transitionLoginAttempt,
  type LoginStep,
} from "@pateat/contracts";
import { type Execution } from "./types";
import { change, current, report } from "./attempt";
import { askContinuation, cachedRoute, continueWith, recordedContinuation } from "./continuation";
import { probeMode } from "./constants";
import type { Runtime } from "./state";

// A recipe whose final `advance` click waits on a button the page keeps disabled while a
// password input opens beside it, as a form that shows its password input only once the
// email is typed and enables its button only once both are filled: the page is sent so its
// steps replace that click, which never ran (ADR 0018 amendment of 2026-11-03). The content
// script reports the input as it opens, on the page's own change, with no wait of its own.

/**
 * Whether the login's next step `step` is a final `advance` click whose page may be sent
 * to replace it: a `password` login on its recipe's own steps (variant 0) in the tab's page
 * or a frame of it (ADR 0086), with recipe generation configured, no handler entered, no stop, no chooser and not
 * only filling, at the plan's last step, a click of the recipe itself, whose recipe fills
 * no password and has no completion or alternatives. A request already recorded for the
 * step counts, so a restart may take its answer from the cache; one this document refused
 * does not.
 */
export function replaceableClick(rt: Runtime, run: Execution, step: LoginStep): boolean {
  const { metadata, recipe } = run;
  if (
    !rt.generation ||
    !rt.uris ||
    (probeMode && metadata.account.origin === rt.vars.origin) ||
    recipe.completion !== undefined ||
    recipe.alternatives !== undefined ||
    step.kind !== "click" ||
    loginStepEffect(step) !== "advance" ||
    run.revealRefused === metadata.stepIndex ||
    recipe.steps.some(
      (entry) => entry.kind === "fill" && entry.fields.some((field) => field.slot === "password"),
    )
  )
    return false;
  const plan = attemptPlan(recipe, metadata);
  const at = plan?.[metadata.stepIndex];
  if (
    !plan ||
    plan.length !== metadata.stepCount ||
    plan.length !== recipe.steps.length ||
    !at ||
    at.handler !== undefined ||
    at.step !== recipe.steps.at(-1)
  )
    return false;
  const key = { before: metadata.stepIndex };
  if (recordedContinuation(run, key)) return true;
  // The attempt's own rules (`replaceable`): the dry run records the request.
  const after = transitionLoginAttempt(metadata, { type: "CONTINUING", ...key });
  return (
    after.continuation !== undefined &&
    "before" in after.continuation &&
    after.continuation.before === key.before
  );
}

/**
 * Sends the page of the login's final `advance` click whose button stayed disabled while a
 * password input opened, once per such step, and takes over the revision whose page's
 * steps replace that click (`continueWith` with `replacesLast`). A request already spent,
 * as after a restart during it, takes that revision from the cache. Anything else leaves
 * the login at its click, which this document then waits for as any step's elements, and
 * never asks again. Returns whether the login took the revision over.
 */
export async function continueBefore(rt: Runtime, run: Execution): Promise<boolean> {
  const { metadata, recipe } = run;
  const before = metadata.stepIndex;
  const key = { before };
  const path = recipe.steps.at(-1)!.path;
  const refuse = () => {
    run.revealRefused = before;
    return false;
  };
  /** Logs once per document why the page is not sent. */
  const unsent = (reason: string, detail?: string) => {
    if (run.live.generationSkip === reason) return;
    run.live.generationSkip = reason;
    report(rt, run.live.document, {
      type: "generation",
      tabId: run.live.document.tabId,
      origin: run.live.document.origin,
      outcome: "skipped",
      reason,
      ...(detail ? { detail } : {}),
      recipeId: recipe.id,
      baseRevision: recipe.revision,
    });
  };
  const options = { replacesLast: true };
  if (recordedContinuation(run, key)) {
    const cached = await cachedRoute(rt, run, path).catch(() => undefined);
    if (!current(rt, run)) return false;
    if (
      cached &&
      cached.revision > recipe.revision &&
      continuesRecipe(recipe, cached, options) &&
      (await continueWith(rt, run, cached, undefined, undefined, options))
    )
      return true;
    return refuse();
  }
  const sent = await askContinuation(rt, run, {
    key,
    path,
    byPassword: true,
    byIdentifier: false,
    unsent,
  });
  if (typeof sent === "string") return refuse();
  const { answer, reportGeneration } = sent;
  if (!current(rt, run)) {
    reportGeneration();
    return false;
  }
  refuse();
  if (answer.outcome !== "recipe") {
    reportGeneration();
    // A request that did not reach the model, or was not sent, is given back for the
    // login's next document to send.
    if (answer.retry) await change(rt, run, { type: "UNCONTINUED", before });
    return false;
  }
  let reported = false;
  // Why the login did not take the revision over, always logged (ADR 0019).
  let refusal = "not-recorded";
  try {
    return await continueWith(
      rt,
      run,
      answer.recipe,
      () => {
        reported = true;
        reportGeneration(true);
      },
      (reason) => {
        refusal = reason;
      },
      options,
    );
  } finally {
    if (!reported) reportGeneration(false, refusal);
  }
}
