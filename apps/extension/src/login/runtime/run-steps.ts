import * as v from "valibot";
import {
  attemptPlan,
  fillOnlyStops,
  nextLoginOperation,
  loginStepEffect,
  parseAttemptMetadata,
  passkeyAnswersRequest,
  recoverLoginAttempt,
  awaitPerson,
  TOTP_HANDLER_SLOT,
  detailSlot,
  isDetailSlot,
  type DatePart,
  validateLoginOperation,
} from "@pateat/contracts";
import {
  executionResultSchema,
  loginReadiness,
  type LoginSecretKind,
  type AskedQuestion,
} from "../wire";
import { loginFillsUsername, loginSecretKind, loginUsernameFieldId } from "../vault";
import { newId } from "@pateat/contracts/ids";
import { type Execution } from "./types";
import {
  current,
  change,
  reportAttempt,
  report,
  unsubmitted,
  save,
  publish,
  endFillOnly,
  send,
  withdrawSwitch,
} from "./attempt";
import { codeStep, pathNow, selfSubmitStep, inPlaceNext } from "./steps";
import { terminal, routedHere, settledHere, atStop } from "./attempt-state";
import { DocumentGone } from "./document-gone";
import { watchPage, reconcileBounded } from "./sign-in";
import { switchToPasskey, answerRequest } from "./passkey";
import { stopBeforePassword } from "./stop";
import { allowed } from "./plan-2";
import { submittedByPage, codeSubmitted } from "./handlers";
import { listOf, listReadiness, listUsernames, listButtons } from "./markers";
import { waitFor } from "./reconcile";
import { switchLayout, siblingsAt } from "./continuation";
import { detailFill, reportDetail } from "./detail-fill";
import { pause } from "./session-store";
import type { Runtime } from "./state";

/* eslint-disable no-await-in-loop */
export async function drive(rt: Runtime, run: Execution): Promise<void> {
  if (run.running) return;
  run.running = true;
  try {
    // A failure that changed nothing on the page is tried again from the same step, up
    // to the attempt's retry budget; a spent budget ends it `retry-limit` (owner
    // decision, 2026-10-12). A TOTP code's click after the code is in is never retried:
    // a late click could submit an expired code (ADR 0027).
    for (;;) {
      await runSteps(rt, run);
      if (!current(rt, run) || run.metadata.state !== "retryable") return;
      const final = codeStep(run.recipe, run.metadata, run.metadata.stepIndex) === "click";
      await change(rt, run, final ? { type: "RETRY", final: true } : { type: "RETRY" });
    }
  } catch (error) {
    if (current(rt, run) && !terminal(run.metadata)) {
      run.metadata = recoverLoginAttempt(run.metadata);
      // A submit that replaced the document is how most logins go on: the next document
      // resumes the attempt, so this is no exception (2026-10-12 logs).
      if (error instanceof DocumentGone)
        reportAttempt(rt, run.metadata, run.recipe, undefined, {
          stop: "document-gone",
          // A fill-only login keeps `fill-only` as its reason.
          ...(run.metadata.fillOnly ? {} : { reason: error.reason }),
        });
      else
        report(rt, run.metadata.document, {
          type: "exception",
          tabId: run.metadata.document.tabId,
          origin: run.metadata.document.origin,
          recipeId: run.metadata.recipeId,
          recipeRevision: run.metadata.recipeRevision,
          route: run.metadata.route,
          state: run.metadata.state,
          stepIndex: run.metadata.stepIndex,
          ...(unsubmitted(rt, run.metadata) ? { unsubmitted: true as const } : {}),
          ...(run.metadata.fillOnly ? { fillOnly: true as const } : {}),
          name: error instanceof Error ? error.name : typeof error,
          ...(error instanceof Error ? { message: error.message } : {}),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        });
      await save(rt, run).catch(() => undefined);
      await publish(rt, run.live, run.metadata);
    }
  } finally {
    run.running = false;
    // A route the document took while the login was read is read once it is watched.
    if (current(rt, run) && routedHere(run)) void drive(rt, run);
  }
}

/** Runs the attempt's steps until it leaves `ready`; `drive` owns errors and retries. */
export async function runSteps(rt: Runtime, run: Execution): Promise<void> {
  // A route the watch's own document took since, as a single-page site's after its
  // sign-in, is read once as the tab's next page, recorded first so a restarted worker
  // does not read it again (ADR 0027 amendment of 2026-10-25).
  const routed = routedHere(run);
  if (routed) {
    run.metadata = parseAttemptMetadata({
      ...run.metadata,
      watch: { ...run.metadata.watch, path: pathNow(run.live) },
    });
    await save(rt, run);
  }
  if (run.metadata.state === "watching") {
    await watchPage(rt, run, routed);
    return;
  }
  // A result that settled as unknown is watched from the next page on: the document the
  // watch began in is not read again, as when a restarted worker resumes the login there
  // (ADR 0027), unless it took another route since.
  if (settledHere(run) && !routed) return;
  if (run.metadata.state === "reconciling" || run.metadata.state === "awaiting-result")
    await reconcileBounded(rt, run);
  while (current(rt, run) && run.metadata.state === "ready") {
    // The page's own passkey request decides the route before anything is submitted,
    // and that route answers it instead of taking a step on the page (ADR 0034).
    if (await switchToPasskey(rt, run)) continue;
    if (
      run.metadata.route === "passkey" &&
      run.metadata.stepIndex === 0 &&
      passkeyAnswersRequest(run.recipe)
    ) {
      await answerRequest(rt, run);
      // A step that was not authorized or not prepared leaves the login where it was, as
      // a refused step does below; it is driven again from the page.
      if (
        current(rt, run) &&
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
      await stopBeforePassword(rt, run);
      if (current(rt, run) && run.metadata.state === "ready" && atStop(run.metadata)) return;
      continue;
    }
    if (!(await allowed(rt, run))) return;
    // A fill or click waits for its elements before any intent, vault read or value
    // delivery; a slow render is not a failure until the owner-approved limit passes.
    const upcoming = attemptPlan(run.recipe, run.metadata)?.[run.metadata.stepIndex]?.step;
    // A fill-only login stops before anything that may advance or submit, and before a
    // fill on a software keyboard, whose presses the page may act on (ADR 0021 D, 0067).
    if (run.metadata.fillOnly && (!upcoming || fillOnlyStops(upcoming))) {
      await endFillOnly(rt, run);
      return;
    }
    if (upcoming?.kind === "fill" || upcoming?.kind === "click") {
      // A code input may submit by itself once the code is in, as one that submits on
      // its last digit does, and so may a software keyboard; its click then has nothing
      // left to do (ADR 0027, ADR 0067).
      const afterCode =
        upcoming.kind === "click" &&
        selfSubmitStep(run.recipe, run.metadata, run.metadata.stepIndex) === "click";
      if (afterCode && (await submittedByPage(rt, run, upcoming))) {
        if (!current(rt, run) || run.metadata.state !== "ready") return;
        if (await codeSubmitted(rt, run)) continue;
        await change(
          rt,
          run,
          { type: "FAILED", reason: "structural-mismatch" },
          undefined,
          "code-not-submitted",
        );
        return;
      }
      if (!current(rt, run) || run.metadata.state !== "ready") return;
      // A chooser login's click on its list waits for the list (ADR 0028).
      const onList = run.metadata.stepIndex === 0 ? listOf(rt, run) : undefined;
      const waited = await waitFor(
        rt,
        run,
        onList ? listReadiness(rt, onList.chooser) : loginReadiness(upcoming),
      );
      if (!current(rt, run) || run.metadata.state !== "ready") return;
      if (waited === "timeout") {
        if (
          afterCode &&
          (await submittedByPage(rt, run, upcoming)) &&
          current(rt, run) &&
          run.metadata.state === "ready" &&
          (await codeSubmitted(rt, run))
        )
          continue;
        if (!current(rt, run) || run.metadata.state !== "ready") return;
        // Another layout's step may show where the layouts part (ADR 0060).
        if (await switchLayout(rt, run)) continue;
        if (!current(rt, run) || run.metadata.state !== "ready") return;
        await change(
          rt,
          run,
          { type: "FAILED", reason: "structural-mismatch" },
          undefined,
          "elements-timeout",
        );
        return;
      }
      if (waited !== "ready" || !(await allowed(rt, run))) return;
      // A request the page made while the step waited still decides the route before the
      // first submission, as a chooser login's click on its list is (ADR 0034).
      if (await switchToPasskey(rt, run)) continue;
    }
    const operation = nextLoginOperation(run.metadata, run.recipe, run.live.document, newId());
    if (!operation) {
      await change(
        rt,
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
    // So is a switch to another layout whose next step is on its path (ADR 0060).
    const siblingsNext =
      loginStepEffect(operation.step) === "advance"
        ? (await siblingsAt(rt, run, operation.stepIndex + 1))
            .flatMap((sibling) => {
              const next = inPlaceNext(sibling, run.metadata, operation.stepIndex);
              return next ? [{ layout: sibling.layout!, next }] : [];
            })
            .slice(0, 2)
        : [];
    if (!current(rt, run) || run.metadata.state !== "ready") return;
    delete run.inPlace;
    delete run.siblingsInPlace;
    // Known before its intent is recorded, so a stop in between takes the intent back.
    run.operation = operation;
    run.delivered = false;
    await change(rt, run, {
      type: "PREPARE",
      operationId: operation.operationId,
      kind: operation.step.kind,
      effect: loginStepEffect(operation.step),
    });
    if (operation.step.kind === "click")
      await change(rt, run, { type: "SUBMIT_INTENT", operationId: operation.operationId });
    else if (operation.step.kind === "fill")
      await change(rt, run, { type: "MUTATION_INTENT", operationId: operation.operationId });
    const authorized = await allowed(rt, run);
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
      await change(
        rt,
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
    const values: {
      slot: string;
      value: string;
      secret?: LoginSecretKind;
      question?: AskedQuestion;
      group?: number;
      part?: DatePart;
      shortYear?: true;
    }[] = [];
    let expected: { username: string } | undefined;
    let list: ({ username: string; others: string[] } & Record<string, unknown>) | undefined;
    let response: unknown;
    try {
      if (operation.step.kind === "fill") {
        for (const field of operation.step.fields) {
          // A `detail` handler's input reads the vault field linked to the login item,
          // not one of its own slots (ADR 0061).
          const own = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler;
          if (
            isDetailSlot(field.slot) &&
            own !== undefined &&
            run.recipe.handlers?.[own]?.kind === "detail"
          ) {
            // Every part of a split value is made at once, after one read (ADR 0061).
            if (values.some((entry) => isDetailSlot(entry.slot))) continue;
            const made = await detailFill(rt, run, authorized, operation.stepIndex);
            if (!current(rt, run)) return;
            const handler = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler;
            // A card number or PIN whose digits its groups cannot take is left to the
            // person, as a split value no input takes is (ADR 0061).
            if (made === "unfit") {
              if (handler !== undefined)
                reportDetail(rt, run.live.document, run.recipe, handler, "detail-unfit");
              await change(rt, run, {
                type: "VALUE_REJECTED",
                operationId: operation.operationId,
                document: run.live.document,
                stage: "before-fill",
                challenge: true,
              });
              return;
            }
            if (typeof made === "string") {
              if (handler !== undefined)
                reportDetail(rt, run.live.document, run.recipe, handler, `detail-${made}`);
              await change(
                rt,
                run,
                { type: "POLICY_CHANGED" },
                { cause: "field-unavailable", reason: `detail-${made}` },
              );
              return;
            }
            const slots = operation.step.fields.filter((entry) => isDetailSlot(entry.slot));
            if (made.length !== slots.length) {
              for (const entry of made) entry.value = "";
              await change(
                rt,
                run,
                { type: "FAILED", reason: "structural-mismatch" },
                undefined,
                "unexpected-values",
              );
              return;
            }
            for (const [at, entry] of made.entries())
              values.push({ slot: detailSlot(at), ...entry });
            continue;
          }
          const reference = authorized.binding.slots.find((entry) => entry.slot === field.slot);
          if (!reference) {
            await change(
              rt,
              run,
              { type: "FAILED", reason: "structural-mismatch" },
              undefined,
              "slot-unbound",
            );
            return;
          }
          // Vault reads are serial so a denial stops before any later field is released.
          // The `totp` slot always fills a code made from its field, never the raw value.
          const code = field.slot === TOTP_HANDLER_SLOT;
          let value: string | undefined;
          try {
            value = await rt.fields({
              account: run.metadata.account,
              connection: authorized.connection,
              fieldId: reference.fieldId,
              ...(code ? { code: true as const } : {}),
            });
          } catch {
            // A failed read is not a page mutation; never reclassify it as uncertain.
            value = undefined;
          }
          if (!current(rt, run)) return;
          // Locked, resynchronized or newly denied vault access withdraws this grant.
          if (value === undefined) {
            await change(rt, run, { type: "POLICY_CHANGED" }, { cause: "field-unavailable" });
            return;
          }
          // A code, as any `totp` handler's fill, fills only a code input.
          const secret: LoginSecretKind | undefined =
            code ||
            (codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill" &&
              attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler !== undefined)
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
            username = await rt.fields({
              account: run.metadata.account,
              connection: authorized.connection,
              fieldId: usernameField,
            });
          } catch {
            username = undefined;
          }
          if (!current(rt, run)) return;
          if (username) expected = { username };
        }
      }
      // A chooser login's click on its list goes where the list's choice for its account
      // is now (ADR 0028), read just before the click as a fill's values are.
      const onList = operation.stepIndex === 0 ? listOf(rt, run) : undefined;
      if (operation.step.kind === "click" && onList) {
        const snapshot = await rt.settings.handle({ version: 1, type: "settings.get" });
        if (!current(rt, run)) return;
        if (!snapshot.ok) {
          await change(rt, run, { type: "POLICY_CHANGED" }, { cause: "field-unavailable" });
          return;
        }
        const usernames = await listUsernames(rt, snapshot, run.live, run.metadata.account);
        if (!current(rt, run)) return;
        if (!usernames) {
          await change(rt, run, { type: "POLICY_CHANGED" }, { cause: "field-unavailable" });
          return;
        }
        list = { ...usernames, ...listButtons(rt, onList.chooser), click: onList.click };
      }
      if (operation.step.kind === "fill" || operation.step.kind === "click")
        await pause(rt, "before-delivery");
      if (!current(rt, run)) return;
      const latest = await allowed(rt, run);
      if (!latest) return;
      // Values belong to the snapshot that authorized them; a replacement withdraws them.
      if (latest.connection.snapshotId !== authorized.connection.snapshotId) {
        await change(rt, run, { type: "POLICY_CHANGED" }, { cause: "vault-replaced" });
        return;
      }
      const after = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex + 1]?.step;
      const codeSubmit =
        codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill" &&
        codeStep(run.recipe, run.metadata, operation.stepIndex + 1) === "click" &&
        after?.kind === "click"
          ? after.target
          : undefined;
      const ownHandler = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler;
      // A `password` handler's button is pressed only while its rendered text, read in the
      // same task as the press, still names the password choice (ADR 0048).
      const passwordChoice =
        operation.step.kind === "click" &&
        ownHandler !== undefined &&
        run.recipe.handlers?.[ownHandler]?.kind === "password";
      // So is an `authenticator` handler's, while its text names an authenticator app's code
      // (ADR 0081).
      const authenticatorChoice =
        operation.step.kind === "click" &&
        ownHandler !== undefined &&
        run.recipe.handlers?.[ownHandler]?.kind === "authenticator";
      run.delivered = true;
      const { tabId } = run.live.document;
      if (
        values.some((entry) => entry.secret === "password") &&
        rt.passwordFills.get(tabId)?.attemptId !== run.metadata.id
      )
        rt.passwordFills.set(tabId, { attemptId: run.metadata.id, submitted: false });
      if (
        operation.step.kind === "click" ||
        (operation.step.kind === "fill" && operation.step.effect !== "prepare")
      ) {
        const at = Date.now();
        const request =
          (run.metadata.route === "passkey" && ownHandler === undefined) ||
          (ownHandler !== undefined && run.recipe.handlers?.[ownHandler]?.kind === "passkey");
        const before = rt.effects.get(tabId);
        const requestAt = request
          ? at
          : before?.attemptId === run.metadata.id
            ? before.requestAt
            : undefined;
        rt.effects.set(tabId, {
          attemptId: run.metadata.id,
          at,
          document: run.live.document,
          submits: loginStepEffect(operation.step) === "submit",
          passkey:
            run.metadata.route === "passkey" ||
            (ownHandler !== undefined && run.recipe.handlers?.[ownHandler]?.kind === "passkey"),
          request,
          ...(requestAt === undefined ? {} : { requestAt }),
          ...(codeStep(run.recipe, run.metadata, operation.stepIndex) ? { code: at } : {}),
        });
        // A passkey handler's click asks for the passkey; it does not submit the password.
        const fill = rt.passwordFills.get(tabId);
        if (
          fill?.attemptId === run.metadata.id &&
          loginStepEffect(operation.step) === "submit" &&
          !rt.effects.get(tabId)?.passkey
        )
          fill.submitted = true;
      } else if (codeSubmit) {
        // The page may submit the code by itself once it is in (ADR 0027), and leave
        // before it answers, so the code counts from its delivery; the page the tab moves
        // to must still show the sign-in (ADR 0022).
        const effect = rt.effects.get(tabId);
        if (effect?.attemptId === run.metadata.id) effect.code = Date.now();
      }
      if (operation.step.kind === "fill" && rt.signInUrls.get(tabId)?.attemptId !== run.metadata.id)
        rt.signInUrls.set(tabId, { attemptId: run.metadata.id, url: run.live.url });
      response = await send(rt, run.live, {
        type: "login.execute",
        operation,
        values,
        ...(expected ? { account: expected } : {}),
        ...(list ? { list } : {}),
        // One switch per tab: an attempt that follows a switch never clicks another.
        // A fill-only login never clicks, not even a switch (ADR 0021 D).
        ...(expected && !run.metadata.accountSwitched && !run.metadata.fillOnly
          ? run.recipe.accountSwitch
            ? { accountSwitch: run.recipe.accountSwitch }
            : { otherSwitch: true as const }
          : {}),
        // A `totp` handler's code fill watches for the page submitting the code itself; a
        // handler's without a button types the code as its submission (ADR 0027).
        ...(codeSubmit
          ? { code: { submit: codeSubmit } }
          : operation.step.kind === "fill" &&
              operation.step.effect === "submit" &&
              codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill"
            ? { code: {} }
            : {}),
        ...(passwordChoice ? { passwordChoice: true as const } : {}),
        ...(authenticatorChoice ? { authenticatorChoice: true as const } : {}),
        // A `detail` handler's input is filled after its choosing radio (ADR 0061).
        ...(operation.step.kind === "fill" &&
        operation.step.fields.some((field) => isDetailSlot(field.slot))
          ? { choose: true as const }
          : {}),
        // An advance whose next step is on its path has the document measure that step
        // just before its effect, in the same task (ADR 0013).
        ...(inPlace ? { next: inPlace } : {}),
        ...(siblingsNext.length ? { siblings: siblingsNext.map(({ next }) => next) } : {}),
      });
    } finally {
      for (const entry of values) entry.value = "";
      if (expected) expected.username = "";
      if (list) {
        list.username = "";
        list.others.fill("");
      }
    }
    if (!current(rt, run)) return;
    if (operation.step.kind === "fill" || operation.step.kind === "click")
      await pause(rt, "before-ack");
    if (!current(rt, run)) return;
    delete run.operation;
    const result = v.safeParse(executionResultSchema, response);
    const matchedResult =
      result.success &&
      result.output.operationId === operation.operationId &&
      result.output.documentId === run.live.document.documentId;
    // A keypad fill's key press counts toward the page's own submission while the fill
    // runs, and once it went in until its click is prepared; an answered stop ends it, as
    // does the next operation's answer (ADR 0067). A fill left unanswered, as by a page
    // that went away during it, keeps it for the page that follows.
    const press = rt.keypadPresses.get(run.metadata.id);
    if (press?.operationId === operation.operationId && matchedResult && result.output.ok)
      press.filled = true;
    else if (press && (press.operationId !== operation.operationId || matchedResult))
      rt.keypadPresses.delete(run.metadata.id);
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
    if (matchedResult && (result.output.ok || leftToPerson)) {
      const siblings = siblingsNext.flatMap(({ layout, next }, index) => {
        const before = result.output.siblingsBefore?.[index];
        return before?.length === next.targets.length ? [{ layout, before }] : [];
      });
      if (siblings.length) run.siblingsInPlace = { operationId: operation.operationId, siblings };
    }
    if (
      matchedResult &&
      !result.output.ok &&
      result.output.reason === "wrong-account" &&
      result.output.mutation === "none"
    ) {
      const switched =
        result.output.switchable === true &&
        !run.metadata.accountSwitched &&
        !run.metadata.fillOnly;
      await change(rt, run, {
        type: "WRONG_ACCOUNT",
        operationId: operation.operationId,
        document: run.live.document,
        ...(switched ? { switched: true } : {}),
      });
      // The page shows another account: a fill-only login ends and asks.
      if (run.metadata.fillOnly) {
        await endFillOnly(rt, run);
        return;
      }
      // The switch is recorded before the click, so the page it leads to starts a new
      // attempt instead of resuming this one (owner decision, 2026-10-11).
      if (run.metadata.outcome === "account-switched") {
        const clicked =
          current(rt, run) &&
          v.safeParse(
            v.object({ ok: v.literal(true) }),
            await send(rt, run.live, {
              type: "login.switch",
              operationId: operation.operationId,
            }).catch(() => undefined),
          ).success;
        // Without the click the attempt ends as `wrong-account` and keeps its tab.
        if (!clicked) await withdrawSwitch(rt, run);
      }
      return;
    }
    // The page would not accept the values; the same values would fail again. A code
    // typed as its own submission whose character the page kept out never went in whole.
    const codeRefused =
      operation.step.kind === "fill" &&
      operation.step.effect === "submit" &&
      codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill";
    if (
      matchedResult &&
      !result.output.ok &&
      operation.step.kind === "fill" &&
      ((result.output.reason === "value-mismatch" && result.output.mutation === "none") ||
        (result.output.reason === "fill-rejected" &&
          (operation.step.effect === "prepare" || codeRefused)))
    ) {
      // A `detail` handler's value split over several inputs that fits none of them, as
      // when no option of a select matches its part, fills nothing and leaves the page
      // to the person (ADR 0061).
      const own = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex]?.handler;
      const unfit =
        result.output.reason === "value-mismatch" &&
        own !== undefined &&
        run.recipe.handlers?.[own]?.kind === "detail" &&
        operation.step.fields.filter((field) => isDetailSlot(field.slot)).length > 1;
      if (unfit) reportDetail(rt, run.live.document, run.recipe, own, "detail-unfit");
      // The page's detail goes to the log and the popup, as `keypad-pressed` after a key
      // press on its keypad (ADR 0067).
      await change(
        rt,
        run,
        {
          type: "VALUE_REJECTED",
          operationId: operation.operationId,
          document: run.live.document,
          stage:
            result.output.reason === "value-mismatch"
              ? "before-fill"
              : codeRefused
                ? "code-refused"
                : "after-fill",
          ...(unfit ? { challenge: true as const } : {}),
        },
        undefined,
        result.output.detail,
      );
      return;
    }
    // The code page showed that it submits the code by itself, or replaced its form
    // once the code was in. A code typed as its own submission is settled as one below.
    // A software keyboard's page moved or took its field away once a key was pressed,
    // as a PIN pad that submits at its last digit (ADR 0067); a keypad step's other
    // failures, as a missing key, are no submission.
    if (
      matchedResult &&
      !result.output.ok &&
      result.output.mutation === "possible" &&
      operation.step.kind === "fill" &&
      operation.step.effect === "prepare" &&
      (result.output.reason === "submitted"
        ? selfSubmitStep(run.recipe, run.metadata, operation.stepIndex) === "fill"
        : result.output.reason === "structural-mismatch" &&
          codeStep(run.recipe, run.metadata, operation.stepIndex) === "fill") &&
      (await codeSubmitted(rt, run))
    )
      continue;
    if (leftToPerson) {
      // The person's own click, while the button is held, is their time (ADR 0019).
      run.metadata = awaitPerson(run.metadata);
      await change(
        rt,
        run,
        { type: "SUBMITTED", operationId: operation.operationId },
        undefined,
        "captcha-shown",
      );
      // Its button is held until the person presses it or the hold ends (ADR 0029, S4),
      // and a rejection the page already showed is not taken as the person's.
      run.heldClick = operation.stepIndex;
      run.staleRejection = true;
      await reconcileBounded(rt, run);
      if (run.metadata.state !== "ready") return;
      continue;
    }
    if (!matchedResult || !result.output.ok) {
      await change(
        rt,
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
      await change(rt, run, { type: "OPERATION_OK", operationId: operation.operationId });
      continue;
    }
    await change(rt, run, { type: "SUBMITTED", operationId: operation.operationId });
    // A handler's click and the passkey route's click are held (ADR 0027).
    const done = attemptPlan(run.recipe, run.metadata)?.[operation.stepIndex];
    if (done && (done.handler !== undefined || run.metadata.route === "passkey"))
      run.heldClick = operation.stepIndex;
    // DOM navigation can replace this document. A same-page result is observed with a finite budget.
    await reconcileBounded(rt, run);
    if (run.metadata.state !== "ready") return;
  }
}
/* eslint-enable no-await-in-loop */
