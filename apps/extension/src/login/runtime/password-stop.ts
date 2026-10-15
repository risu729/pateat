import {
  attemptPlan,
  routeSteps,
  transitionLoginAttempt,
  type LoginAttemptEvent,
} from "@pateat/contracts";
import { newId } from "@pateat/contracts/ids";
import {
  atStop,
  type Execution,
  REQUEST_WAIT_MS,
  stepTargets,
  stopsPastPlan,
  terminal,
} from "./model";
import type { LoginReport, RouteChange, StopCause } from "./reports";
import type { RuntimeContext } from "./context";
import type { RuntimeState } from "./state";

/**
 * The stop before a password the item lacks (ADR 0036): waiting there for the page's
 * passkey request or button, and falling back from the `passkey` route.
 */
export function createPasswordStop(shared: RuntimeState) {
  const runtime = shared as RuntimeContext;
  const { effects, generation, report, spinning, settings } = shared;
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
  async function stopBeforePassword(run: Execution): Promise<void> {
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const stopped = () =>
      runtime.current(run) && run.metadata.state === "ready" && atStop(run.metadata);
    if (!(await runtime.allowed(run)) || !stopped()) return;
    let parked = runtime.parkedFor(run.live.document);
    let bridged = runtime.bridgeAnswer(run);
    for (
      const until = Date.now() + REQUEST_WAIT_MS;
      !parked && bridged === undefined && Date.now() < until;
    ) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(100);
      if (!stopped()) return;
      parked = runtime.parkedFor(run.live.document);
      bridged = runtime.bridgeAnswer(run);
    }
    if (!(await runtime.allowed(run)) || !stopped()) return;
    // A continuation the stop could not be moved into names why (ADR 0036).
    const end = (cause?: StopCause) =>
      runtime.change(
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
      if (await pressAtStop(run, stopped, () => end())) return;
      if (stopped()) await end();
      return;
    }
    // A stop just past the plan's last step holds the page on the path it answers on.
    const page = stopsPastPlan(run.metadata) ? await runtime.observe(run, [], []) : undefined;
    if (!stopped()) return;
    if (page) run.answeredPath = page.path;
    else delete run.answeredPath;
    const operationId = newId();
    await runtime.change(run, { type: "STOP_ANSWERED", operationId });
    const answering = () =>
      runtime.current(run) &&
      run.metadata.state === "reconciling" &&
      run.metadata.operationId === operationId;
    if (!answering()) {
      // An answer the attempt refuses, such as one past its submissions, ends the login.
      if (stopped()) await end();
      return;
    }
    const { tabId } = run.live.document;
    if (bridged !== undefined) {
      // The step that asked for a passkey is the answer's, so S5 skips it and a move to
      // the passkey's site completes (ADR 0029, ADR 0022).
      effects.set(tabId, {
        attemptId: run.metadata.id,
        at: bridged,
        document: run.live.document,
        submits: false,
        passkey: true,
      });
      run.answeredAt = bridged;
    } else if (parked) {
      effects.set(tabId, {
        attemptId: run.metadata.id,
        at: Date.now(),
        document: run.live.document,
        submits: false,
        passkey: true,
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
    await runtime.reconcileBounded(run);
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
  async function pressAtStop(
    run: Execution,
    stopped: () => boolean,
    end: () => Promise<void>,
  ): Promise<boolean> {
    const step = (attemptPlan(run.recipe, run.metadata) ?? [])[run.metadata.stopAt!]?.step;
    const stopFields = step ? stepTargets(step) : [];
    const page = await runtime.observe(
      run,
      stopFields,
      stopFields.map(() => "shown" as const),
    );
    if (!runtime.current(run)) return true;
    if (!page || !stopped()) return false;
    if (await runtime.enterHandler(run, page.path, { end })) return true;
    if (!runtime.current(run)) return true;
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
    return judgeStop(run, page.path, stopped, end);
  }
  /**
   * Sends the page at a login's stop, which still shows the stop step's password field, to be
   * judged once per attempt (`STOP_JUDGING`, recorded before the request), within the
   * judge's limits on the service (ADR 0036, owner 2026-10-13 05:39 UTC). The service keeps
   * only a `passkey` handler from it; the login takes the revision over and enters it
   * before the stop. Any other answer leaves the login to end at its stop. Returns whether
   * the caller leaves the login as it is.
   */
  async function judgeStop(
    run: Execution,
    path: string,
    stopped: () => boolean,
    end: () => Promise<void>,
  ): Promise<boolean> {
    if (!generation) return false;
    const notSent = (reason: string) => {
      report(run.live.document, {
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
    const described = await runtime.describeForJudge(run, path);
    if (!described) return true;
    if ("unsent" in described) return notSent(described.unsent);
    if (!stopped()) return false;
    const { observation, disabledLeftOut } = described;
    await runtime.change(run, judging);
    if (!runtime.current(run)) return true;
    if (!stopped() || run.metadata.stopJudged !== true) return false;
    const { recipe } = run;
    const reportJudge = (
      verdict: Extract<LoginReport, { type: "judge" }>["verdict"],
      detail: { reason?: string; takenOver?: boolean } = {},
    ) =>
      report(run.live.document, {
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
      });
    const spin = spinning(run.live.document.tabId);
    const {
      verdict,
      reason,
      recipe: added,
    } = await generation
      .judge(
        recipe.id,
        recipe.revision,
        "password",
        observation,
        spin.sent(() => reportJudge("sent")),
        undefined,
        disabledLeftOut ? true : undefined,
        true,
      )
      .finally(spin.stop);
    let reported = false;
    // Only a `passkey` handler is entered from the answer, at the stop.
    const movedOn =
      verdict === "challenge" &&
      added !== undefined &&
      stopped() &&
      (await runtime.takeOver(
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
    return movedOn || !runtime.current(run);
  }
  /**
   * The `passkey` route that answers its page's own request goes back to the password
   * variant the login recorded (ADR 0034), or ends `challenge` without one or with a stop
   * before the item's missing password (ADR 0036). It never answers again.
   */
  async function fallBack(
    run: Execution,
    cause: Exclude<RouteChange, "page-request">,
  ): Promise<void> {
    if (!runtime.current(run) || terminal(run.metadata)) return;
    run.passkeyFailed = true;
    const { variant } = run.metadata;
    const steps =
      variant === undefined ? 0 : routeSteps(run.recipe, { route: "password", variant }).length;
    // A login whose item lacks a password never goes back to its variant's stop (ADR 0036).
    if (variant === undefined || !steps || run.metadata.stopAt !== undefined) {
      await runtime.change(run, {
        type: "OBSERVED",
        result: "challenge",
        document: run.live.document,
      });
      return;
    }
    await runtime.change(
      run,
      { type: "ROUTE", route: "password", steps },
      undefined,
      undefined,
      cause,
    );
    if (!runtime.current(run) || run.metadata.route !== "password" || !run.choice) return;
    // The account choice saved after the sign-in names the password variant's binding.
    const snapshot = await settings.handle({ version: 1, type: "settings.get" });
    if (!runtime.current(run) || !snapshot.ok) return;
    const plan = await runtime.planFor(snapshot, run.live, run.recipe, {
      route: { route: "password", variant },
    });
    if (
      runtime.current(run) &&
      plan.ok &&
      plan.choice &&
      plan.account.connectionId === run.metadata.account.connectionId &&
      plan.account.itemId === run.metadata.account.itemId
    )
      run.choice = plan.choice;
  }
  return { fallBack, stopBeforePassword };
}
