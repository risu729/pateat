import { attemptPlan, transitionLoginAttempt, type LoginAttemptEvent } from "@pateat/contracts";
import type { ServiceTiming } from "../../service/transport";
import { newId } from "@pateat/contracts/ids";
import { type Execution } from "./types";
import { current, change, report, spinning, spend } from "./attempt";
import { atStop, stopsPastPlan } from "./attempt-state";
import { allowed } from "./plan-2";
import { parkedFor, bridgeAnswer } from "./passkey";
import { REQUEST_WAIT_MS } from "./constants";
import { type StopCause, type LoginReport } from "./report";
import { observe } from "./reconcile";
import { reconcileBounded } from "./sign-in";
import { stepTargets, branchOf } from "./steps";
import { enterHandler } from "./handlers";
import { describeForJudge } from "./judge";
import { judgeSlots } from "./generation-scope";
import { takeOver } from "./continuation";
import type { Runtime } from "./state";

/**
 * A login of an item without a password at its stop (ADR 0036) fills nothing there. It
 * waits up to `REQUEST_WAIT_MS` for its document's conditional passkey request, counting
 * one that was already waiting, and answers it with its item; a request the bridge
 * already answered since its last effect step counts the same. The answer is a
 * submission, recorded before a waiting request is answered, and the page is then
 * observed as after a click, held while the sign-in form still shows for up to
 * `REQUEST_HOLD_MS`. A stop just past the plan's last step has no form of its own: its
 * page is held while it stays on the path the answer was given on. Without a request the
 * login ends `challenge`, watched, as `password-empty`.
 */
export async function stopBeforePassword(rt: Runtime, run: Execution): Promise<void> {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const stopped = () => current(rt, run) && run.metadata.state === "ready" && atStop(run.metadata);
  if (!(await allowed(rt, run)) || !stopped()) return;
  let parked = parkedFor(rt, run.live.document);
  let bridged = bridgeAnswer(rt, run);
  for (
    const until = Date.now() + REQUEST_WAIT_MS;
    !parked && bridged === undefined && Date.now() < until;
  ) {
    // eslint-disable-next-line no-await-in-loop
    await sleep(100);
    if (!stopped()) return;
    parked = parkedFor(rt, run.live.document);
    bridged = bridgeAnswer(rt, run);
  }
  if (!(await allowed(rt, run)) || !stopped()) return;
  // A continuation the stop could not be moved into names why (ADR 0036).
  const end = (cause?: StopCause) =>
    change(
      rt,
      run,
      { type: "OBSERVED", result: "challenge", document: run.live.document },
      undefined,
      cause,
      undefined,
      run.stopMiss ? `password-empty:${run.stopMiss}` : "password-empty",
    );
  if (!parked && bridged === undefined) {
    // A passkey button beside the stop's password field is pressed instead (owner,
    // 2026-10-13 05:39 UTC); its request is then answered here as any.
    if (await pressAtStop(rt, run, stopped, () => end())) return;
    if (stopped()) await end();
    return;
  }
  // A stop just past the plan's last step holds the page on the path it answers on.
  const page = stopsPastPlan(run.metadata) ? await observe(rt, run, [], []) : undefined;
  if (!stopped()) return;
  if (page) run.answeredPath = page.path;
  else delete run.answeredPath;
  const operationId = newId();
  await change(rt, run, { type: "STOP_ANSWERED", operationId });
  const answering = () =>
    current(rt, run) &&
    run.metadata.state === "reconciling" &&
    run.metadata.operationId === operationId;
  if (!answering()) {
    // An answer the attempt refuses, such as one past its submissions, ends the login.
    if (stopped()) await end();
    return;
  }
  const { tabId } = run.live.document;
  if (bridged !== undefined) {
    // The step that asked for a passkey is the answer's, so S5 skips its answered request
    // and a move to the passkey's site completes (ADR 0029, ADR 0022).
    rt.effects.set(tabId, {
      attemptId: run.metadata.id,
      at: bridged,
      document: run.live.document,
      submits: false,
      passkey: true,
      request: true,
      requestAt: bridged,
    });
    run.answeredAt = bridged;
  } else if (parked) {
    const deliveredAt = Date.now();
    rt.effects.set(tabId, {
      attemptId: run.metadata.id,
      at: deliveredAt,
      document: run.live.document,
      submits: false,
      passkey: true,
      request: true,
      requestAt: deliveredAt,
    });
    const item = {
      connectionId: run.metadata.account.connectionId,
      itemId: run.metadata.account.itemId,
    };
    const target = parked;
    // The bridge says whether the assertion went back; a request that went away
    // meanwhile was never answered.
    let gone = false;
    const signed = await new Promise<boolean>((resolve) => {
      gone = !target.settle({ kind: "answer", item, answered: resolve });
      if (gone) resolve(false);
    });
    if (!answering()) return;
    if (!signed) {
      await end(gone ? undefined : "answer-failed");
      return;
    }
    run.answeredAt = Date.now();
  }
  await reconcileBounded(rt, run);
}

/**
 * At a login's stop with no passkey request in time (ADR 0036, owner 2026-10-13 05:39
 * UTC): enters a `passkey` handler of the recipe shown on the page, before the stop step,
 * so its button is pressed and the request that follows is answered with the item. With
 * none, a page that still shows the stop step's password field on its path, where the
 * recipe has no `passkey` handler yet, is sent once to be judged for such a button
 * (`judgeStop`). Returns whether the caller leaves the
 * login as it is: moved on, ended, or no longer this run's.
 */
export async function pressAtStop(
  rt: Runtime,
  run: Execution,
  stopped: () => boolean,
  end: () => Promise<void>,
): Promise<boolean> {
  const step = (attemptPlan(run.recipe, run.metadata) ?? [])[run.metadata.stopAt!]?.step;
  const stopFields = step ? stepTargets(step) : [];
  const page = await observe(
    rt,
    run,
    stopFields,
    stopFields.map(() => "shown" as const),
  );
  if (!current(rt, run)) return true;
  if (!page || !stopped()) return false;
  if (await enterHandler(rt, run, page.path, { end })) return true;
  if (!current(rt, run)) return true;
  // A path that has a `passkey` handler already gets no other: the service would refuse
  // it as a duplicate, so the page is not judged for one.
  if (
    !stopped() ||
    !step ||
    page.path !== step.path ||
    !page.targets.some((state) => state === "unique") ||
    (run.recipe.handlers ?? []).some(
      (handler) => handler.kind === "passkey" && handler.path === page.path,
    )
  )
    return false;
  return judgeStop(rt, run, page.path, stopped, end);
}

/**
 * Sends the page at a login's stop, which still shows the stop step's password field, to be
 * judged once per attempt (`STOP_JUDGING`, recorded before the request), within the
 * judge's limits on the service (ADR 0036, owner 2026-10-13 05:39 UTC). The service keeps
 * only a `passkey` handler from it; the login takes the revision over and enters it
 * before the stop. Any other answer leaves the login to end at its stop. Returns whether
 * the caller leaves the login as it is.
 */
export async function judgeStop(
  rt: Runtime,
  run: Execution,
  path: string,
  stopped: () => boolean,
  end: () => Promise<void>,
): Promise<boolean> {
  if (!rt.generation) return false;
  const notSent = (reason: string) => {
    report(rt, run.live.document, {
      type: "judge",
      tabId: run.live.document.tabId,
      origin: run.live.document.origin,
      recipeId: run.recipe.id,
      recipeRevision: run.recipe.revision,
      route: run.metadata.route,
      verdict: "not-sent",
      reason,
      stop: "password",
    });
    return false;
  };
  // The service judges no stop's page of a chooser (ADR 0028), so a chooser login's stop
  // presses only a handler its branch already holds (ADR 0036, account lists).
  if (run.metadata.chooser) return notSent("chooser");
  const judging: LoginAttemptEvent = { type: "STOP_JUDGING" };
  if (run.metadata.stopJudged) return notSent("stop-judged");
  if (transitionLoginAttempt(run.metadata, judging).stopJudged !== true) return false;
  const described = await describeForJudge(rt, run, path);
  if (!described) return true;
  if ("unsent" in described) return notSent(described.unsent);
  if (!stopped()) return false;
  const { observation, disabledLeftOut, usernameShape: shape } = described;
  await change(rt, run, judging);
  if (!current(rt, run)) return true;
  if (!stopped() || run.metadata.stopJudged !== true) return false;
  // The account's slots go with the page, as for every judged page (owner 2026-10-23).
  const judged = await judgeSlots(
    rt,
    run.live.document.origin,
    run.metadata.account,
    run.metadata.route,
    { usernameShape: shape },
  );
  if (!current(rt, run)) return true;
  if (!stopped()) return false;
  const { recipe } = run;
  // The answer's timing, once it came (ADR 0019).
  let timed: { timing?: ServiceTiming } = {};
  const reportJudge = (
    verdict: Extract<LoginReport, { type: "judge" }>["verdict"],
    detail: { reason?: string; takenOver?: boolean } = {},
  ) =>
    report(rt, run.live.document, {
      type: "judge",
      tabId: run.live.document.tabId,
      origin: run.live.document.origin,
      recipeId: recipe.id,
      recipeRevision: recipe.revision,
      route: "password",
      verdict,
      ...detail,
      ...(disabledLeftOut ? { disabledLeftOut: true as const } : {}),
      stop: "password",
      ...timed,
    });
  const spin = spinning(rt, run.live.document.tabId);
  const asked = Date.now();
  const {
    verdict,
    reason,
    recipe: added,
    timing,
  } = await rt.generation
    .judge(
      recipe.id,
      recipe.revision,
      "password",
      observation,
      spin.sent(() => reportJudge("sent")),
      branchOf(run.metadata),
      disabledLeftOut ? true : undefined,
      true,
      judged.slots,
    )
    .finally(spin.stop);
  spend(rt, run.metadata.id, Date.now() - asked, timing);
  if (timing) timed = { timing };
  let reported = false;
  // Only a `passkey` handler is entered from the answer, at the stop.
  const movedOn =
    verdict === "challenge" &&
    added !== undefined &&
    stopped() &&
    (await takeOver(
      rt,
      run,
      added,
      path,
      () => {
        reported = true;
        reportJudge(verdict, { takenOver: true });
      },
      { end },
    ));
  if (!reported)
    reportJudge(verdict, {
      ...(reason ? { reason } : {}),
      ...(added ? { takenOver: false } : {}),
    });
  return movedOn || !current(rt, run);
}
