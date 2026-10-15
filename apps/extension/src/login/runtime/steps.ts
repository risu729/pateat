import * as v from "valibot";
import {
  attemptPlan,
  effectfulStep,
  nextLoginOperation,
  loginStepEffect,
  passkeyAnswersRequest,
  recoverLoginAttempt,
  validateLoginOperation,
} from "@pateat/contracts";
import {
  executionResultSchema,
  loginReadiness,
  HELD_CLICK_WAIT_MS,
  LOGIN_STEP_WAIT_MS,
  type LoginSecretKind,
} from "../wire";
import { loginFillsUsername, loginSecretKind, loginUsernameFieldId } from "../vault";
import { newId } from "@pateat/contracts/ids";
import {
  atStop,
  DocumentGone,
  type Execution,
  inPlaceNext,
  markerProof,
  terminal,
  WATCH_SETTLE_MS,
} from "./model";
import { codeStep } from "./recipes";
import type { RuntimeContext } from "./context";
import type { RuntimeState } from "./state";

/** Running a login's steps in its document, and watching its pages afterwards. */
export function createSteps(shared: RuntimeState) {
  const runtime = shared as RuntimeContext;
  const {
    reportAttempt,
    report,
    publish,
    fields,
    settings,
    passwordFills,
    effects,
    signInUrls,
    send,
  } = shared;
  // State transitions, journal writes and DOM effects form an ordered protocol.
  // Parallel execution would race policy checks or repeat submission side effects.
  /* eslint-disable no-await-in-loop */
  async function reconcileBounded(run: Execution): Promise<void> {
    // An advance is confirmed by the next step's elements, which get the same wait as any
    // fill or click; other results keep the shorter observation budget.
    let until =
      Date.now() + (run.metadata.operationEffect === "advance" ? LOGIN_STEP_WAIT_MS : 3000);
    // A held click's button may show this long before the page is left to the person.
    const holdUntil = Date.now() + HELD_CLICK_WAIT_MS;
    const observing = () => ["awaiting-result", "reconciling"].includes(run.metadata.state);
    // Each round re-authorizes against settings, so the longer advance budget polls slower.
    const interval = run.metadata.operationEffect === "advance" ? 200 : 50;
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    while (runtime.current(run) && observing()) {
      const settle = Date.now() >= until;
      const held = await runtime.reconcile(run, settle);
      if (!runtime.current(run) || !observing()) return;
      if (held) {
        if (Date.now() >= holdUntil) {
          await runtime.change(run, {
            type: "OBSERVED",
            result: "challenge",
            document: run.live.document,
          });
          return;
        }
        // Once the button is gone, the result gets the usual budget.
        until = Math.max(until, Date.now() + 3000);
        await sleep(500);
        continue;
      }
      // A failed observation leaves the attempt for its next document to reconcile.
      if (settle) return;
      await sleep(interval);
    }
  }
  /**
   * Checks a new page of the tab while the login is watched after a `challenge` (ADR 0027),
   * reading only: it never fills or clicks. The login completes on a signed-in marker,
   * read for a short while as after a click, or on a confirmed sign-in state (ADR 0029: E1
   * to E3). A page with no sign of a sign-in going on and no evidence is judged, from the
   * watch's own pages: `signed-in` completes and `rejected` ends the login as a refused
   * password, while any other answer, a refusal or a spent budget leaves it watched, with a
   * warning in the log. The document the watch began in is not checked again.
   */
  async function watchPage(run: Execution): Promise<void> {
    const { watch } = run.metadata;
    if (!watch || run.live.document.documentId === watch.documentId) return;
    const proof = markerProof(run.recipe);
    const watching = () => runtime.current(run) && run.metadata.state === "watching";
    if (proof.targets.length > 0) {
      const until = Date.now() + WATCH_SETTLE_MS;
      for (;;) {
        const observed = await runtime.observe(run, proof.targets, proof.shown, proof.links);
        if (!observed || !watching()) return;
        if (proof.proves(observed.targets)) {
          await runtime.change(run, {
            type: "OBSERVED",
            result: "authenticated",
            document: run.live.document,
          });
          return;
        }
        if (Date.now() >= until) break;
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    } else await new Promise<void>((resolve) => setTimeout(resolve, WATCH_SETTLE_MS));
    if (!watching()) return;
    const state = await runtime.signInState(run);
    if (!watching()) return;
    if (state?.decision === "signed-in" && state.confirmed) {
      await runtime.change(run, {
        type: "OBSERVED",
        result: "authenticated",
        document: run.live.document,
      });
      return;
    }
    // The sign-in form shown again with a failure, in the first new document after the
    // submission, rejects the password even after the watch began (owner, 22:03 UTC).
    if (state?.decision === "rejected" && state.confirmed && state.reshown) {
      await runtime.change(run, {
        type: "OBSERVED",
        result: "credential-rejected",
        document: run.live.document,
      });
      return;
    }
    // So does that form shown again with nothing else on it ask again, as when the
    // submitted page settled first.
    if (state?.formAgain && state.confirmed && state.decision === "unknown") {
      await runtime.askAgain(run);
      return;
    }
    // Only a page with no sign of a sign-in going on is judged; an undecided answer never
    // completes a watched login.
    if (state?.decision === "judge") await runtime.learn(run);
  }
  async function drive(run: Execution): Promise<void> {
    if (run.running) return;
    run.running = true;
    try {
      // A failure that changed nothing on the page is tried again from the same step, up
      // to the attempt's retry budget; a spent budget ends it `retry-limit` (owner
      // decision, 2026-10-12). A TOTP code's click after the code is in is never retried:
      // a late click could submit an expired code (ADR 0027).
      for (;;) {
        await runSteps(run);
        if (!runtime.current(run) || run.metadata.state !== "retryable") return;
        const final = codeStep(run.recipe, run.metadata, run.metadata.stepIndex) === "click";
        await runtime.change(run, final ? { type: "RETRY", final: true } : { type: "RETRY" });
      }
    } catch (error) {
      if (runtime.current(run) && !terminal(run.metadata)) {
        run.metadata = recoverLoginAttempt(run.metadata);
        // A submit that replaced the document is how most logins go on: the next document
        // resumes the attempt, so this is no exception (2026-10-12 logs).
        if (error instanceof DocumentGone)
          reportAttempt(run.metadata, run.recipe, undefined, {
            stop: "document-gone",
            // A fill-only login keeps `fill-only` as its reason.
            ...(run.metadata.fillOnly ? {} : { reason: error.reason }),
          });
        else
          report(run.metadata.document, {
            type: "exception",
            tabId: run.metadata.document.tabId,
            origin: run.metadata.document.origin,
            recipeId: run.metadata.recipeId,
            recipeRevision: run.metadata.recipeRevision,
            route: run.metadata.route,
            state: run.metadata.state,
            stepIndex: run.metadata.stepIndex,
            name: error instanceof Error ? error.name : typeof error,
            ...(error instanceof Error ? { message: error.message } : {}),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          });
        await runtime.save(run).catch(() => undefined);
        await publish(run.live, run.metadata);
      }
    } finally {
      run.running = false;
    }
  }
  /** Runs the attempt's steps until it leaves `ready`; `drive` owns errors and retries. */
  async function runSteps(run: Execution): Promise<void> {
    if (run.metadata.state === "watching") {
      await watchPage(run);
      return;
    }
    if (run.metadata.state === "reconciling" || run.metadata.state === "awaiting-result")
      await reconcileBounded(run);
    while (runtime.current(run) && run.metadata.state === "ready") {
      // The page's own passkey request decides the route before anything is submitted,
      // and that route answers it instead of taking a step on the page (ADR 0034).
      if (await runtime.switchToPasskey(run)) continue;
      if (
        run.metadata.route === "passkey" &&
        run.metadata.stepIndex === 0 &&
        passkeyAnswersRequest(run.recipe)
      ) {
        await runtime.answerRequest(run);
        // A step that was not authorized or not prepared leaves the login where it was, as
        // a refused step does below; it is driven again from the page.
        if (
          runtime.current(run) &&
          run.metadata.state === "ready" &&
          run.metadata.route === "passkey" &&
          run.metadata.stepIndex === 0
        )
          return;
        continue;
      }
      // A login of an item without a password fills nothing at its stop, but answers its
      // page's passkey request there (ADR 0036).
      if (atStop(run.metadata)) {
        await runtime.stopBeforePassword(run);
        if (runtime.current(run) && run.metadata.state === "ready" && atStop(run.metadata)) return;
        continue;
      }
      if (!(await runtime.allowed(run))) return;
      // A fill or click waits for its elements before any intent, vault read or value
      // delivery; a slow render is not a failure until the owner-approved limit passes.
      const upcoming = attemptPlan(run.recipe, run.metadata)?.[run.metadata.stepIndex]?.step;
      // A fill-only login stops before anything that may advance or submit (ADR 0021 D).
      if (run.metadata.fillOnly && (!upcoming || effectfulStep(upcoming))) {
        await runtime.endFillOnly(run);
        return;
      }
      if (upcoming?.kind === "fill" || upcoming?.kind === "click") {
        // A code input may submit by itself once the code is in, as one that submits on
        // its last digit does; its click then has nothing left to do (ADR 0027).
        const afterCode =
          upcoming.kind === "click" &&
          codeStep(run.recipe, run.metadata, run.metadata.stepIndex) === "click";
        if (afterCode && (await runtime.submittedByPage(run, upcoming))) {
          if (!runtime.current(run) || run.metadata.state !== "ready") return;
          if (await runtime.codeSubmitted(run)) continue;
          await runtime.change(
            run,
            { type: "FAILED", reason: "structural-mismatch" },
            undefined,
            "code-not-submitted",
          );
          return;
        }
        if (!runtime.current(run) || run.metadata.state !== "ready") return;
        // A chooser login's click on its list waits for the list (ADR 0028).
        const waited = await runtime.waitFor(
          run,
          run.chooser && run.metadata.stepIndex === 0
            ? runtime.listReadiness(run.chooser)
            : loginReadiness(upcoming),
        );
        if (!runtime.current(run) || run.metadata.state !== "ready") return;
        if (waited === "timeout") {
          if (
            afterCode &&
            (await runtime.submittedByPage(run, upcoming)) &&
            runtime.current(run) &&
            run.metadata.state === "ready" &&
            (await runtime.codeSubmitted(run))
          )
            continue;
          if (!runtime.current(run) || run.metadata.state !== "ready") return;
          await runtime.change(
            run,
            { type: "FAILED", reason: "structural-mismatch" },
            undefined,
            "elements-timeout",
          );
          return;
        }
        if (waited !== "ready" || !(await runtime.allowed(run))) return;
        // A request the page made while the step waited still decides the route before the
        // first submission, as a chooser login's click on its list is (ADR 0034).
        if (await runtime.switchToPasskey(run)) continue;
      }
      const operation = nextLoginOperation(run.metadata, run.recipe, run.live.document, newId());
      if (!operation) {
        await runtime.change(
          run,
          { type: "FAILED", reason: "structural-mismatch" },
          undefined,
          "no-operation",
        );
        return;
      }
      // An advance whose next step is on its path is confirmed by that step's elements
      // only if they were not usable just before it (ADR 0013).
      const inPlace = inPlaceNext(run.recipe, run.metadata, operation.stepIndex);
      delete run.inPlace;
      // Known before its intent is recorded, so a stop in between takes the intent back.
      run.operation = operation;
      run.delivered = false;
      await runtime.change(run, {
        type: "PREPARE",
        operationId: operation.operationId,
        kind: operation.step.kind,
        effect: loginStepEffect(operation.step),
      });
      if (operation.step.kind === "click")
        await runtime.change(run, { type: "SUBMIT_INTENT", operationId: operation.operationId });
      else if (operation.step.kind === "fill")
        await runtime.change(run, { type: "MUTATION_INTENT", operationId: operation.operationId });
      const authorized = await runtime.allowed(run);
      if (!authorized) return;
      if (
        !validateLoginOperation(
          operation,
          run.metadata,
          run.live.document,
          run.metadata.policyRevision,
        )
      ) {
        // Nothing went to the page, so a fill is tried again, as one the page refused before
        // any input is, rather than observed as one that may have submitted.
        await runtime.change(
          run,
          {
            type: "FAILED",
            reason: "timeout",
            ...(operation.step.kind === "fill" &&
            run.metadata.operationId === operation.operationId &&
            run.metadata.mutationIntent === true
              ? {
                  mutation: "none" as const,
                  operationId: operation.operationId,
                  document: operation.document,
                }
              : {}),
          },
          undefined,
          "operation-invalid",
        );
        return;
      }
      const values: { slot: string; value: string; secret?: LoginSecretKind }[] = [];
      let expected: { username: string } | undefined;
      let list: ({ username: string; others: string[] } & Record<string, unknown>) | undefined;
      let response: unknown;
      try {
        if (operation.step.kind === "fill") {
          for (const field of operation.step.fields) {
            const reference = authorized.binding.slots.find((entry) => entry.slot === field.slot);
            if (!reference) {
              await runtime.change(
                run,
                { type: "FAILED", reason: "structural-mismatch" },
                undefined,
                "slot-unbound",
              );
              return;
            }
            // Vault reads are serial so a denial stops before any later field is released.
            let value: string | undefined;
            try {
              value = await fields({
                account: run.metadata.account,
                connection: authorized.connection,
                fieldId: reference.fieldId,
              });
            } catch {
              // A failed read is not a page mutation; never reclassify it as uncertain.
              value = undefined;
            }
            if (!runtime.current(run)) return;
            // Locked, resynchronized or newly denied vault access withdraws this grant.
            if (value === undefined) {
              await runtime.change(run, { type: "POLICY_CHANGED" }, { cause: "field-unavailable" });
              return;
            }
            // A `totp` handler's code fills only a code input, whatever field it reads.
            const secret: LoginSecretKind | undefined =
              codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill" &&
              attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler !== undefined
                ? "otp"
                : loginSecretKind(
                    authorized.connection,
                    run.metadata.account.itemId,
                    reference.fieldId,
                  );
            values.push({ slot: field.slot, value, ...(secret ? { secret } : {}) });
          }
          // A step that fills a secret but no username, such as a password page for a
          // remembered account, must not show another account (owner decision,
          // 2026-10-11). Without a readable username the page is not compared.
          const usernameField = loginUsernameFieldId(
            authorized.connection,
            run.metadata.account.itemId,
          );
          if (
            usernameField &&
            values.some((entry) => entry.secret) &&
            !operation.step.fields.some((field) =>
              authorized.binding.slots.some(
                (entry) =>
                  entry.slot === field.slot &&
                  loginFillsUsername(
                    authorized.connection,
                    run.metadata.account.itemId,
                    entry.fieldId,
                  ),
              ),
            )
          ) {
            let username: string | undefined;
            try {
              username = await fields({
                account: run.metadata.account,
                connection: authorized.connection,
                fieldId: usernameField,
              });
            } catch {
              username = undefined;
            }
            if (!runtime.current(run)) return;
            if (username) expected = { username };
          }
        }
        // A chooser login's click on its list goes where the list's choice for its account
        // is now (ADR 0028), read just before the click as a fill's values are.
        if (
          operation.step.kind === "click" &&
          operation.stepIndex === 0 &&
          run.chooser &&
          run.metadata.chooser
        ) {
          const snapshot = await settings.handle({ version: 1, type: "settings.get" });
          if (!runtime.current(run)) return;
          if (!snapshot.ok) {
            await runtime.change(run, { type: "POLICY_CHANGED" }, { cause: "field-unavailable" });
            return;
          }
          const usernames = await runtime.listUsernames(snapshot, run.live, run.metadata.account);
          if (!runtime.current(run)) return;
          if (!usernames) {
            await runtime.change(run, { type: "POLICY_CHANGED" }, { cause: "field-unavailable" });
            return;
          }
          list = {
            ...usernames,
            ...runtime.listButtons(run.chooser),
            click: run.metadata.chooser.click,
          };
        }
        if (operation.step.kind === "fill" || operation.step.kind === "click")
          await runtime.pause("before-delivery");
        if (!runtime.current(run)) return;
        const latest = await runtime.allowed(run);
        if (!latest) return;
        // Values belong to the snapshot that authorized them; a replacement withdraws them.
        if (latest.connection.snapshotId !== authorized.connection.snapshotId) {
          await runtime.change(run, { type: "POLICY_CHANGED" }, { cause: "vault-replaced" });
          return;
        }
        const after = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex + 1]?.step;
        const codeSubmit =
          codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill" &&
          after?.kind === "click"
            ? after.target
            : undefined;
        run.delivered = true;
        const { tabId } = run.live.document;
        if (
          values.some((entry) => entry.secret === "password") &&
          passwordFills.get(tabId)?.attemptId !== run.metadata.id
        )
          passwordFills.set(tabId, { attemptId: run.metadata.id, submitted: false });
        if (
          operation.step.kind === "click" ||
          (operation.step.kind === "fill" && operation.step.effect !== "prepare")
        ) {
          const handler = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler;
          const at = Date.now();
          effects.set(tabId, {
            attemptId: run.metadata.id,
            at,
            document: run.live.document,
            submits: loginStepEffect(operation.step) === "submit",
            passkey:
              run.metadata.route === "passkey" ||
              (handler !== undefined && run.recipe.handlers?.[handler]?.kind === "passkey"),
            ...(codeStep(run.recipe, run.metadata, operation.stepIndex) ? { code: at } : {}),
          });
          // A passkey handler's click asks for the passkey; it does not submit the password.
          const fill = passwordFills.get(tabId);
          if (
            fill?.attemptId === run.metadata.id &&
            loginStepEffect(operation.step) === "submit" &&
            !effects.get(tabId)?.passkey
          )
            fill.submitted = true;
        } else if (codeSubmit) {
          // The page may submit the code by itself once it is in (ADR 0027), and leave
          // before it answers, so the code counts from its delivery; the page the tab moves
          // to must still show the sign-in (ADR 0022).
          const effect = effects.get(tabId);
          if (effect?.attemptId === run.metadata.id) effect.code = Date.now();
        }
        if (operation.step.kind === "fill" && signInUrls.get(tabId)?.attemptId !== run.metadata.id)
          signInUrls.set(tabId, { attemptId: run.metadata.id, url: run.live.url });
        response = await send(run.live, {
          type: "login.execute",
          operation,
          values,
          ...(expected ? { account: expected } : {}),
          ...(list ? { list } : {}),
          // One switch per tab: an attempt that follows a switch never clicks another.
          // A fill-only login after a logout never clicks, not even a switch (ADR 0021 D).
          ...(expected &&
          run.recipe.accountSwitch &&
          !run.metadata.accountSwitched &&
          !run.metadata.fillOnly
            ? { accountSwitch: run.recipe.accountSwitch }
            : {}),
          // A `totp` handler's code fill watches for the page submitting the code itself.
          ...(codeSubmit ? { code: { submit: codeSubmit } } : {}),
          // An advance whose next step is on its path has the document measure that step
          // just before its effect, in the same task (ADR 0013).
          ...(inPlace ? { next: inPlace } : {}),
        });
      } finally {
        for (const entry of values) entry.value = "";
        if (expected) expected.username = "";
        if (list) {
          list.username = "";
          list.others.fill("");
        }
      }
      if (!runtime.current(run)) return;
      if (operation.step.kind === "fill" || operation.step.kind === "click")
        await runtime.pause("before-ack");
      if (!runtime.current(run)) return;
      delete run.operation;
      const result = v.safeParse(executionResultSchema, response);
      const matchedResult =
        result.success &&
        result.output.operationId === operation.operationId &&
        result.output.documentId === run.live.document.documentId;
      // A click left to the person under a CAPTCHA is then observed as Pateat's own click.
      const leftToPerson =
        matchedResult &&
        !result.output.ok &&
        result.output.reason === "captcha" &&
        operation.step.kind === "click";
      // Without the measurement the advance can only be confirmed on another path.
      if (
        matchedResult &&
        (result.output.ok || leftToPerson) &&
        inPlace &&
        result.output.before?.length === inPlace.targets.length
      )
        run.inPlace = { operationId: operation.operationId, before: result.output.before };
      if (
        matchedResult &&
        !result.output.ok &&
        result.output.reason === "wrong-account" &&
        result.output.mutation === "none"
      ) {
        const switched =
          result.output.switchable === true &&
          run.recipe.accountSwitch !== undefined &&
          !run.metadata.accountSwitched &&
          !run.metadata.fillOnly;
        await runtime.change(run, {
          type: "WRONG_ACCOUNT",
          operationId: operation.operationId,
          document: run.live.document,
          ...(switched ? { switched: true } : {}),
        });
        // The page shows another account: a fill-only login ends and asks.
        if (run.metadata.fillOnly) {
          await runtime.endFillOnly(run);
          return;
        }
        // The switch is recorded before the click, so the page it leads to starts a new
        // attempt instead of resuming this one (owner decision, 2026-10-11).
        if (run.metadata.outcome === "account-switched") {
          const clicked =
            runtime.current(run) &&
            v.safeParse(
              v.object({ ok: v.literal(true) }),
              await send(run.live, {
                type: "login.switch",
                operationId: operation.operationId,
              }).catch(() => undefined),
            ).success;
          // Without the click the attempt ends as `wrong-account` and keeps its tab.
          if (!clicked) await runtime.withdrawSwitch(run);
        }
        return;
      }
      // The page would not accept the values; the same values would fail again.
      if (
        matchedResult &&
        !result.output.ok &&
        operation.step.kind === "fill" &&
        ((result.output.reason === "value-mismatch" && result.output.mutation === "none") ||
          (result.output.reason === "fill-rejected" && operation.step.effect === "prepare"))
      ) {
        await runtime.change(run, {
          type: "VALUE_REJECTED",
          operationId: operation.operationId,
          document: run.live.document,
          stage: result.output.reason === "value-mismatch" ? "before-fill" : "after-fill",
        });
        return;
      }
      // The code page showed that it submits the code by itself, or replaced its form
      // once the code was in.
      if (
        matchedResult &&
        !result.output.ok &&
        (result.output.reason === "submitted" || result.output.reason === "structural-mismatch") &&
        result.output.mutation === "possible" &&
        codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill" &&
        (await runtime.codeSubmitted(run))
      )
        continue;
      if (leftToPerson) {
        await runtime.change(
          run,
          { type: "SUBMITTED", operationId: operation.operationId },
          undefined,
          "captcha-shown",
        );
        // Its button is held until the person presses it or the hold ends (ADR 0029, S4),
        // and a rejection the page already showed is not taken as the person's.
        run.heldClick = operation.stepIndex;
        run.staleRejection = true;
        await reconcileBounded(run);
        if (run.metadata.state !== "ready") return;
        continue;
      }
      if (!matchedResult || !result.output.ok) {
        await runtime.change(
          run,
          matchedResult && result.output.reason === "cancelled"
            ? { type: "CANCEL" }
            : {
                type: "FAILED",
                reason:
                  matchedResult && result.output.reason === "timeout"
                    ? "timeout"
                    : "structural-mismatch",
                mutation: matchedResult ? result.output.mutation : "possible",
                operationId: operation.operationId,
                document: run.live.document,
              },
          undefined,
          !matchedResult
            ? "no-answer"
            : result.output.reason === "submitted"
              ? "page-submitted"
              : result.output.detail,
        );
        return;
      }
      if (
        operation.step.kind !== "click" &&
        !(operation.step.kind === "fill" && operation.step.effect !== "prepare")
      ) {
        await runtime.change(run, { type: "OPERATION_OK", operationId: operation.operationId });
        continue;
      }
      await runtime.change(run, { type: "SUBMITTED", operationId: operation.operationId });
      // A handler's click and the passkey route's click are held (ADR 0027).
      const done = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex];
      if (done && (done.handler !== undefined || run.metadata.route === "passkey"))
        run.heldClick = operation.stepIndex;
      // DOM navigation can replace this document. A same-page result is observed with a finite budget.
      await reconcileBounded(run);
      if (run.metadata.state !== "ready") return;
    }
  }
  return { reconcileBounded, drive };
}
